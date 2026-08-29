-- ============================================================
-- 019_category_refresh_path_hardening.sql
-- HARDENING DE PRIVILEGIOS SOMENTE (CFG-P3C1) — LOCAL, NAO APLICAR sem autorizacao.
--
-- Problema: funcoes novas no PostgreSQL recebem EXECUTE para PUBLIC por
-- padrao; a 018 nao fez REVOKE, entao app.category_refresh_path(uuid) ficou
-- executavel por authenticated via PUBLIC herdado. A funcao e HELPER INTERNO
-- (chamada apenas dentro dos RPCs SECURITY DEFINER) e nao deve ser endpoint.
--
-- Correcao minima: revogar EXECUTE de PUBLIC e de authenticated para o
-- helper. NAO altera a logica funcional dos RPCs: category_refresh_path
-- continua sendo chamada internamente por app.category_create / app.category_update
-- (SECURITY DEFINER; o owner mantem EXECUTE), entao os endpoints
-- public.category_* seguem funcionando.
--
-- Escopo: somente hardening de privilegios; zero DML; zero alteracao de
-- categorias/transactions/accounts/account_profile_periods; nao toca na 018.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION app.category_refresh_path(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.category_refresh_path(uuid) FROM authenticated;

COMMIT;