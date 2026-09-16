-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_CLOUD_023_CHAT_RLS_READONLY.sql
-- Pré-condições para 023_chat_persistence.sql (PESSOAL-13C2) no Supabase de
-- TESTE. Uma única statement SELECT -> uma grade exportável.
-- Sem dados financeiros individuais; sem credenciais; sem DDL.
-- ============================================================

SELECT * FROM (
    SELECT 1 AS ord, 'stg_023_nao_aplicado_ainda' AS stage,
           CASE WHEN to_regclass('public.chat_conversations') IS NULL
                 AND to_regclass('public.chat_messages') IS NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'chat_conversations', to_regclass('public.chat_conversations'),
               'chat_messages', to_regclass('public.chat_messages')
           ) AS detail
    UNION ALL

    SELECT 2 AS ord, 'stg_023_identidade_canonica_jwt_profile_id' AS stage,
           CASE WHEN to_regprocedure('app.jwt_profile_id()') IS NOT NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('jwt_profile_id', to_regprocedure('app.jwt_profile_id()')) AS detail
    UNION ALL

    SELECT 3 AS ord, 'stg_023_identidade_canonica_jwt_role' AS stage,
           CASE WHEN to_regprocedure('app.jwt_role()') IS NOT NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('jwt_role', to_regprocedure('app.jwt_role()')) AS detail
    UNION ALL

    SELECT 4 AS ord, 'stg_023_profiles_base' AS stage,
           CASE WHEN to_regclass('public.profiles') IS NOT NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('profiles', to_regclass('public.profiles')) AS detail
    UNION ALL

    SELECT 5 AS ord, 'stg_023_role_authenticated' AS stage,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('role', 'authenticated') AS detail
    UNION ALL

    SELECT 6 AS ord, 'stg_023_postgres_version' AS stage,
           CASE WHEN current_setting('server_version_num')::int >= 130000
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('server_version_num', current_setting('server_version_num')) AS detail
) relatorios
ORDER BY ord;