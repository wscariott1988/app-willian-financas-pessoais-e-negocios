-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- VERIFY_POST_CLOUD_009_012_READONLY.sql
-- Verificação APÓS a aplicação do pacote Cloud 009-012.
-- UMA única statement SELECT -> UMA grade exportável:
--   ord | stage | status (PASS/BLOCKED) | detail (jsonb)
-- Não escreve nada. Se qualquer etapa der BLOCKED, NÃO prosseguir.
-- ============================================================

SELECT * FROM (

SELECT 1 AS ord, 'stg_009_isolamento_final' AS stage,
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE schemaname='public' AND tablename='categories'
                     AND policyname='categories_select_auth') = 0
             AND (SELECT count(*) FROM pg_policies
                   WHERE schemaname='public' AND tablename='categories'
                     AND policyname='categories_select_own') = 1
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'ampla_existe', (SELECT count(*) FROM pg_policies
                             WHERE schemaname='public' AND tablename='categories'
                               AND policyname='categories_select_auth'),
           'isolada_existe', (SELECT count(*) FROM pg_policies
                               WHERE schemaname='public' AND tablename='categories'
                                 AND policyname='categories_select_own')
       ) AS detail

UNION ALL

SELECT 2 AS ord, 'stg_010_final' AS stage,
       CASE WHEN
         (SELECT count(*) FROM categories
           WHERE id='30000000-0000-4000-8000-000000000009'
             AND parent_id IS NULL AND status='active') = 1
         AND (SELECT count(*) FROM categories
               WHERE id='1b1911d6-2c15-503a-95da-f859f33af83c'
                 AND parent_id='30000000-0000-4000-8000-000000000009'
                 AND canonical_path='Marketing e publicidade > Ads') = 1
         AND (SELECT count(*) FROM transactions
               WHERE id IN ('15e6da49-7d1f-5ae4-a936-f099a148cf6d',
                            '38886977-8e8e-5c32-b8e8-6f2ec67edea5',
                            'd0b03c47-a82f-57a7-a368-2e123af90d93')
                 AND profile_id=(SELECT id FROM profiles WHERE code='business')
                 AND category_id='1b1911d6-2c15-503a-95da-f859f33af83c') = 3
         AND (SELECT count(*) FROM category_assignment_audit
               WHERE reason='cloud_010:owner_decision:inter_pj_ads'
                 AND assigned_by IS NULL
                 AND transaction_id IN ('15e6da49-7d1f-5ae4-a936-f099a148cf6d',
                                        '38886977-8e8e-5c32-b8e8-6f2ec67edea5',
                                         'd0b03c47-a82f-57a7-a368-2e123af90d93')) = 3
         AND NOT EXISTS (SELECT 1 FROM transactions t
                          JOIN categories c ON c.id = t.category_id
                          WHERE t.profile_id <> c.profile_id)
        THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'raiz_marketing', (SELECT count(*) FROM categories
                               WHERE id='30000000-0000-4000-8000-000000000009'
                                 AND parent_id IS NULL AND status='active'),
           'ads_reparentada', (SELECT count(*) FROM categories
                                WHERE id='1b1911d6-2c15-503a-95da-f859f33af83c'
                                  AND parent_id='30000000-0000-4000-8000-000000000009'),
           'interpj_no_negocio_ads', (SELECT count(*) FROM transactions
                                       WHERE id IN ('15e6da49-7d1f-5ae4-a936-f099a148cf6d',
                                                    '38886977-8e8e-5c32-b8e8-6f2ec67edea5',
                                                    'd0b03c47-a82f-57a7-a368-2e123af90d93')
                                         AND profile_id=(SELECT id FROM profiles WHERE code='business')
                                         AND category_id='1b1911d6-2c15-503a-95da-f859f33af83c'),
           'auditorias_cloud_010', (SELECT count(*) FROM category_assignment_audit
                                     WHERE reason='cloud_010:owner_decision:inter_pj_ads'
                                       AND assigned_by IS NULL),
           'cruzamento_perfil_categoria', (SELECT count(*) FROM transactions t
                                            JOIN categories c ON c.id = t.category_id
                                            WHERE t.profile_id <> c.profile_id)
       ) AS detail

