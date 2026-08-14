-- ============================================================
-- ROLLBACK_CLOUD_012_CRUD_DISABLE.sql
-- Desativação NÃO destrutiva do CRUD Cloud 012 (apenas wrappers).
-- Permite reverter a exposição do CRUD ao frontend sem tocar em dados.
--
-- Preserva SEMPRE:
--   * categories_select_own (isolamento) — NUNCA recriar categories_select_auth;
--   * transactions e auditorias já criadas;
--   * transaction_audit (tabela e conteúdo);
--   * correções de dados 010/011 (NÃO desfazer);
--   * funções internas app.* (permanecem; perdem apenas o acesso externo).
--
-- Não há rollback destrutivo automático de dados neste pacote.
-- ============================================================

-- 1) Revogar EXECUTE dos wrappers públicos (bloqueia o frontend)
REVOKE EXECUTE ON FUNCTION public.transaction_create(text, text, numeric, date, uuid, uuid, uuid, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.transaction_update(uuid, timestamptz, text, text, numeric, date, uuid, uuid, uuid, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.transaction_get_detail(uuid) FROM authenticated;

-- 2) Idem nas funções internas app.* (defesa em profundidade; opcional)
REVOKE EXECUTE ON FUNCTION app.transaction_create(text, text, numeric, date, uuid, uuid, uuid, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION app.transaction_update(uuid, timestamptz, text, text, numeric, date, uuid, uuid, uuid, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION app.transaction_get_detail(uuid) FROM authenticated;

-- 3) Recarregar o schema PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- Verificação manual pós-rollback (opcional, read-only):
--   SELECT count(*) FROM information_schema.role_routine_grants
--    WHERE routine_schema IN ('public','app')
--      AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
--      AND grantee='authenticated' AND privilege_type='EXECUTE';
--   (esperado: 0)

-- Para REATIVAR sem reaplicar o 012 inteiro, executar apenas os GRANTs abaixo:
--   GRANT EXECUTE ON FUNCTION public.transaction_create(text, text, numeric, date, uuid, uuid, uuid, text, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.transaction_update(uuid, timestamptz, text, text, numeric, date, uuid, uuid, uuid, text, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.transaction_get_detail(uuid) TO authenticated;
--   GRANT EXECUTE ON FUNCTION app.transaction_create(text, text, numeric, date, uuid, uuid, uuid, text, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION app.transaction_update(uuid, timestamptz, text, text, numeric, date, uuid, uuid, uuid, text, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION app.transaction_get_detail(uuid) TO authenticated;
--   SELECT pg_notify('pgrst', 'reload schema');
