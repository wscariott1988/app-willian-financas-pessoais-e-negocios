-- ============================================================
-- 020_settings_audit.sql
-- Auditoria atomica de CONTAS e CATEGORIAS (CFG-P4B) — LOCAL, NAO APLICAR.
--
-- Lacunas cobertas (confirmadas no CFG-P4A):
--   * app.account_* (017) e app.category_* (018) nao gravavam auditoria.
-- Esta migration:
--   * cria settings_audit (eventos de conta/categoria; append-only);
--   * RLS: SELECT somente do proprio profile (jwt_profile_id) / service_role;
--     escrita somente service_role; authenticated NAO recebe INSERT/UPDATE/DELETE;
--   * helper interno app.settings_audit_write (SECURITY DEFINER) SEM grant
--     para PUBLIC/authenticated (hardening na propria migration — licao 019);
--   * reescreve os RPCs 017/018 (CREATE OR REPLACE, mesmas assinaturas) para
--     gravar o evento NA MESMA TRANSACAO da acao (falha de um aborta ambos).
-- Sem data migration: ZERO eventos retroativos; nenhuma linha de negocio tocada.
-- Sem secrets em before/after_state (apenas display_name/parent/status/direction).
--
-- SEMANTICA DE ACOES (entity_type: account | category):
--   account/create      : conta criada + periodo inicial aberto no perfil do JWT.
--   account/rename      : display_name alterado (global; evento no perfil da acao).
--   account/link        : PRIMEIRO vinculo de conta GLOBAL pre-existente com o
--                         perfil (nunca teve periodo neste perfil) — ativacao
--                         inicial de conta que nao foi criada neste perfil.
--   account/reactivate  : reativacao apos historico FECHADO neste perfil.
--   account/deactivate  : fechamento do periodo aberto atual neste perfil.
--   NOTA: nao existe action 'activate' separada: o primeiro periodo via
--   account_create e coberto por 'create'; a ativacao de conta pre-existente e
--   'link' (sem historico) ou 'reactivate' (com historico fechado), decidida
--   por account_profile_periods (item 8d do CFG-P4B).
--   category/create     : categoria criada no perfil.
--   category/update     : UM unico evento para rename e/ou move na mesma
--                         chamada (item 10: nunca duplicar em dois eventos);
--                         a UI deriva rename/move comparando before/after
--                         (display_name e parent_id).
--   category/archive    : status active -> archived.
--   category/reactivate : status archived -> active.
-- ============================================================

BEGIN;

-- ---------- 1. Tabela de auditoria de configuracao ----------
CREATE TABLE settings_audit (
    id            uuid PRIMARY KEY,
    profile_id    uuid NOT NULL REFERENCES profiles (id),
    entity_type   text NOT NULL CHECK (entity_type IN ('account', 'category')),
    entity_id     uuid NOT NULL,
    action        text NOT NULL CHECK (action IN ('create', 'rename', 'update', 'link', 'deactivate', 'reactivate', 'archive')),
    before_state  jsonb,
    after_state   jsonb,
    changed_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_settings_audit_profile_created
    ON settings_audit (profile_id, created_at DESC);

-- ---------- 2. RLS + grants (append-only; usuario nao edita/apaga) ----------
ALTER TABLE settings_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY settings_audit_select_own ON settings_audit FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());

CREATE POLICY settings_audit_write_service ON settings_audit FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

GRANT SELECT ON settings_audit TO authenticated;
-- NENHUM grant de INSERT/UPDATE/DELETE para authenticated (apenas SELECT).

