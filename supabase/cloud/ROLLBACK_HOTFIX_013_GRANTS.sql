-- ============================================================
-- ROLLBACK_HOTFIX_013_GRANTS.sql
-- Desativação total da RPC transaction_delete em caso de
-- falha na verificação pós-hotfix.
--
-- Segue o padrão de ROLLBACK_CLOUD_013_CRUD_DISABLE.sql:
-- NUNCA restaura acesso anônimo; revoga EXECUTE de todos
-- os roles (PUBLIC, anon, authenticated) nas duas funções.
--
-- Preserva SEMPRE:
--   * Colunas deleted_at (consultas de serviço);
--   * transactions_select_own (deleted_at IS NULL);
--   * CHECK de transaction_audit (action IN create/update/delete);
--   * Guards em transaction_update e transaction_get_detail;
--   * Todas as transações, auditorias e transfer_links.
--
-- Não remove colunas nem apaga dados.
-- ============================================================

-- 1) Revogar EXECUTE de PUBLIC (elimina acesso de anon)
REVOKE EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) FROM PUBLIC;

-- 2) Revogar EXECUTE de authenticated (bloqueia frontend e service_role indireto)
REVOKE EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) FROM authenticated;

-- 3) Recarregar schema PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- ============================================================
-- Verificação pós-rollback (read-only, opcional):
--   SELECT has_function_privilege('anon',
--     (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
--      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--      WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE');
--   (esperado: false)
--
-- Para REATIVAR sem reaplicar o 013:
--   GRANT EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) TO authenticated;
--   SELECT pg_notify('pgrst', 'reload schema');
-- ============================================================
