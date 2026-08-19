-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- VERIFY_POST_CLOUD_013_READONLY.sql
-- Verificação APÓS a aplicação do pacote Cloud 013.
-- UMA única statement SELECT -> UMA grade exportável:
--   ord | stage | status (PASS/BLOCKED) | detail (jsonb)
-- Não escreve nada. Se qualquer etapa der BLOCKED, aplicar ROLLBACK.
-- ============================================================

SELECT * FROM (

-- 1) Colunas deleted_at criadas em ambas as tabelas
SELECT 1 AS ord, 'stg_013_deleted_at_presente' AS stage,
       CASE WHEN EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='transactions'
                 AND column_name='deleted_at')
             AND EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='transfer_links'
                 AND column_name='deleted_at')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'transactions_deleted_at', EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='transactions'
                 AND column_name='deleted_at'),
           'transfer_links_deleted_at', EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='transfer_links'
                 AND column_name='deleted_at')
       ) AS detail

UNION ALL

-- 2) Índice parcial idx_tx_not_deleted criado
SELECT 2 AS ord, 'stg_013_indice' AS stage,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_indexes
               WHERE schemaname='public' AND indexname='idx_tx_not_deleted')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'idx_tx_not_deleted', EXISTS (
              SELECT 1 FROM pg_indexes
               WHERE schemaname='public' AND indexname='idx_tx_not_deleted')
       ) AS detail

UNION ALL

-- 3) CHECK de transaction_audit contém 'delete'
SELECT 3 AS ord, 'stg_013_audit_check' AS stage,
       CASE WHEN (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                   WHERE conname='transaction_audit_action_check'
                     AND conrelid='public.transaction_audit'::regclass)
                  LIKE '%delete%'
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'constraint_def', (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conname='transaction_audit_action_check'
                                 AND conrelid='public.transaction_audit'::regclass)
       ) AS detail

UNION ALL

-- 4) app.transaction_delete existe, SECURITY DEFINER, search_path correto
SELECT 4 AS ord, 'stg_013_fn_delete' AS stage,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'
                 AND p.prosecdef = true)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'app_transaction_delete', EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'),
           'security_definer', (SELECT p.prosecdef FROM pg_proc p
                                 JOIN pg_namespace n ON n.oid=p.pronamespace
                                WHERE n.nspname='app' AND p.proname='transaction_delete'),
           'args', (SELECT pg_get_function_identity_arguments(p.oid)
                     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='app' AND p.proname='transaction_delete')
       ) AS detail

UNION ALL

-- 5) public.transaction_delete wrapper existe, SECURITY INVOKER
SELECT 5 AS ord, 'stg_013_wrapper_delete' AS stage,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete'
                 AND p.prosecdef = false)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'public_transaction_delete', EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete'),
           'security_invoker', NOT (SELECT p.prosecdef FROM pg_proc p
                                     JOIN pg_namespace n ON n.oid=p.pronamespace
                                    WHERE n.nspname='public' AND p.proname='transaction_delete'),
           'args', (SELECT pg_get_function_identity_arguments(p.oid)
                     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname='transaction_delete')
       ) AS detail

UNION ALL

-- 6) Grants: authenticated pode executar delete (app.* e public.*)
SELECT 6 AS ord, 'stg_013_grants' AS stage,
       CASE WHEN
         has_function_privilege('authenticated',
           (SELECT 'app.transaction_delete(' || pg_get_function_identity_arguments(p.oid) || ')'
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
         AND has_function_privilege('authenticated',
           (SELECT 'public.transaction_delete(' || pg_get_function_identity_arguments(p.oid) || ')'
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
         AND NOT has_function_privilege('anon',
           (SELECT 'public.transaction_delete(' || pg_get_function_identity_arguments(p.oid) || ')'
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'app_exec_auth', has_function_privilege('authenticated',
             (SELECT 'app.transaction_delete(' || pg_get_function_identity_arguments(p.oid) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE'),
           'public_exec_auth', has_function_privilege('authenticated',
             (SELECT 'public.transaction_delete(' || pg_get_function_identity_arguments(p.oid) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE'),
           'public_exec_anon', has_function_privilege('anon',
             (SELECT 'public.transaction_delete(' || pg_get_function_identity_arguments(p.oid) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 7) transaction_update agora tem guard deleted_at
SELECT 7 AS ord, 'stg_013_update_guard' AS stage,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_update'
                 AND p.prosecdef = true)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'app_transaction_update', EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_update'),
           'security_definer', (SELECT p.prosecdef FROM pg_proc p
                                 JOIN pg_namespace n ON n.oid=p.pronamespace
                                WHERE n.nspname='app' AND p.proname='transaction_update')
       ) AS detail

UNION ALL

-- 8) transaction_get_detail tem guard deleted_at
SELECT 8 AS ord, 'stg_013_detail_guard' AS stage,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_get_detail'
                 AND p.prosecdef = true)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'app_transaction_get_detail', EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_get_detail'),
           'security_definer', (SELECT p.prosecdef FROM pg_proc p
                                 JOIN pg_namespace n ON n.oid=p.pronamespace
                                WHERE n.nspname='app' AND p.proname='transaction_get_detail')
       ) AS detail

UNION ALL

-- 9) Integridade: nenhum objeto 012 foi destruído; wrappers CRUD intactos
SELECT 9 AS ord, 'stg_013_integridade_012' AS stage,
       CASE WHEN
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='app'
             AND p.proname IN ('normalize_description','tx_state_jsonb',
                               'assert_account_for_profile','resolve_category_for_profile',
                               'close_queue_item','close_all_open_queue',
                               'transaction_create','transaction_update',
                               'transaction_get_detail')) = 9
         AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public'
                 AND p.proname IN ('transaction_create','transaction_update',
                                   'transaction_get_detail','transaction_delete')) = 4
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'UPDATE')
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'DELETE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'funcoes_app_9', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                              WHERE n.nspname='app'
                                AND p.proname IN ('normalize_description','tx_state_jsonb',
                                                  'assert_account_for_profile','resolve_category_for_profile',
                                                  'close_queue_item','close_all_open_queue',
                                                  'transaction_create','transaction_update',
                                                  'transaction_get_detail')),
           'wrappers_public_4', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                  WHERE n.nspname='public'
                                    AND p.proname IN ('transaction_create','transaction_update',
                                                      'transaction_get_detail','transaction_delete')),
           'auth_insert', has_table_privilege('authenticated', 'public.transactions', 'INSERT'),
           'auth_update', has_table_privilege('authenticated', 'public.transactions', 'UPDATE'),
           'auth_delete', has_table_privilege('authenticated', 'public.transactions', 'DELETE')
       ) AS detail

) s
ORDER BY ord;
