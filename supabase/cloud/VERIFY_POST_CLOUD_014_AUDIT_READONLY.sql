-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- VERIFY_POST_CLOUD_014_AUDIT_READONLY.sql
-- Verificação PÓS-aplicação do 014 (denormalização de profile_id).
-- Uma única statement SELECT -> uma grade exportável.
-- SEM dados financeiros individuais e SEM credenciais.
-- ============================================================

SELECT * FROM (

-- 1) profile_id presente e NOT NULL em ambas as tabelas
SELECT 1 AS ord, 'stg_014_ta_profile_notnull' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema='public' AND table_name='transaction_audit' AND column_name='profile_id' AND is_nullable='NO')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('ta_profile_notnull', EXISTS (SELECT 1 FROM information_schema.columns
                                                         WHERE table_schema='public' AND table_name='transaction_audit' AND column_name='profile_id' AND is_nullable='NO')) AS detail

UNION ALL

SELECT 2 AS ord, 'stg_014_caa_profile_notnull' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema='public' AND table_name='category_assignment_audit' AND column_name='profile_id' AND is_nullable='NO')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('caa_profile_notnull', EXISTS (SELECT 1 FROM information_schema.columns
                                                         WHERE table_schema='public' AND table_name='category_assignment_audit' AND column_name='profile_id' AND is_nullable='NO')) AS detail

UNION ALL

-- 2) Backfill: zero NULL e zero divergências
SELECT 3 AS ord, 'stg_014_backfill_consistente' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE profile_id IS NULL) = 0
             AND (SELECT count(*) FROM public.category_assignment_audit WHERE profile_id IS NULL) = 0
             AND (SELECT count(*) FROM public.transaction_audit a JOIN public.transactions t ON t.id=a.transaction_id
                   WHERE a.profile_id IS DISTINCT FROM t.profile_id) = 0
             AND (SELECT count(*) FROM public.category_assignment_audit a JOIN public.transactions t ON t.id=a.transaction_id
                   WHERE a.profile_id IS DISTINCT FROM t.profile_id) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'ta_nulls', (SELECT count(*)::int FROM public.transaction_audit WHERE profile_id IS NULL),
           'caa_nulls', (SELECT count(*)::int FROM public.category_assignment_audit WHERE profile_id IS NULL),
           'ta_divergencias', (SELECT count(*)::int FROM public.transaction_audit a JOIN public.transactions t ON t.id=a.transaction_id
                                WHERE a.profile_id IS DISTINCT FROM t.profile_id),
           'caa_divergencias', (SELECT count(*)::int FROM public.category_assignment_audit a JOIN public.transactions t ON t.id=a.transaction_id
                                 WHERE a.profile_id IS DISTINCT FROM t.profile_id)
       ) AS detail

UNION ALL

-- 3) FKs para profiles
SELECT 4 AS ord, 'stg_014_fk_profiles' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                          WHERE rel.oid='public.transaction_audit'::regclass AND c.conname='transaction_audit_profile_fk')
             AND EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                          WHERE rel.oid='public.category_assignment_audit'::regclass AND c.conname='category_assignment_audit_profile_fk')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'ta_fk', (SELECT c.conname FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                      WHERE rel.oid='public.transaction_audit'::regclass AND c.conname='transaction_audit_profile_fk'),
           'caa_fk', (SELECT c.conname FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
                       WHERE rel.oid='public.category_assignment_audit'::regclass AND c.conname='category_assignment_audit_profile_fk')
       ) AS detail

UNION ALL

-- 4) Índices (profile_id, created_at DESC)
SELECT 5 AS ord, 'stg_014_indices' AS stage,
       CASE WHEN to_regclass('public.idx_ta_profile_created') IS NOT NULL
             AND to_regclass('public.idx_caa_profile_created') IS NOT NULL
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'idx_ta_profile_created', to_regclass('public.idx_ta_profile_created'),
           'idx_caa_profile_created', to_regclass('public.idx_caa_profile_created')
       ) AS detail

UNION ALL

