-- ============================================================
-- ROLLBACK_CLOUD_014_AUDIT.sql
-- Reverte 014_cloud_audit_profile_visibility.sql por completo:
--   * remove triggers + função set_audit_profile_id;
--   * remove índices, FKs e colunas profile_id;
--   * restaura as policies de leitura ORIGINAIS (subquery em transactions),
--     OU SEJA: volta o comportamento pré-014 (auditoria de soft-deleted
--     volta a ficar oculta ao dono — limitação conhecida).
--
-- Preserva SEMPRE:
--   * todas as linhas de auditoria (transaction_id, before/after_state,
--     changed_by, created_at, etc.);
--   * policies de escrita (service_role);
--   * grants de SELECT/INSERT;
--   * demais objetos (transaction_audit, category_assignment_audit).
-- ============================================================

-- 1) Remover triggers
DROP TRIGGER IF EXISTS trg_audit_profile_tx ON public.transaction_audit;
DROP TRIGGER IF EXISTS trg_audit_profile_caa ON public.category_assignment_audit;

-- 2) Remover função (sem EXECUTE concedido a anon/authenticated)
DROP FUNCTION IF EXISTS app.set_audit_profile_id();

-- 3) Remover índices e FKs
DROP INDEX IF EXISTS public.idx_ta_profile_created;
DROP INDEX IF EXISTS public.idx_caa_profile_created;

ALTER TABLE public.transaction_audit DROP CONSTRAINT IF EXISTS transaction_audit_profile_fk;
ALTER TABLE public.category_assignment_audit DROP CONSTRAINT IF EXISTS category_assignment_audit_profile_fk;

-- 3b) Remover policies de leitura do 014 ANTES das colunas (evita dependência)
DROP POLICY IF EXISTS ta_select_own ON public.transaction_audit;
DROP POLICY IF EXISTS audit_select_own ON public.category_assignment_audit;

-- 4) Remover colunas profile_id
ALTER TABLE public.transaction_audit DROP COLUMN IF EXISTS profile_id;
ALTER TABLE public.category_assignment_audit DROP COLUMN IF EXISTS profile_id;

-- 5) Restaurar policies de leitura ORIGINAIS (pré-014)
CREATE POLICY ta_select_own ON public.transaction_audit FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM public.transactions t
                      WHERE t.id = transaction_audit.transaction_id
                        AND t.profile_id = app.jwt_profile_id()));

CREATE POLICY audit_select_own ON public.category_assignment_audit FOR SELECT
    USING (app.jwt_role() = 'service_role'
           OR EXISTS (SELECT 1 FROM public.transactions t
                      WHERE t.id = category_assignment_audit.transaction_id
                        AND t.profile_id = app.jwt_profile_id()));

-- 6) Recarregar schema PostgREST
SELECT pg_notify('pgrst', 'reload schema');
