-- ============================================================
-- ROLLBACK_CLOUD_013_CRUD_DISABLE.sql
-- Desativação NÃO destrutiva do soft-delete Cloud 013.
-- Bloqueia apenas a RPC de exclusão (transaction_delete).
--
-- Preserva SEMPRE:
--   * Colunas deleted_at (permitem consultas de serviço; não expostas ao frontend);
--   * transactions_select_own (a política com deleted_at IS NULL);
--   * CHECK de transaction_audit (action IN create/update/delete);
--   * Guards deleted_at em transaction_update e transaction_get_detail;
--   * Todas as transações, auditorias e transfer_links existentes;
--   * Objeto transaction_audit e dados históricos 010/011/012.
--
-- Não restaura a policy anterior (transactions_select_auth não existe mais
-- desde o 009; categories_select_own é irreversível por decisão).
-- Não remove colunas nem apaga dados.
-- ============================================================

-- 1) Revogar EXECUTE da wrapper pública (bloqueia o frontend)
REVOKE EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) FROM authenticated;

-- 2) Revogar EXECUTE da função interna app.* (defesa em profundidade)
REVOKE EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) FROM authenticated;

-- 3) Recarregar o schema PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- Verificação manual pós-rollback (opcional, read-only):
--   SELECT count(*) FROM information_schema.role_routine_grants
--    WHERE routine_schema IN ('public','app')
--      AND routine_name = 'transaction_delete'
--      AND grantee='authenticated' AND privilege_type='EXECUTE';
--   (esperado: 0)

-- Para REATIVAR sem reaplicar o 013 inteiro, executar apenas os GRANTs abaixo:
--   GRANT EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) TO authenticated;
--   SELECT pg_notify('pgrst', 'reload schema');