-- 5) ta_select_own usa profile_id direto (SEM subquery em transactions)
SELECT 6 AS ord, 'stg_014_ta_policy_direta' AS stage,
       CASE WHEN (SELECT position('transactions' in lower(coalesce(qual,'')))
                    FROM pg_policies
                   WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_select_own') = 0
             AND (SELECT position('profile_id' in lower(coalesce(qual,'')))
                    FROM pg_policies
                   WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_select_own') > 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('ta_select_own_qual', (SELECT coalesce(qual,'') FROM pg_policies
                                                 WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_select_own')) AS detail

UNION ALL

-- 6) audit_select_own usa profile_id direto (SEM subquery em transactions)
SELECT 7 AS ord, 'stg_014_caa_policy_direta' AS stage,
       CASE WHEN (SELECT position('transactions' in lower(coalesce(qual,'')))
                    FROM pg_policies
                   WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_select_own') = 0
             AND (SELECT position('profile_id' in lower(coalesce(qual,'')))
                    FROM pg_policies
                   WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_select_own') > 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('audit_select_own_qual', (SELECT coalesce(qual,'') FROM pg_policies
                                                    WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_select_own')) AS detail

UNION ALL

-- 7) Triggers presentes nas duas tabelas
SELECT 8 AS ord, 'stg_014_triggers' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.transaction_audit'::regclass AND tgname='trg_audit_profile_tx' AND NOT tgisinternal)
             AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.category_assignment_audit'::regclass AND tgname='trg_audit_profile_caa' AND NOT tgisinternal)
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'trg_ta', (SELECT tgname FROM pg_trigger WHERE tgrelid='public.transaction_audit'::regclass AND tgname='trg_audit_profile_tx' AND NOT tgisinternal),
           'trg_caa', (SELECT tgname FROM pg_trigger WHERE tgrelid='public.category_assignment_audit'::regclass AND tgname='trg_audit_profile_caa' AND NOT tgisinternal)
       ) AS detail

UNION ALL

-- 8) Função set_audit_profile_id SEM EXECUTE para anon/authenticated
SELECT 9 AS ord, 'stg_014_fn_sem_grant' AS stage,
       CASE WHEN NOT has_function_privilege('anon',
              (SELECT 'app.set_audit_profile_id()' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='app' AND p.proname='set_audit_profile_id'), 'EXECUTE')
             AND NOT has_function_privilege('authenticated',
              (SELECT 'app.set_audit_profile_id()' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='app' AND p.proname='set_audit_profile_id'), 'EXECUTE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'anon_exec', has_function_privilege('anon',
              (SELECT 'app.set_audit_profile_id()' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='app' AND p.proname='set_audit_profile_id'), 'EXECUTE'),
           'auth_exec', has_function_privilege('authenticated',
              (SELECT 'app.set_audit_profile_id()' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='app' AND p.proname='set_audit_profile_id'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 9) Eventos delete com profile_id preenchido (auditoria de soft-delete visível ao dono)
SELECT 10 AS ord, 'stg_014_delete_audit_com_perfil' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action='delete' AND profile_id IS NULL) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'delete_sem_perfil', (SELECT count(*)::int FROM public.transaction_audit WHERE action='delete' AND profile_id IS NULL),
           'delete_com_perfil', (SELECT count(*)::int FROM public.transaction_audit WHERE action='delete' AND profile_id IS NOT NULL)
       ) AS detail

UNION ALL

-- 10) Grants preservados (authenticated lê as duas)
SELECT 11 AS ord, 'stg_014_grants_preservados' AS stage,
       CASE WHEN has_table_privilege('authenticated', 'public.transaction_audit', 'SELECT')
             AND has_table_privilege('authenticated', 'public.category_assignment_audit', 'SELECT')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'auth_select_ta', has_table_privilege('authenticated', 'public.transaction_audit', 'SELECT'),
           'auth_select_caa', has_table_privilege('authenticated', 'public.category_assignment_audit', 'SELECT')
       ) AS detail

UNION ALL

-- 11) Policies de escrita preservadas (service_role apenas)
SELECT 12 AS ord, 'stg_014_write_policies' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_write_service')
             AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_write_service')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'ta_write_service', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_write_service'),
           'audit_write_service', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_write_service')
       ) AS detail

UNION ALL

-- 12b) Trigger: search_path fixo e seguro (pg_catalog, public, app, pg_temp)
SELECT 13 AS ord, 'stg_014_trigger_search_path' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='app' AND p.proname='set_audit_profile_id'
                            AND p.proconfig IS NOT NULL
                            AND 'search_path=pg_catalog, public, app, pg_temp' = ANY (p.proconfig))
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'proconfig', (SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='app' AND p.proname='set_audit_profile_id')
       ) AS detail

UNION ALL

-- 12c) Higiene pós: anon/authenticated continuam SEM CREATE em public/app
SELECT 14 AS ord, 'stg_014_sem_create_schema' AS stage,
       CASE WHEN NOT has_schema_privilege('anon', 'public', 'CREATE')
             AND NOT has_schema_privilege('anon', 'app', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'public', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'app', 'CREATE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'anon_create_public', has_schema_privilege('anon', 'public', 'CREATE'),
           'auth_create_app', has_schema_privilege('authenticated', 'app', 'CREATE')
       ) AS detail

) s
ORDER BY ord;
