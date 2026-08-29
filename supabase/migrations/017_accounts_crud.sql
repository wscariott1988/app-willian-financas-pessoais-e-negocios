-- ============================================================
-- 017_accounts_crud.sql
-- CRUD seguro de CONTAS na area Configuracoes (CFG-P2C).
--
-- Regra de dominio (mantida de 002/016):
--   a disponibilidade de uma conta por perfil/data e definida por
--   account_profile_periods (account_id, profile_id, starts_on, ends_on):
--     starts_on <= data AND (ends_on IS NULL OR data <= ends_on)
--   ends_on e INCLUSIVO. ends_on NULL = periodo aberto.
--   Sobreposicao de periodos e proibida para o MESMO (account_id, profile_id);
--   periodos simultaneos em perfis DIFERENTES sao permitidos (016).
--
-- Regras do CRUD:
--   * criar conta: entity accounts (catalogo global) + periodo aberto no
--     perfil do JWT (starts_on = data da aplicacao, source='ui');
--   * editar conta: somente display_name (e normalized_name derivado com o
--     mesmo padrao de normalizacao do projeto, app.normalize_description);
--   * ativar em perfil: cria NOVO periodo a partir da data (nunca reabre
--     periodo historico);
--   * desativar no perfil: fecha SOMENTE o periodo aberto atual (ends_on =
--     data); historico preservado; a conta nao e arquivada globalmente;
--   * nunca physical delete; nunca toca transactions/categories.
--
-- Segue o padrao do projeto: app.* = implementacao controlada
-- (SECURITY DEFINER, search_path fixo, perfil sempre do JWT);
-- public.* = wrapper exposto (SECURITY INVOKER).
-- Escrita direta em accounts/account_profile_periods permanece
-- service_role-only via RLS (004) — nada e enfraquecido.
-- ============================================================

BEGIN;

