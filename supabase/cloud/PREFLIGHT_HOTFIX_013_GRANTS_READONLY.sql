-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_HOTFIX_013_GRANTS_READONLY.sql
-- Verificação PRÉ-aplicação do hotfix de grants.
-- Uma única statement SELECT -> uma grade exportável.
-- Confirma que o problema (anon com EXECUTE) existe antes de corrigir.
-- ============================================================

SELECT * FROM (

-- 1) anon tem EXECUTE em app.transaction_delete (BUG que o hotfix corrige)
SELECT 1 AS ord, 'stg_013_bug_anon_app_delete' AS stage,
       CASE WHEN has_function_privilege('anon',
              (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'BUG_CONFIRMED' ELSE 'JÁ_CORRIGIDO' END AS status,
       jsonb_build_object(
           'anon_exec_app_delete', has_function_privilege('anon',
             (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 2) anon tem EXECUTE em public.transaction_delete (BUG que o hotfix corrige)
SELECT 2 AS ord, 'stg_013_bug_anon_public_delete' AS stage,
       CASE WHEN has_function_privilege('anon',
              (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'BUG_CONFIRMED' ELSE 'JÁ_CORRIGIDO' END AS status,
       jsonb_build_object(
           'anon_exec_public_delete', has_function_privilege('anon',
             (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 3) authenticated tem EXECUTE em ambas (pré-condição: grant deve existir)
SELECT 3 AS ord, 'stg_013_auth_has_both' AS stage,
       CASE WHEN has_function_privilege('authenticated',
              (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
              AND has_function_privilege('authenticated',
              (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'auth_exec_app', has_function_privilege('authenticated',
             (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE'),
           'auth_exec_public', has_function_privilege('authenticated',
             (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

) s
ORDER BY ord;
