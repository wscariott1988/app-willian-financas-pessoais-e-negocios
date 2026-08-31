-- ============================================================
-- 022_account_profile_favorites.sql
-- PREFERENCIA DE FAVORITO POR PERFIL (CFG-P8A) + USAGE READ-ONLY RPC
-- (CFG-P8C1) — LOCAL, NAO APLICAR.
--
-- SHA-256 ANTERIOR (CFG-P8A/P8C, SEM account_usage_stats):
--   1999F0987357EF8FE90F7023D52B91E3C9AA62715218195FED7E750FD4F598D8 (5250 bytes)
--   => OBSOLETO / NAO APLICAR.
--
-- CFG-P8C1: o PostgREST do Cloud tem agregados DESABILITADOS
-- (PGRST123: "Use of aggregate functions is not allowed"), comprovado no
-- gate CFG-P8C0 read-only. Portanto recencia/frequencia NAO podem usar
-- .max()/.count()/.group() via PostgREST; este pacote passa a entregar a
-- metadata por RPC read-only account_usage_stats() (app.* + public.*),
-- com perfil derivado do JWT (nunca do cliente).
--
-- Decisao (CFG-P8A itens 2/4/17):
--   * O documento mestre (v1.1, secao C.4.2) define is_favorite/usage_score
--     GLOBAIS na entidade accounts. Porem o modelo real permite a MESMA conta
--     vinculada a PESSOAL e NEGOCIO via account_profile_periods; favorito
--     global faria a preferencia vazar entre perfis (caso critico do item 17).
--   * Este pacote implementa a preferencia POR PERFIL em tabela propria,
--     sem tocar is_favorite global (mantido para compatibilidade/schema).
--   * Favoritar/desfavoritar e preferencia de apresentacao: ZERO efeito em
--     transactions, periods, categories, series ou auditorias financeiras.
--   * Nao gera transaction_audit nem settings_audit (preferencia visual;
--     nao poluir o Historico — decisao documentada, item 12 do CFG).
--
-- Recencia (item 5):
--   * definida como MAX(transactions.occurred_on) da conta NO PROFILE ATUAL,
--     considerando somente transacoes nao deletadas — derivada read-only,
--     sem campo persistido.
--
-- Ordem canonica (item 6):
--   1) favoritas primeiro; 2) dentro do grupo, mais recentes primeiro;
--   3) nao favoritas depois, tambem por recencia; 4) empate: nome A->Z;
--   5) empate final: id (interno, nunca exibido). Conta sem atividade fica
--   depois das com atividade dentro do mesmo grupo.
-- ============================================================

BEGIN;

-- ---------- 1. Preferencia por (account, profile) — uma verdade atual ----------
CREATE TABLE account_profile_favorites (
    account_id     uuid NOT NULL REFERENCES accounts (id),
    profile_id     uuid NOT NULL REFERENCES profiles (id),
    is_favorite    boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, profile_id)
);

CREATE INDEX idx_apf_profile ON account_profile_favorites (profile_id);

-- ---------- 2. RLS + grants (leitura do proprio perfil; escrita service_role) ----------
ALTER TABLE account_profile_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY apf_select_own ON account_profile_favorites FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());
CREATE POLICY apf_write_service ON account_profile_favorites FOR ALL
    USING (app.jwt_role() = 'service_role') WITH CHECK (app.jwt_role() = 'service_role');

GRANT SELECT ON account_profile_favorites TO authenticated;
-- NENHUM grant de INSERT/UPDATE/DELETE para authenticated.

-- ---------- 3. RPC account_set_favorite (idempotente; por perfil do JWT) ----------
-- Valida que a conta possui (ou possuiu) vinculo com o perfil via
-- account_profile_periods (mesma regra de disponibilidade do projeto).
CREATE OR REPLACE FUNCTION app.account_set_favorite(
    p_account_id uuid,
    p_favorite   boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
    v_linked  boolean;
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

    -- vinculo com o perfil (historico ou atual): impede preferencia cross-profile
    SELECT EXISTS (
        SELECT 1 FROM account_profile_periods pp
         WHERE pp.account_id = p_account_id AND pp.profile_id = v_profile
    ) INTO v_linked;
    IF NOT v_linked THEN
        RAISE EXCEPTION 'conta nao esta vinculada a este perfil';
    END IF;

    IF p_favorite THEN
        INSERT INTO account_profile_favorites (account_id, profile_id, is_favorite, created_at, updated_at)
        VALUES (p_account_id, v_profile, true, now(), now())
        ON CONFLICT (account_id, profile_id)
        DO UPDATE SET is_favorite = true, updated_at = now();
    ELSE
        INSERT INTO account_profile_favorites (account_id, profile_id, is_favorite, created_at, updated_at)
        VALUES (p_account_id, v_profile, false, now(), now())
        ON CONFLICT (account_id, profile_id)
        DO UPDATE SET is_favorite = false, updated_at = now();
    END IF;

    RETURN jsonb_build_object(
        'account_id', p_account_id,
        'profile_id', v_profile,
        'is_favorite', p_favorite
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.account_set_favorite(
    p_account_id uuid,
    p_favorite   boolean
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT app.account_set_favorite(p_account_id, p_favorite);
$$;

-- ---------- 3b. RPC read-only account_usage_stats (CFG-P8C1) ----------
-- Recencia (MAX occurred_on) e frequencia (COUNT) por conta NO PERFIL DO JWT,
-- em UMA chamada (N+1=0). Substitui a aggregate do PostgREST, que esta
-- DESABILITADA no Cloud (PGRST123: "Use of aggregate functions is not
-- allowed"). Perfil SEMPRE derivado do JWT (app.jwt_profile_id()); este
-- endpoint NAO aceita profile_id do cliente. Soft-deleted nao conta.
-- Somente leitura: nao altera transactions nem gera auditoria.
CREATE OR REPLACE FUNCTION app.account_usage_stats()
RETURNS TABLE (
    account_id    uuid,
    last_activity date,
    usage_count   bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_profile uuid;
BEGIN
    v_profile := app.jwt_profile_id();
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'perfil nao identificado no token';
    END IF;
    RETURN QUERY
    SELECT t.account_id,
           MAX(t.occurred_on)::date AS last_activity,
           COUNT(*)::bigint         AS usage_count
      FROM transactions t
     WHERE t.profile_id = v_profile
       AND t.deleted_at IS NULL
       AND t.account_id IS NOT NULL
     GROUP BY t.account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.account_usage_stats()
RETURNS TABLE (
    account_id    uuid,
    last_activity date,
    usage_count   bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, app
AS $$
    SELECT * FROM app.account_usage_stats();
$$;

-- ---------- 4. Hardening + grants ----------
REVOKE ALL ON FUNCTION app.account_set_favorite(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.account_set_favorite(uuid, boolean) FROM authenticated;

GRANT EXECUTE ON FUNCTION app.account_set_favorite(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_set_favorite(uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION app.account_usage_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.account_usage_stats() FROM authenticated;
REVOKE ALL ON FUNCTION public.account_usage_stats() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.account_usage_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_stats() TO authenticated;

COMMIT;