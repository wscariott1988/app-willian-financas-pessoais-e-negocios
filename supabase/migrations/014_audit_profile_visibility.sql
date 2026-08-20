-- ============================================================
-- 014_audit_profile_visibility.sql
-- Visibilidade robusta da auditoria por DENORMALIZAÇÃO de profile_id.
--
-- Problema resolvido (013 + frontend):
--   * ta_select_own / audit_select_own resolviam o perfil via subquery em
--     transactions; com transactions_select_own exigindo deleted_at IS NULL
--     (013), auditorias de transações soft-deletadas ficavam OCULTAS ao dono;
--   * a tela Histórico de alterações não lia transaction_audit.
--
-- Solução:
--   * profile_id denormalizado em transaction_audit e category_assignment_audit;
--   * backfill determinístico transaction_id -> transactions.profile_id
--     (inclui soft-deleted) com asserts antes de NOT NULL;
--   * FK para profiles + índices (profile_id, created_at DESC);
--   * trigger/função SECURITY DEFINER que deriva profile_id EXCLUSIVAMENTE da
--     transação em todo INSERT (nunca confia no cliente; funciona p/ soft-deleted;
--     sem EXECUTE para anon/authenticated);
--   * policies de leitura diretas: profile_id = app.jwt_profile_id()
--     (SEM subquery em transactions);
--   * preserva policies de escrita, grants e auditorias antigas.
-- ============================================================

BEGIN;

-- 1) Colunas profile_id
ALTER TABLE transaction_audit ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE category_assignment_audit ADD COLUMN IF NOT EXISTS profile_id uuid;

-- 2) Backfill determinístico (todas as transações, inclusive soft-deleted)
UPDATE transaction_audit a
   SET profile_id = t.profile_id
  FROM transactions t
 WHERE t.id = a.transaction_id;

UPDATE category_assignment_audit a
   SET profile_id = t.profile_id
  FROM transactions t
 WHERE t.id = a.transaction_id;

-- 3) Asserts antes de NOT NULL: zero sem profile_id; zero divergências
DO $$
DECLARE
    v_n1 int; v_n2 int; v_d1 int; v_d2 int;
BEGIN
    SELECT count(*) INTO v_n1 FROM transaction_audit WHERE profile_id IS NULL;
    SELECT count(*) INTO v_n2 FROM category_assignment_audit WHERE profile_id IS NULL;
    IF v_n1 > 0 OR v_n2 > 0 THEN
        RAISE EXCEPTION '014: linhas de auditoria sem profile_id (transaction_audit=%, category_assignment_audit=%)', v_n1, v_n2;
    END IF;

    SELECT count(*) INTO v_d1
      FROM transaction_audit a JOIN transactions t ON t.id = a.transaction_id
     WHERE a.profile_id IS DISTINCT FROM t.profile_id;
    SELECT count(*) INTO v_d2
      FROM category_assignment_audit a JOIN transactions t ON t.id = a.transaction_id
     WHERE a.profile_id IS DISTINCT FROM t.profile_id;
    IF v_d1 > 0 OR v_d2 > 0 THEN
        RAISE EXCEPTION '014: divergencia profile_id vs transactions (transaction_audit=%, category_assignment_audit=%)', v_d1, v_d2;
    END IF;
END $$;

-- 4) NOT NULL + FK + índices
ALTER TABLE transaction_audit ALTER COLUMN profile_id SET NOT NULL;
ALTER TABLE category_assignment_audit ALTER COLUMN profile_id SET NOT NULL;

ALTER TABLE transaction_audit
    ADD CONSTRAINT transaction_audit_profile_fk
    FOREIGN KEY (profile_id) REFERENCES profiles (id);
ALTER TABLE category_assignment_audit
    ADD CONSTRAINT category_assignment_audit_profile_fk
    FOREIGN KEY (profile_id) REFERENCES profiles (id);

CREATE INDEX IF NOT EXISTS idx_ta_profile_created  ON transaction_audit (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caa_profile_created ON category_assignment_audit (profile_id, created_at DESC);

-- 5) Função protegida que deriva profile_id da transação (todo INSERT).
--    SECURITY DEFINER + search_path fixo e seguro; nunca confia em profile_id
--    do cliente (SEMPRE substituído pelo perfil real da transação, inclusive
--    transações soft-deleted — definer bypassa RLS). Referências 100%
--    qualificadas (public.transactions; o perfil vem da transação, não há
--    consulta direta a public.profiles).
CREATE OR REPLACE FUNCTION app.set_audit_profile_id() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
    v_profile uuid;