UNION ALL

SELECT 3 AS ord, 'stg_011_final' AS stage,
       CASE WHEN
         (SELECT count(*) FROM transactions
           WHERE category_id='66d5335d-7078-5601-bfbf-c22a5b908f65'
             AND transaction_kind='income') = 100
         AND (SELECT sum(amount) FROM transactions
               WHERE category_id='66d5335d-7078-5601-bfbf-c22a5b908f65') = 326876.52
         AND (SELECT count(*) FROM reclassification_queue
               WHERE reason='RP-MAL-01' AND status='open'
                 AND transaction_id IN ('200d4021-7608-584f-95f4-80818ffa3d79',
                                        'f487c210-6b56-54e9-9cd6-81e25d4c55a8',
                                        'a8fc5c7f-c535-510d-b605-05a9a181eb88',
                                        '49a99caa-d40c-54cf-9f54-2d15d6add75a',
                                        '085d12fb-bee6-5af6-81cb-6352bf0da1d2',
                                        '9eecfb5c-eafa-5724-acc7-fd5f694b75e5',
                                        'f2548e41-90b3-5d43-b568-9ac384b35a67',
                                        '3b602d81-cabd-557f-997c-068454fbf79d',
                                        '407b3714-6d0b-54bf-a688-12ea942b2e12',
                                        '82ad310f-dc2c-5a7b-816c-6026ce9ca67b',
                                        'f5196895-11a3-5c2c-bc5e-74ac7628d5fb',
                                        '2e0ef25c-3c4b-5df8-9b8f-b93f3d930f7d',
                                        '9763c1dd-3318-5172-a33d-27f95c0e45af',
                                        'f44b2716-e09b-5e0c-8655-e2f086f43a8a',
                                        '15ec577d-3ef8-5830-8276-b4b90cd4fe38',
                                        '857c901f-6f27-5549-b5a6-7e18f66fa523',
                                        'ce00a816-3cd5-5487-a905-be112e375006',
                                        '4961c793-809c-53a8-9608-11471350a116',
                                        '67af7444-d110-5aec-8b26-0290523ff096')) = 0
         AND (SELECT count(*) FROM category_assignment_audit
               WHERE reason='cloud_011:manual_decision:RECEITA_PESSOAL'
                 AND assigned_by IS NULL) = 100
         AND NOT EXISTS (SELECT 1 FROM transactions t
                          JOIN categories c ON c.id = t.category_id
                          WHERE t.profile_id <> c.profile_id)
        THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'na_destino_income', (SELECT count(*) FROM transactions
                                  WHERE category_id='66d5335d-7078-5601-bfbf-c22a5b908f65'
                                    AND transaction_kind='income'),
           'soma_destino', (SELECT sum(amount) FROM transactions
                             WHERE category_id='66d5335d-7078-5601-bfbf-c22a5b908f65'),
           'filas_rp_mal_open_do_conjunto', (SELECT count(*) FROM reclassification_queue
                                              WHERE reason='RP-MAL-01' AND status='open'
                                                AND transaction_id IN ('200d4021-7608-584f-95f4-80818ffa3d79',
                                                                       'f487c210-6b56-54e9-9cd6-81e25d4c55a8',
                                                                       'a8fc5c7f-c535-510d-b605-05a9a181eb88',
                                                                       '49a99caa-d40c-54cf-9f54-2d15d6add75a',
                                                                       '085d12fb-bee6-5af6-81cb-6352bf0da1d2',
                                                                       '9eecfb5c-eafa-5724-acc7-fd5f694b75e5',
                                                                       'f2548e41-90b3-5d43-b568-9ac384b35a67',
                                                                       '3b602d81-cabd-557f-997c-068454fbf79d',
                                                                       '407b3714-6d0b-54bf-a688-12ea942b2e12',
                                                                       '82ad310f-dc2c-5a7b-816c-6026ce9ca67b',
                                                                       'f5196895-11a3-5c2c-bc5e-74ac7628d5fb',
                                                                       '2e0ef25c-3c4b-5df8-9b8f-b93f3d930f7d',
                                                                       '9763c1dd-3318-5172-a33d-27f95c0e45af',
                                                                       'f44b2716-e09b-5e0c-8655-e2f086f43a8a',
                                                                       '15ec577d-3ef8-5830-8276-b4b90cd4fe38',
                                                                       '857c901f-6f27-5549-b5a6-7e18f66fa523',
                                                                       'ce00a816-3cd5-5487-a905-be112e375006',
                                                                       '4961c793-809c-53a8-9608-11471350a116',
                                                                       '67af7444-d110-5aec-8b26-0290523ff096')),
           'auditorias_cloud_011', (SELECT count(*) FROM category_assignment_audit
                                     WHERE reason='cloud_011:manual_decision:RECEITA_PESSOAL'
                                       AND assigned_by IS NULL),
           'cruzamento_perfil_categoria', (SELECT count(*) FROM transactions t
                                            JOIN categories c ON c.id = t.category_id
                                            WHERE t.profile_id <> c.profile_id)
       ) AS detail