-- ---------- app.account_create ----------
CREATE OR REPLACE FUNCTION app.account_create(
    p_display_name text,
    p_account_type text DEFAULT 'bank',
    p_starts_on    date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_name    text;
    v_norm    text;
    v_acc_id  uuid;
    v_start   date;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da conta obrigatorio';
    END IF;
    IF p_account_type IS NULL OR p_account_type NOT IN
        ('bank','credit_card','cash','benefit','investment','other') THEN
        RAISE EXCEPTION 'tipo de conta invalido';
    END IF;
    v_name  := trim(p_display_name);
    v_norm  := app.normalize_description(v_name);
    v_start := coalesce(p_starts_on, current_date);

    -- catalogo global; UNIQUE (normalized_name) previne duplicata real
    INSERT INTO accounts
        (id, source_name, display_name, normalized_name, account_type,
         is_active, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_name, v_name, v_norm, p_account_type,
         true, now(), now())
    RETURNING id INTO v_acc_id;

    -- periodo inicial no perfil do JWT (aberto; nunca duplicado por construcao)
    INSERT INTO account_profile_periods
        (id, account_id, profile_id, starts_on, ends_on, source, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_acc_id, v_profile, v_start, NULL, 'ui', now(), now());

    RETURN jsonb_build_object(
        'account_id',   v_acc_id,
        'display_name', v_name,
        'profile_id',   v_profile,
        'starts_on',    v_start
    );
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ja existe uma conta com esse nome (normalizado: %)', v_norm
        USING ERRCODE = 'P0001';
END;
$$;

-- ---------- app.account_update ----------
CREATE OR REPLACE FUNCTION app.account_update(
    p_account_id   uuid,
    p_display_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_name    text;
    v_norm    text;
    v_has     boolean;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da conta obrigatorio';
    END IF;

    -- regra de acesso: a conta precisa estar associada ao perfil do token
    SELECT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id
           AND pp.profile_id = v_profile
    ) INTO v_has;
    IF NOT v_has THEN
        RAISE EXCEPTION 'conta nao esta disponivel no perfil';
    END IF;

    v_name := trim(p_display_name);
    v_norm := app.normalize_description(v_name);

    UPDATE accounts
       SET display_name    = v_name,
           normalized_name = v_norm,
           updated_at      = now()
     WHERE id = p_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'conta nao encontrada';
    END IF;

    RETURN jsonb_build_object(
        'account_id',   p_account_id,
        'display_name', v_name
    );
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ja existe uma conta com esse nome (normalizado: %)', v_norm
        USING ERRCODE = 'P0001';
END;
$$;

-- ---------- app.account_set_profile_active ----------
-- p_active = true  : cria NOVO periodo a partir de p_date (nunca reabre
--                    periodo historico; p_date precisa ser > ends_on do
--                    periodo anterior — mesma convencao inclusiva).
-- p_active = false : fecha o periodo ABERTO atual em p_date (inclusiva).
CREATE OR REPLACE FUNCTION app.account_set_profile_active(
    p_account_id uuid,
    p_active     boolean,
    p_date       date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile  uuid;
    v_act      date;
    v_open     boolean;
    v_max_end  date;
    v_period_id uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_account_id IS NULL THEN
        RAISE EXCEPTION 'conta obrigatoria';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id) THEN
        RAISE EXCEPTION 'conta nao encontrada';
    END IF;
    v_act := coalesce(p_date, current_date);

    SELECT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id
           AND pp.profile_id = v_profile
           AND pp.ends_on IS NULL
    ) INTO v_open;

    IF p_active THEN
        IF v_open THEN
            RAISE EXCEPTION 'conta ja esta ativa no perfil';
        END IF;
        SELECT max(pp.ends_on) INTO v_max_end
          FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id
           AND pp.profile_id = v_profile;
        IF v_max_end IS NOT NULL AND v_act <= v_max_end THEN
            RAISE EXCEPTION 'data de ativacao sobrepoe periodo historico (reative a partir de %)', v_max_end + 1
                USING ERRCODE = 'P0001';
        END IF;
        INSERT INTO account_profile_periods
            (id, account_id, profile_id, starts_on, ends_on, source, created_at, updated_at)
        VALUES
            (gen_random_uuid(), p_account_id, v_profile, v_act, NULL, 'ui', now(), now())
        RETURNING id INTO v_period_id;
        RETURN jsonb_build_object(
            'account_id', p_account_id, 'active', true,
            'starts_on', v_act, 'period_id', v_period_id
        );
    ELSE
        IF NOT v_open THEN
            RAISE EXCEPTION 'conta ja esta inativa no perfil';
        END IF;
        IF EXISTS (
            SELECT 1 FROM account_profile_periods pp
             WHERE pp.account_id = p_account_id
               AND pp.profile_id = v_profile
               AND pp.ends_on IS NULL
               AND pp.starts_on > v_act
        ) THEN
            RAISE EXCEPTION 'data de desativacao anterior ao inicio do periodo'
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE account_profile_periods
           SET ends_on    = v_act,
               updated_at = now()
         WHERE account_id = p_account_id
           AND profile_id = v_profile
           AND ends_on IS NULL
         RETURNING id INTO v_period_id;
        RETURN jsonb_build_object(
            'account_id', p_account_id, 'active', false,
            'ends_on', v_act, 'period_id', v_period_id
        );
    END IF;
END;
$$;

-- ---------- wrappers public.* (mesmos nomes de parametro p/ rpc por nome) ----------
CREATE OR REPLACE FUNCTION public.account_create(
    p_display_name text,
    p_account_type text DEFAULT 'bank',
    p_starts_on    date DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.account_create(p_display_name, p_account_type, p_starts_on);
$$;

CREATE OR REPLACE FUNCTION public.account_update(
    p_account_id   uuid,
    p_display_name text
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.account_update(p_account_id, p_display_name);
$$;

CREATE OR REPLACE FUNCTION public.account_set_profile_active(
    p_account_id uuid,
    p_active     boolean,
    p_date       date DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public, app
AS $$
    SELECT app.account_set_profile_active(p_account_id, p_active, p_date);
$$;

-- ---------- grants (somente authenticated; helpers internos sem grant) ----------
GRANT EXECUTE ON FUNCTION app.account_create(text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION app.account_update(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.account_set_profile_active(uuid, boolean, date) TO authenticated;

GRANT EXECUTE ON FUNCTION public.account_create(text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_update(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_set_profile_active(uuid, boolean, date) TO authenticated;

COMMIT;