BEGIN
    SELECT profile_id INTO v_profile
      FROM public.transactions
     WHERE id = NEW.transaction_id;
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'auditoria sem transacao valida (transaction_id=%)', NEW.transaction_id;
    END IF;
    NEW.profile_id := v_profile;
    RETURN NEW;
END;
$$;

-- Sem EXECUTE para ninguém além dos triggers (só é invocado por triggers)
REVOKE EXECUTE ON FUNCTION app.set_audit_profile_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.set_audit_profile_id() FROM anon;
REVOKE EXECUTE ON FUNCTION app.set_audit_profile_id() FROM authenticated;

DROP TRIGGER IF EXISTS trg_audit_profile_tx ON transaction_audit;
CREATE TRIGGER trg_audit_profile_tx
    BEFORE INSERT ON transaction_audit
    FOR EACH ROW EXECUTE FUNCTION app.set_audit_profile_id();

DROP TRIGGER IF EXISTS trg_audit_profile_caa ON category_assignment_audit;
CREATE TRIGGER trg_audit_profile_caa
    BEFORE INSERT ON category_assignment_audit
    FOR EACH ROW EXECUTE FUNCTION app.set_audit_profile_id();

-- 6) Policies de leitura diretas (SEM subquery em transactions)
DROP POLICY IF EXISTS ta_select_own ON transaction_audit;
CREATE POLICY ta_select_own ON transaction_audit FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());

DROP POLICY IF EXISTS audit_select_own ON category_assignment_audit;
CREATE POLICY audit_select_own ON category_assignment_audit FOR SELECT
    USING (app.jwt_role() = 'service_role' OR profile_id = app.jwt_profile_id());

-- 7) Grants preservados (reafirmação idempotente)
GRANT SELECT ON transaction_audit TO authenticated;
GRANT SELECT, INSERT ON category_assignment_audit TO authenticated;

-- 8) RESTAURAR auditoria de UPDATE (regressão do 013)
--    O 013 substituiu app.transaction_update SEM o INSERT de auditoria que o
--    011 tinha (011:494-499). Sem isso, "Transação editada" nunca seria exibida
--    no Histórico de alterações (requisito do frontend 014).
--    Função reescrita = corpo do 013 + INSERT em transaction_audit (o trigger
--    trg_audit_profile_tx preenche profile_id).
CREATE OR REPLACE FUNCTION app.transaction_update(
    p_transaction_id      uuid,
    p_expected_updated_at timestamptz,
    p_kind                text,
    p_description         text,
    p_amount              numeric,
    p_occurred_on         date,
    p_account_id          uuid,
    p_to_account_id       uuid DEFAULT NULL,
    p_category_id         uuid DEFAULT NULL,
    p_status              text DEFAULT NULL,
    p_memo                text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
    v_cur     public.transactions%ROWTYPE;
    v_sub     uuid;
BEGIN
    SELECT * INTO v_cur
      FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'transacao % nao encontrada', p_transaction_id;
    END IF;

    IF v_cur.profile_id <> app.jwt_profile_id() THEN
        RAISE EXCEPTION 'perfil do token nao possui a transacao %', p_transaction_id;
    END IF;

    IF v_cur.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'transacao % ja foi excluida', p_transaction_id;
    END IF;

    IF p_expected_updated_at IS NOT NULL
       AND abs(extract(epoch FROM (v_cur.updated_at - p_expected_updated_at))) > 0.001
    THEN
        RAISE EXCEPTION 'CONFLITO: transacao foi modificada por outra operacao';
    END IF;

    UPDATE public.transactions
       SET account_id             = p_account_id,
           category_id            = COALESCE(p_category_id, category_id),
           transaction_kind       = p_kind,
           amount                 = p_amount,
           occurred_on            = p_occurred_on,
           raw_description        = p_description,
           normalized_description = p_description,
           status                 = COALESCE(p_status, status),
           memo                   = p_memo,
           updated_at             = now()
     WHERE id = p_transaction_id;

    INSERT INTO public.transaction_audit
        (id, transaction_id, action, before_state, after_state,
         changed_by, transfer_link_id, related_transaction_id, created_at)
    VALUES (
        gen_random_uuid(), p_transaction_id, 'update',
        to_jsonb(v_cur.*),
        (SELECT to_jsonb(t) FROM public.transactions t WHERE t.id = p_transaction_id),
        app.jwt_profile_id(), NULL, NULL, now()
    );

    PERFORM app.close_all_open_queue(p_transaction_id);

    RETURN to_jsonb(v_cur.*) || jsonb_build_object(
        'transaction_id', p_transaction_id,
        'updated_at',     (SELECT updated_at FROM public.transactions WHERE id = p_transaction_id)
    );
END;
$$;

COMMIT;
