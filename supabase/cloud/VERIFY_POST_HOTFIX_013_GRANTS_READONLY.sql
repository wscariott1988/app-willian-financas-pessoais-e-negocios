-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- VERIFY_POST_HOTFIX_013_GRANTS_READONLY.sql
-- Verificação PÓS-aplicação do hotfix de grants.
-- Uma única statement SELECT -> uma grade exportável.
-- Confirma que anon NÃO tem mais EXECUTE e authenticated preserva.
-- ============================================================

SELECT * FROM (

-- 1) anon NÃO tem EXECUTE em app.transaction_delete
SELECT 1 AS ord, 'stg_hotfix_anon_app_delete_revoked' AS stage,
       CASE WHEN NOT has_function_privilege('anon',
              (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'anon_exec_app_delete', has_function_privilege('anon',
             (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 2) anon NÃO tem EXECUTE em public.transaction_delete
SELECT 2 AS ord, 'stg_hotfix_anon_public_delete_revoked' AS stage,
       CASE WHEN NOT has_function_privilege('anon',
              (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'anon_exec_public_delete', has_function_privilege('anon',
             (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 3) PUBLIC NÃO tem EXECUTE em nenhuma das duas
SELECT 3 AS ord, 'stg_hotfix_public_revoked' AS stage,
       CASE WHEN NOT has_function_privilege('public',
              (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE')
              AND NOT has_function_privilege('public',
              (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
            THEN 'PASS' ELSE 'BLOCKED' END AS status,
       jsonb_build_object(
           'public_exec_app', has_function_privilege('public',
             (SELECT 'app.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='app' AND p.proname='transaction_delete'), 'EXECUTE'),
           'public_exec_public', has_function_privilege('public',
             (SELECT 'public.transaction_delete(' || oidvectortypes(p.proargtypes) || ')'
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='transaction_delete'), 'EXECUTE')
       ) AS detail

UNION ALL

-- 4) authenticated preserva EXECUTE em ambas
SELECT 4 AS ord, 'stg_hotfix_auth_preserved' AS stage,
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