UNION ALL

SELECT 4 AS ord, 'stg_012_objetos' AS stage,
       CASE WHEN to_regclass('public.transaction_audit') IS NOT NULL
             AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='app'
                     AND p.proname IN ('normalize_description','tx_state_jsonb',
                                       'assert_account_for_profile','resolve_category_for_profile',
                                       'close_queue_item','close_all_open_queue',
                                       'transaction_create','transaction_update',
                                       'transaction_get_detail')) = 9
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
           'rls_ta', (SELECT c.relrowsecurity FROM pg_class c
                       JOIN pg_namespace n ON n.oid=c.relnamespace
                      WHERE n.nspname='public' AND c.relname='transaction_audit')
       ) AS detail

UNION ALL

SELECT 5 AS ord, 'stg_012_wrappers' AS stage,
       CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname='transaction_create') = 1
             AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname='transaction_update') = 1
             AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname='transaction_get_detail') = 1
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'transaction_create', (SELECT pg_get_function_identity_arguments(p.oid)
                                    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                   WHERE n.nspname='public' AND p.proname='transaction_create'),
           'transaction_update', (SELECT pg_get_function_identity_arguments(p.oid)
                                    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                   WHERE n.nspname='public' AND p.proname='transaction_update'),
           'transaction_get_detail', (SELECT pg_get_function_identity_arguments(p.oid)
                                        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                       WHERE n.nspname='public' AND p.proname='transaction_get_detail')
       ) AS detail

UNION ALL

SELECT 6 AS ord, 'stg_grants' AS stage,
       CASE WHEN
         (SELECT count(*) FROM information_schema.role_routine_grants
           WHERE routine_schema='public'
             AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
             AND grantee='authenticated' AND privilege_type='EXECUTE') = 3
         AND NOT EXISTS (SELECT 1 FROM information_schema.role_routine_grants
                          WHERE routine_schema='public'
                            AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
                            AND grantee='PUBLIC')
         AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='public'
                            AND p.proname IN ('transaction_create','transaction_update','transaction_get_detail')
                            AND has_function_privilege('anon', p.oid, 'EXECUTE'))
         AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='app'
                            AND p.proname IN ('normalize_description','tx_state_jsonb',
                                              'assert_account_for_profile','resolve_category_for_profile',
                                              'close_queue_item','close_all_open_queue')
                            AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'INSERT')
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'UPDATE')
         AND NOT has_table_privilege('authenticated', 'public.transactions', 'DELETE')
        THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'exec_authenticated_wrappers', (SELECT count(*) FROM information_schema.role_routine_grants
                                            WHERE routine_schema='public'
                                              AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
                                              AND grantee='authenticated' AND privilege_type='EXECUTE'),
           'exec_public_revogado', (SELECT count(*) FROM information_schema.role_routine_grants
                                     WHERE routine_schema='public'
                                       AND routine_name IN ('transaction_create','transaction_update','transaction_get_detail')
                                       AND grantee='PUBLIC'),
           'helpers_app_exec_authenticated', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                               WHERE n.nspname='app'
                                                 AND p.proname IN ('normalize_description','tx_state_jsonb',
                                                                   'assert_account_for_profile','resolve_category_for_profile',
                                                                   'close_queue_item','close_all_open_queue')
                                                 AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
           'anon_exec_wrappers', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                    WHERE n.nspname='public'
                                      AND p.proname IN ('transaction_create','transaction_update','transaction_get_detail')
                                      AND has_function_privilege('anon', p.oid, 'EXECUTE')),
           'auth_insert', has_table_privilege('authenticated', 'public.transactions', 'INSERT'),
           'auth_update', has_table_privilege('authenticated', 'public.transactions', 'UPDATE'),
           'auth_delete', has_table_privilege('authenticated', 'public.transactions', 'DELETE')
       ) AS detail

