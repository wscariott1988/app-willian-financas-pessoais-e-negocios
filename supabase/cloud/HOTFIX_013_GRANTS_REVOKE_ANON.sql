-- ============================================================
-- HOTFIX_013_GRANTS_REVOKE_ANON.sql
-- Corrige ACLs das funções transaction_delete criadas pelo 013.
--
-- Problema: 013_cloud_transaction_delete.sql executou GRANT TO
-- authenticated mas NÃO executou REVOKE FROM PUBLIC. No
-- PostgreSQL, funções recém-criadas herdam EXECUTE para PUBLIC
-- por default. O role anon (membro de PUBLIC) ficou com
-- EXECUTE em app.transaction_delete e public.transaction_delete.
--
-- Correção: REVOKE FROM PUBLIC + RE-GRANT TO authenticated.
-- Idempotente: REVOKE de privilegio inexistente é noop; GRANT
-- preserva grants existentes.
--
-- 5 statements: 2 REVOKE FROM PUBLIC + 2 GRANT TO authenticated + NOTIFY.
-- Não altera schema, não cria funções, não modifica dados.
-- ============================================================

-- app.transaction_delete: remover EXECUTE de PUBLIC, garantir authenticated
REVOKE EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.transaction_delete(uuid, timestamptz) TO authenticated;

-- public.transaction_delete: remover EXECUTE de PUBLIC, garantir authenticated
REVOKE EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transaction_delete(uuid, timestamptz) TO authenticated;

-- Recarregar schema PostgREST para aplicar mudanças de grants
NOTIFY pgrst, 'reload schema';
