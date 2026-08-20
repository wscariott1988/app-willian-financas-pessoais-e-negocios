-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_CLOUD_014_AUDIT_READONLY.sql
-- Pré-condições para aplicar 014_cloud_audit_profile_visibility.sql.
-- Uma única statement SELECT -> uma grade exportável.
-- SEM dados financeiros individuais e SEM credenciais.
-- ============================================================

SELECT * FROM (

-- 1) transaction_audit existe (013 aplicado)
SELECT 1 AS ord, 'stg_014_pre_ta_existe' AS stage,
       CASE WHEN to_regclass('public.transaction_audit') IS NOT NULL THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('transaction_audit', to_regclass('public.transaction_audit')) AS detail

UNION ALL

-- 2) category_assignment_audit existe
SELECT 2 AS ord, 'stg_014_pre_caa_existe' AS stage,
       CASE WHEN to_regclass('public.category_assignment_audit') IS NOT NULL THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object('category_assignment_audit', to_regclass('public.category_assignment_audit')) AS detail

UNION ALL

-- 3) CHECK de transaction_audit contém 'delete' (013 aplicado)
SELECT 3 AS ord, 'stg_014_pre_check_delete' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c
                          JOIN pg_class rel ON rel.oid = c.conrelid
                         WHERE rel.oid = 'public.transaction_audit'::regclass
                           AND c.conname = 'transaction_audit_action_check'
                           AND pg_get_constraintdef(c.oid) LIKE '%delete%')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'action_check', (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                             WHERE conname='transaction_audit_action_check'
                               AND conrelid='public.transaction_audit'::regclass)
       ) AS detail

UNION ALL

-- 4) profile_id AINDA NÃO existe em transaction_audit (014 não aplicado)
SELECT 4 AS ord, 'stg_014_pre_ta_sem_profile' AS stage,
       CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_schema='public' AND table_name='transaction_audit' AND column_name='profile_id')
            THEN 'PASS' ELSE 'JÁ_APLICADO' END AS status,
       jsonb_build_object('profile_id_em_ta', EXISTS (SELECT 1 FROM information_schema.columns
                                                       WHERE table_schema='public' AND table_name='transaction_audit' AND column_name='profile_id')) AS detail

UNION ALL

-- 5) profile_id AINDA NÃO existe em category_assignment_audit (014 não aplicado)
SELECT 5 AS ord, 'stg_014_pre_caa_sem_profile' AS stage,
       CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_schema='public' AND table_name='category_assignment_audit' AND column_name='profile_id')
            THEN 'PASS' ELSE 'JÁ_APLICADO' END AS status,
       jsonb_build_object('profile_id_em_caa', EXISTS (SELECT 1 FROM information_schema.columns
                                                       WHERE table_schema='public' AND table_name='category_assignment_audit' AND column_name='profile_id')) AS detail

UNION ALL

-- 6) Backfill viável: auditorias têm transação correspondente (FK garante; confirmação)
SELECT 6 AS ord, 'stg_014_pre_backfill_viable' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit a
                   WHERE NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = a.transaction_id)) = 0
             AND (SELECT count(*) FROM public.category_assignment_audit a
                   WHERE NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = a.transaction_id)) = 0
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'ta_orfas', (SELECT count(*)::int FROM public.transaction_audit a
                         WHERE NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = a.transaction_id)),
           'caa_orfas', (SELECT count(*)::int FROM public.category_assignment_audit a
                          WHERE NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = a.transaction_id))
       ) AS detail

UNION ALL

-- 7) Policies atuais em vigor (ta_select_own, audit_select_own)
SELECT 7 AS ord, 'stg_014_pre_policies_atuais' AS stage,
       CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_select_own')
             AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_select_own')
            THEN 'PASS' ELSE 'INFO' END AS status,
       jsonb_build_object(
           'ta_select_own_qual', (SELECT coalesce(qual,'') FROM pg_policies
                                   WHERE schemaname='public' AND tablename='transaction_audit' AND policyname='ta_select_own'),
           'audit_select_own_qual', (SELECT coalesce(qual,'') FROM pg_policies
                                      WHERE schemaname='public' AND tablename='category_assignment_audit' AND policyname='audit_select_own')
       ) AS detail

UNION ALL

-- 8) Existem transações soft-deletadas (contexto do problema)
SELECT 8 AS ord, 'stg_014_pre_soft_deleted' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transactions WHERE deleted_at IS NOT NULL) > 0 THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object('soft_deleted_count', (SELECT count(*)::int FROM public.transactions WHERE deleted_at IS NOT NULL)) AS detail

UNION ALL

-- 9) Existem eventos delete em transaction_audit (contexto)
SELECT 9 AS ord, 'stg_014_pre_delete_events' AS stage,
       CASE WHEN (SELECT count(*) FROM public.transaction_audit WHERE action='delete') > 0 THEN 'PASS' ELSE 'SEM_CASO' END AS status,
       jsonb_build_object('delete_audit_count', (SELECT count(*)::int FROM public.transaction_audit WHERE action='delete')) AS detail

UNION ALL

-- 10) Higiene de privilégios: anon/authenticated NÃO possuem CREATE em public/app
SELECT 10 AS ord, 'stg_014_pre_sem_create_schema' AS stage,
       CASE WHEN NOT has_schema_privilege('anon', 'public', 'CREATE')
             AND NOT has_schema_privilege('anon', 'app', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'public', 'CREATE')
             AND NOT has_schema_privilege('authenticated', 'app', 'CREATE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'anon_create_public', has_schema_privilege('anon', 'public', 'CREATE'),
           'anon_create_app', has_schema_privilege('anon', 'app', 'CREATE'),
           'auth_create_public', has_schema_privilege('authenticated', 'public', 'CREATE'),
           'auth_create_app', has_schema_privilege('authenticated', 'app', 'CREATE')
       ) AS detail

) s
ORDER BY ord;
