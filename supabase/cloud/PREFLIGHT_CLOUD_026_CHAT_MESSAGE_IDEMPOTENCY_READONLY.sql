-- READ-ONLY: este arquivo não contém DDL, DML ou chamadas de RPC.
-- ============================================================
-- PREFLIGHT_CLOUD_026_CHAT_MESSAGE_IDEMPOTENCY_READONLY.sql
-- Pré-condições para 026_chat_message_idempotency_role.sql (PESSOAL-13C2B.3)
-- no Supabase de TESTE. Uma única statement SELECT -> uma grade exportável.
-- Sem dados financeiros individuais; sem credenciais; sem DDL.
--
-- Contrato:
--   - stg_026_tabelas_chat            -> PASS quando as duas tabelas do chat
--                                         existem;
--   - stg_026_indice_anterior_ou_ja_aplicado -> PASS quando o índice antigo
--         de duas colunas (sem role) ainda está presente (estado antes da
--         aplicação) OU quando o índice novo já existe com a definição final
--         correta (estado JA_APLICADO); BLOCKED em qualquer outra combinação;
--   - stg_026_dependencias            -> PASS com profiles, app.jwt_profile_id(),
--                                         app.jwt_role() e role authenticated;
--   - stg_026_postgres_version        -> PASS com PostgreSQL >= 13.
-- ============================================================

SELECT * FROM (
    SELECT 1 AS ord, 'stg_026_tabelas_chat' AS stage,
           CASE WHEN to_regclass('public.chat_conversations') IS NOT NULL
                 AND to_regclass('public.chat_messages') IS NOT NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'chat_conversations', to_regclass('public.chat_conversations'),
               'chat_messages', to_regclass('public.chat_messages')
           ) AS detail
    UNION ALL

    SELECT 2 AS ord, 'stg_026_indice_anterior_ou_ja_aplicado' AS stage,
           CASE WHEN (
                     -- Estado ANTES da aplicação: índice antigo (2 colunas, sem role).
                     EXISTS (
                         SELECT 1
                           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                          WHERE c.relname = 'uq_chat_messages_conversation_client_request'
                            AND i.indrelid = 'public.chat_messages'::regclass
                            AND i.indnkeyatts = 2
                            AND NOT EXISTS (
                                SELECT 1
                                  FROM generate_series(0, i.indnkeyatts - 1) g
                                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                                 WHERE a.attname = 'role'
                            )
                     )
                     OR
                     -- Estado JA_APLICADO: índice novo com a definição final correta.
                     EXISTS (
                         SELECT 1
                           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                          WHERE c.relname = 'uq_chat_messages_conversation_client_request_role'
                            AND i.indrelid = 'public.chat_messages'::regclass
                            AND i.indisunique
                            AND i.indnkeyatts = 3
                            AND (SELECT string_agg(a.attname, ',' ORDER BY g)
                                   FROM generate_series(0, i.indnkeyatts - 1) g
                                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                                  WHERE a.attrelid = i.indrelid) = 'conversation_id,client_request_id,role'
                     )
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'indice_anterior_presente', EXISTS (
                   SELECT 1
                     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE c.relname = 'uq_chat_messages_conversation_client_request'
                      AND i.indrelid = 'public.chat_messages'::regclass
               ),
               'indice_novo_correto', EXISTS (
                   SELECT 1
                     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE c.relname = 'uq_chat_messages_conversation_client_request_role'
                      AND i.indrelid = 'public.chat_messages'::regclass
                      AND i.indisunique
                      AND i.indnkeyatts = 3
                      AND (SELECT string_agg(a.attname, ',' ORDER BY g)
                             FROM generate_series(0, i.indnkeyatts - 1) g
                             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                            WHERE a.attrelid = i.indrelid) = 'conversation_id,client_request_id,role'
               ),
               'indices_presentes', (SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
                                       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                                      WHERE i.indrelid = 'public.chat_messages'::regclass)
           ) AS detail
    UNION ALL

    SELECT 3 AS ord, 'stg_026_dependencias' AS stage,
           CASE WHEN to_regclass('public.profiles') IS NOT NULL
                 AND to_regprocedure('app.jwt_profile_id()') IS NOT NULL
                 AND to_regprocedure('app.jwt_role()') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'profiles', to_regclass('public.profiles'),
               'jwt_profile_id', to_regprocedure('app.jwt_profile_id()'),
               'jwt_role', to_regprocedure('app.jwt_role()'),
               'role_authenticated', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
           ) AS detail
    UNION ALL

    SELECT 4 AS ord, 'stg_026_postgres_version' AS stage,
           CASE WHEN current_setting('server_version_num')::int >= 130000
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('server_version_num', current_setting('server_version_num')) AS detail
) relatorios_preflight
ORDER BY ord;