-- ---------- 3. Helper interno (sem grant; hardening aqui mesmo) ----------
CREATE OR REPLACE FUNCTION app.settings_audit_write(
    p_profile     uuid,
    p_entity_type text,
    p_entity_id   uuid,
    p_action      text,
    p_before      jsonb,
    p_after       jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
BEGIN
    INSERT INTO settings_audit
        (id, profile_id, entity_type, entity_id, action, before_state, after_state, changed_by, created_at)
    VALUES
        (gen_random_uuid(), p_profile, p_entity_type, p_entity_id, p_action,
         p_before, p_after, app.jwt_profile_id(), now());
END;
$$;

REVOKE ALL ON FUNCTION app.settings_audit_write(uuid, text, uuid, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.settings_audit_write(uuid, text, uuid, text, jsonb, jsonb) FROM authenticated;

-- ---------- 4. app.account_create + auditoria ----------
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

    INSERT INTO accounts
        (id, source_name, display_name, normalized_name, account_type,
         is_active, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_name, v_name, v_norm, p_account_type,
         true, now(), now())
    RETURNING id INTO v_acc_id;

    INSERT INTO account_profile_periods
        (id, account_id, profile_id, starts_on, ends_on, source, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_acc_id, v_profile, v_start, NULL, 'ui', now(), now());

    PERFORM app.settings_audit_write(v_profile, 'account', v_acc_id, 'create', NULL,
        jsonb_build_object('display_name', v_name));

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

-- ---------- 5. app.account_update + auditoria (rename; global, evento no perfil da acao) ----------
CREATE OR REPLACE FUNCTION app.account_update(
    p_account_id   uuid,
    p_display_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile  uuid;
    v_name     text;
    v_norm     text;
    v_has      boolean;
    v_old_name text;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da conta obrigatorio';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id
           AND pp.profile_id = v_profile
    ) INTO v_has;
    IF NOT v_has THEN
        RAISE EXCEPTION 'conta nao esta disponivel no perfil';
    END IF;

    SELECT display_name INTO v_old_name FROM accounts WHERE id = p_account_id;
    IF v_old_name IS NULL THEN
        RAISE EXCEPTION 'conta nao encontrada';
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

    IF v_old_name <> v_name THEN
        PERFORM app.settings_audit_write(v_profile, 'account', p_account_id, 'rename',
            jsonb_build_object('display_name', v_old_name),
            jsonb_build_object('display_name', v_name));
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

-- ---------- 6. app.account_set_profile_active + auditoria (link/reactivate/deactivate) ----------
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
    v_profile     uuid;
    v_act         date;
    v_open        boolean;
    v_max_end     date;
    v_period_id   uuid;
    v_has_history boolean;
    v_acc_name    text;
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

    SELECT display_name INTO v_acc_name FROM accounts WHERE id = p_account_id;

    -- historico do par (account, perfil) decide link vs reactivate
    SELECT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id
           AND pp.profile_id = v_profile
    ) INTO v_has_history;

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
        -- primeiro vinculo = link; historico fechado existente = reactivate
        PERFORM app.settings_audit_write(v_profile, 'account', p_account_id,
            CASE WHEN v_has_history THEN 'reactivate' ELSE 'link' END, NULL,
            jsonb_build_object('display_name', v_acc_name, 'starts_on', v_act));
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
        PERFORM app.settings_audit_write(v_profile, 'account', p_account_id, 'deactivate', NULL,
            jsonb_build_object('display_name', v_acc_name, 'ends_on', v_act));
        RETURN jsonb_build_object(
            'account_id', p_account_id, 'active', false,
            'ends_on', v_act, 'period_id', v_period_id
        );
    END IF;
END;
$$;

-- ---------- 7. app.category_create + auditoria ----------
CREATE OR REPLACE FUNCTION app.category_create(
    p_display_name text,
    p_direction    text,
    p_parent_id    uuid DEFAULT NULL,
    p_source_name  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_name    text;
    v_norm    text;
    v_source  text;
    v_parent_dir text;
    v_cat_id  uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da categoria obrigatorio';
    END IF;
    IF p_direction IS NULL OR p_direction NOT IN ('income','expense') THEN
        RAISE EXCEPTION 'direcao invalida';
    END IF;
    v_name   := trim(p_display_name);
    v_norm   := app.normalize_description(v_name);
    v_source := coalesce(p_source_name, v_name);

    IF p_parent_id IS NOT NULL THEN
        SELECT direction INTO v_parent_dir FROM categories WHERE id = p_parent_id;
        IF v_parent_dir IS NULL THEN
            RAISE EXCEPTION 'categoria pai nao encontrada';
        END IF;
        IF v_parent_dir <> p_direction THEN
            RAISE EXCEPTION 'categoria de % nao pode ficar sob ancestral de %', p_direction, v_parent_dir;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM categories WHERE id = p_parent_id AND profile_id = v_profile) THEN
            RAISE EXCEPTION 'categoria pai pertence a outro perfil';
        END IF;
    END IF;

    INSERT INTO categories
        (id, profile_id, direction, parent_id, source_name, display_name,
         normalized_name, status, canonical_path, created_at, updated_at)
    VALUES
        (gen_random_uuid(), v_profile, p_direction, p_parent_id, v_source, v_name,
         v_norm, 'active', NULL, now(), now())
    RETURNING id INTO v_cat_id;

    PERFORM app.category_refresh_path(v_cat_id);

    PERFORM app.settings_audit_write(v_profile, 'category', v_cat_id, 'create', NULL,
        jsonb_build_object('display_name', v_name, 'direction', p_direction, 'parent_id', p_parent_id));

    RETURN jsonb_build_object(
        'category_id', v_cat_id,
        'display_name', v_name,
        'direction', p_direction,
        'parent_id', p_parent_id,
        'profile_id', v_profile
    );
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ja existe categoria com esse nome neste perfil e nivel (normalizado: %)', v_norm
        USING ERRCODE = 'P0001';
END;
$$;

-- ---------- 8. app.category_update + auditoria (update unico p/ rename e/ou move) ----------
CREATE OR REPLACE FUNCTION app.category_update(
    p_category_id   uuid,
    p_display_name  text,
    p_parent_id     uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile    uuid;
    v_dir        text;
    v_name       text;
    v_norm       text;
    v_ancestor   uuid;
    v_parent_dir text;
    v_old_name   text;
    v_old_parent uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    SELECT profile_id, direction, display_name, parent_id
      INTO v_profile, v_dir, v_old_name, v_old_parent
      FROM categories WHERE id = p_category_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'categoria nao encontrada';
    END IF;
    IF v_profile <> app.jwt_profile_id() THEN
        RAISE EXCEPTION 'categoria pertence a outro perfil';
    END IF;
    IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'nome da categoria obrigatorio';
    END IF;
    v_name := trim(p_display_name);
    v_norm := app.normalize_description(v_name);

    IF p_parent_id IS NOT NULL THEN
        IF p_parent_id = p_category_id THEN
            RAISE EXCEPTION 'categoria nao pode ser filha de si mesma';
        END IF;
        SELECT direction INTO v_parent_dir FROM categories WHERE id = p_parent_id;
        IF v_parent_dir IS NULL THEN
            RAISE EXCEPTION 'categoria pai nao encontrada';
        END IF;
        IF v_parent_dir <> v_dir THEN
            RAISE EXCEPTION 'categoria de % nao pode ficar sob ancestral de %', v_dir, v_parent_dir;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM categories WHERE id = p_parent_id AND profile_id = app.jwt_profile_id()) THEN
            RAISE EXCEPTION 'categoria pai pertence a outro perfil';
        END IF;
        v_ancestor := p_parent_id;
        WHILE v_ancestor IS NOT NULL LOOP
            IF v_ancestor = p_category_id THEN
                RAISE EXCEPTION 'movimentacao criaria ciclo na arvore de categorias';
            END IF;
            SELECT parent_id INTO v_ancestor FROM categories WHERE id = v_ancestor;
        END LOOP;
    END IF;

    UPDATE categories
       SET display_name    = v_name,
           normalized_name = v_norm,
           parent_id       = p_parent_id,
           updated_at      = now()
     WHERE id = p_category_id;

    PERFORM app.category_refresh_path(p_category_id);

    IF v_old_name <> v_name OR v_old_parent IS DISTINCT FROM p_parent_id THEN
        PERFORM app.settings_audit_write(v_profile, 'category', p_category_id, 'update',
            jsonb_build_object('display_name', v_old_name, 'parent_id', v_old_parent),
            jsonb_build_object('display_name', v_name, 'parent_id', p_parent_id));
    END IF;

    RETURN jsonb_build_object(
        'category_id', p_category_id,
        'display_name', v_name,
        'parent_id', p_parent_id
    );
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ja existe categoria com esse nome neste perfil e nivel (normalizado: %)', v_norm
        USING ERRCODE = 'P0001';
END;
$$;

-- ---------- 9. app.category_set_archived + auditoria (archive/reactivate; no-op sem evento) ----------
CREATE OR REPLACE FUNCTION app.category_set_archived(
    p_category_id uuid,
    p_archived    boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile          uuid;
    v_active_children  integer;
    v_parent_archived  boolean;
    v_cat_name         text;
    v_old_status       text;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    SELECT display_name, status INTO v_cat_name, v_old_status FROM categories
     WHERE id = p_category_id AND profile_id = app.jwt_profile_id();
    IF v_cat_name IS NULL THEN
        RAISE EXCEPTION 'categoria nao encontrada neste perfil';
    END IF;

    IF p_archived THEN
        SELECT count(*) INTO v_active_children FROM categories
         WHERE parent_id = p_category_id AND status = 'active';
        IF v_active_children > 0 THEN
            RAISE EXCEPTION 'categoria possui subcategorias ativas; trate-as primeiro'
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE categories SET status = 'archived', updated_at = now()
         WHERE id = p_category_id;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM categories c JOIN categories p ON p.id = c.parent_id
             WHERE c.id = p_category_id AND p.status = 'archived'
        ) INTO v_parent_archived;
        IF v_parent_archived THEN
            RAISE EXCEPTION 'categoria pai esta arquivada; reative-a antes'
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE categories SET status = 'active', updated_at = now()
         WHERE id = p_category_id;
    END IF;

    -- evento somente em transicao real (no-op do RPC original preservado)
    IF v_old_status <> (CASE WHEN p_archived THEN 'archived' ELSE 'active' END) THEN
        PERFORM app.settings_audit_write(v_profile, 'category', p_category_id,
            CASE WHEN p_archived THEN 'archive' ELSE 'reactivate' END, NULL,
            jsonb_build_object('display_name', v_cat_name,
                'status', CASE WHEN p_archived THEN 'archived' ELSE 'active' END));
    END IF;

    RETURN jsonb_build_object(
        'category_id', p_category_id,
        'status', CASE WHEN p_archived THEN 'archived' ELSE 'active' END
    );
END;
$$;

-- ---------- 10. Grants reafirmados (CREATE OR REPLACE preserva grants; reafirmacao idempotente) ----------
GRANT EXECUTE ON FUNCTION app.account_create(text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION app.account_update(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.account_set_profile_active(uuid, boolean, date) TO authenticated;
GRANT EXECUTE ON FUNCTION app.category_create(text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.category_update(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.category_set_archived(uuid, boolean) TO authenticated;

COMMIT;