UNION ALL

SELECT 7 AS ord, 'stg_postgrest' AS stage,
       CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public'
                     AND p.proname IN ('transaction_create','transaction_update','transaction_get_detail')
                     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 3
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'funcoes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'schema', n.nspname, 'function', p.proname,
                          'args', pg_get_function_identity_arguments(p.oid),
                          'anon_exec', has_function_privilege('anon', p.oid, 'EXECUTE'),
                          'auth_exec', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                          'service_exec', CASE WHEN to_regrole('service_role') IS NULL THEN NULL
                                               ELSE has_function_privilege('service_role', p.oid, 'EXECUTE') END)
                          ORDER BY n.nspname, p.proname), '[]'::jsonb)
                        FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE p.proname IN ('transaction_create','transaction_update','transaction_get_detail')
                         AND n.nspname IN ('public','app'))
       ) AS detail

UNION ALL

SELECT 8 AS ord, 'stg_integridade' AS stage,
       CASE WHEN
         (SELECT count(*) FROM transaction_audit) =
         (SELECT count(DISTINCT id) FROM transaction_audit)
         AND NOT EXISTS (SELECT 1 FROM transactions t
                          JOIN categories c ON c.id = t.category_id
                          WHERE t.profile_id <> c.profile_id)
         AND (SELECT count(*) FROM transaction_audit a
               LEFT JOIN transactions t ON t.id = a.transaction_id
               WHERE t.id IS NULL) = 0
        THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'audit_rows', (SELECT count(*) FROM transaction_audit),
           'audit_ids_distintos', (SELECT count(DISTINCT id) FROM transaction_audit),
           'audit_orfas', (SELECT count(*) FROM transaction_audit a
                            LEFT JOIN transactions t ON t.id = a.transaction_id
                            WHERE t.id IS NULL),
           'cruzamento_perfil_categoria', (SELECT count(*) FROM transactions t
                                            JOIN categories c ON c.id = t.category_id
                                            WHERE t.profile_id <> c.profile_id)
       ) AS detail

UNION ALL

SELECT 9 AS ord, 'stg_schema_create' AS stage,
       CASE WHEN NOT has_schema_privilege('anon', 'public', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'public', 'CREATE')
             AND NOT has_schema_privilege('anon', 'app', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'app', 'CREATE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'anon_create_public', has_schema_privilege('anon', 'public', 'CREATE'),
           'authenticated_create_public', has_schema_privilege('authenticated', 'public', 'CREATE'),
           'anon_create_app', has_schema_privilege('anon', 'app', 'CREATE'),
           'authenticated_create_app', has_schema_privilege('authenticated', 'app', 'CREATE'),
           'nota', 'sem CREATE nao ha como criar objetos maliciosos em schemas do search_path; a 012 ainda qualifica tudo (defesa em profundidade)'
       ) AS detail

) s
ORDER BY ord;
