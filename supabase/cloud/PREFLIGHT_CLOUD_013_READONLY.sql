-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_CLOUD_013_READONLY.sql
-- Verificação imediatamente ANTES da aplicação do pacote Cloud 013.
-- UMA única statement SELECT -> UMA grade exportável:
--   ord | stage | status (PASS/BLOCKED) | detail (jsonb)
-- Não escreve nada. Se qualquer etapa der BLOCKED, NÃO aplicar o pacote.
-- Pré-requisito: Cloud 009–012 já aplicados e verificados.
-- ============================================================

SELECT * FROM (

-- 1) Cloud 012 presente: transaction_audit + 9 funções app.* + 3 wrappers public.*
SELECT 1 AS ord, 'stg_012_objetos_presentes' AS stage,
       CASE WHEN to_regclass('public.transaction_audit') IS NOT NULL
             AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='app'
                     AND p.proname IN ('normalize_description','tx_state_jsonb',
                                       'assert_account_for_profile','resolve_category_for_profile',
                                       'close_queue_item','close_all_open_queue',
                                       'transaction_create','transaction_update',
                                       'transaction_get_detail')) = 9
             AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public'
                     AND p.proname IN ('transaction_create','transaction_update',
                                       'transaction_get_detail')) = 3
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'transaction_audit', to_regclass('public.transaction_audit'),
           'funcoes_app', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                            WHERE n.nspname='app'
                              AND p.proname IN ('normalize_description','tx_state_jsonb',
                                                'assert_account_for_profile','resolve_category_for_profile',
                                                'close_queue_item','close_all_open_queue',
                                                'transaction_create','transaction_update',
                                                'transaction_get_detail')),
           'wrappers_public', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                WHERE n.nspname='public'
                                  AND p.proname IN ('transaction_create','transaction_update',
                                                    'transaction_get_detail'))
       ) AS detail

UNION ALL

-- 2) Colunas deleted_at ainda NÃO existem (013 será o primeiro a adicioná-las)
SELECT 2 AS ord, 'stg_013_deleted_at_ausente' AS stage,
       CASE WHEN NOT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='transactions'
                 AND column_name='deleted_at')
             AND NOT EXISTS (
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

-- 3) transaction_audit CHECK não contém 'delete' ainda
SELECT 3 AS ord, 'stg_013_audit_check_sem_delete' AS stage,
       CASE WHEN (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                   WHERE conname='transaction_audit_action_check'
                     AND conrelid='public.transaction_audit'::regclass)
                  NOT LIKE '%delete%'
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'constraint_def', (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                               WHERE conname='transaction_audit_action_check'
                                 AND conrelid='public.transaction_audit'::regclass),
           'nota', 'CHECK deve conter apenas create e update; delete será adicionado pelo 013'
       ) AS detail

UNION ALL

-- 4) Função app.transaction_delete NÃO existe ainda
SELECT 4 AS ord, 'stg_013_delete_fn_ausente' AS stage,
       CASE WHEN NOT EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete')
             AND NOT EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'app_transaction_delete', EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'),
           'public_transaction_delete', EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete')
       ) AS detail

UNION ALL

-- 5) Policy transactions_select_own existente (do 012 ou anterior)
SELECT 5 AS ord, 'stg_013_select_policy_existe' AS stage,
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE schemaname='public' AND tablename='transactions'
                     AND policyname='transactions_select_own') = 1
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'transactions_select_own', (SELECT count(*) FROM pg_policies
                                        WHERE schemaname='public' AND tablename='transactions'
                                          AND policyname='transactions_select_own')
       ) AS detail

UNION ALL

-- 6) Grants de authenticated: wrappers CRUD 012 com EXECUTE, inserts/updates/deletes revogados
SELECT 6 AS ord, 'stg_013_grants_012' AS stage,
       CASE WHEN
         (SELECT count(*) FROM information_schema.role_routine_grants
           WHERE routine_schema='public'
             AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
             AND grantee='authenticated' AND privilege_type='EXECUTE') = 3
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'UPDATE')
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'DELETE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'exec_wrappers', (SELECT count(*) FROM information_schema.role_routine_grants
                              WHERE routine_schema='public'
                                AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
                                AND grantee='authenticated' AND privilege_type='EXECUTE'),
           'auth_insert', has_table_privilege('authenticated', 'public.transactions', 'INSERT'),
           'auth_update', has_table_privilege('authenticated', 'public.transactions', 'UPDATE'),
           'auth_delete', has_table_privilege('authenticated', 'public.transactions', 'DELETE')
       ) AS detail

UNION ALL

-- 7) Runtime: PostgreSQL ≥ 14, extensões, schemas
SELECT 7 AS ord, 'stg_runtime' AS stage,
       CASE WHEN split_part(current_setting('server_version'), '.', 1)::int >= 14
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'database', current_database(),
           'role', current_user,
           'server_version', current_setting('server_version'),
           'pgcrypto', (SELECT coalesce(extversion, 'AUSENTE') FROM pg_extension WHERE extname='pgcrypto'),
           'jwt_profile_id', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                               WHERE p.proname='jwt_profile_id' AND n.nspname='app')
       ) AS detail

) s
ORDER BY ord;
