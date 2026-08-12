-- ============================================================================
-- VERIFY_SETUP.sql
-- Somente CONSULTAS DE LEITURA. Nao altera nenhum dado.
-- Execute apos o SETUP_SUPABASE_CLOUD.sql para confirmar:
--   * tabelas essenciais criadas;
--   * RLS habilitado e politicas por tabela;
--   * trigger handle_new_user em auth.users;
--   * RPC publica assign_category_atomic (2 argumentos).
-- Resultado esperado: 5 blocos, todos com saida e nenhum erro.
-- ============================================================================

-- ---------- 1) Tabelas essenciais ----------
SELECT '1. TABELAS' AS secao;
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'profiles', 'accounts', 'account_profile_periods', 'categories',
    'category_aliases', 'account_aliases', 'import_batches', 'transactions',
    'transfer_links', 'category_merge_map', 'migration_decisions',
    'reclassification_queue', 'category_assignment_audit', 'auth_users'
  )
ORDER BY table_name;

-- ---------- 2) RLS habilitado ----------
SELECT '2. RLS HABILITADO' AS secao;
SELECT relname AS tabela
FROM pg_class
WHERE relkind = 'r'
  AND relrowsecurity = TRUE
  AND relnamespace = 'public'::regnamespace
  AND relname IN (
    'profiles', 'accounts', 'account_profile_periods', 'categories',
    'category_aliases', 'account_aliases', 'transactions',
    'reclassification_queue', 'category_assignment_audit', 'auth_users'
  )
ORDER BY relname;

-- ---------- 3) Politicas RLS ----------
SELECT '3. POLITICAS RLS' AS secao;
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- ---------- 4) Trigger handle_new_user em auth.users ----------
SELECT '4. TRIGGER handle_new_user' AS secao;
SELECT tgname AS trigger_name
FROM pg_trigger
WHERE tgrelid = 'auth.users'::regclass
  AND NOT tgisinternal
ORDER BY tgname;

-- ---------- 5) RPC publica assign_category_atomic (2 argumentos) ----------
SELECT '5. RPC publica assign_category_atomic' AS secao;
SELECT p.proname AS funcao,
       pg_get_function_arguments(p.oid) AS argumentos,
       p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'assign_category_atomic'
ORDER BY pg_get_function_arguments(p.oid);

-- ---------- 6) Funcoes de apoio no schema app ----------
SELECT '6. FUNCOES app (apoio RLS/RPC)' AS secao;
SELECT n.nspname AS schema,
       p.proname AS funcao,
       pg_get_function_arguments(p.oid) AS argumentos
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app'
ORDER BY p.proname, pg_get_function_arguments(p.oid);
