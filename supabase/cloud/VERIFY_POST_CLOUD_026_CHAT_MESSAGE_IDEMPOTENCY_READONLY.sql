-- READ-ONLY: este arquivo NÃO contém DDL, DML persistente ou chamadas de RPC
-- externas. A Parte B roda em uma transação que termina em ROLLBACK e usa
-- dados 100% sintéticos, sem imprimir UUID reais, e-mails ou valores
-- financeiros.
-- ============================================================
-- VERIFY_POST_CLOUD_026_CHAT_MESSAGE_IDEMPOTENCY_READONLY.sql
-- VERIFICADOR FINAL da idempotência user+assistant por tentativa
-- (PESSOAL-13C2B.3) no Supabase de TESTE, após aplicar o 026.
--
--   PARTE A — ESTRUTURA + ÍNDICE + RLS + POLICIES + ACL + CASCADE (catálogo):
--             grade exportável PASS/BLOCKED que prova que o índice antigo de
--             DUAS colunas desapareceu e que o índice final é UNIQUE com
--             (conversation_id, client_request_id, role) na ordem exata;
--             RLS/policies/grants/cascade das migrations 023-025 intactas.
--   PARTE B — COMPORTAMENTO (RLS real + ACL + índice real), dentro de
--             BEGIN/ROLLBACK, com request.jwt.claims simulados e SET LOCAL
--             ROLE authenticated:
--               * user e assistant COEXISTEM com o MESMO client_request_id;
--               * reenvio da user NÃO cria duplicata (ON CONFLICT DO NOTHING
--                 retorna 0 linhas e a inferência do alvo prova o índice de 3
--                 colunas — com o índice antigo de 2 colunas o alvo nem seria
--                 inferido, levantando 42P10);
--               * segunda assistant IDÊNTICA levanta EXATAMENTE 23505;
--               * isolamento entre perfis continua (0 linhas cruzadas; INSERT
--                 cruzado em 42501);
--               * cascade de DELETE da própria conversa preservado; anon sem
--                 acesso (42501).
--
-- PESSOAL-13C2A.2: os helpers canônicos (app.jwt_profile_id/app.jwt_role)
-- são exercidos APENAS pela RLS (comportamento real de produção). A
-- existência deles é verificada SOMENTE pelo CATÁLOGO (to_regprocedure) na
-- PARTE A e na guarda da PARTE B, sempre na SESSÃO ADMINISTRATIVA, antes de
-- qualquer troca de role — nunca por chamada direta sob authenticated/anon.
--
-- Erros esperados de permissão/unicidade só contam como bloqueio quando o
-- SQLSTATE é EXATAMENTE o esperado (42501; 23505); qualquer outro erro é
-- relançado.
-- ============================================================

-- ============================================================
-- PARTE A — VERIFICAÇÃO ESTRUTURAL, DE ÍNDICE, RLS, POLICIES, ACL E CASCADE
-- ============================================================
SELECT * FROM (
    SELECT 1 AS ord, 'A_estrutura_tabelas' AS stage,
           CASE WHEN to_regclass('public.chat_conversations') IS NOT NULL
                 AND to_regclass('public.chat_messages') IS NOT NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'chat_conversations', to_regclass('public.chat_conversations'),
               'chat_messages', to_regclass('public.chat_messages')
           ) AS detail
    UNION ALL

    SELECT 2 AS ord, 'A_estrutura_dependencias_base' AS stage,
           CASE WHEN to_regclass('public.profiles') IS NOT NULL
                 AND to_regprocedure('app.jwt_profile_id()') IS NOT NULL
                 AND to_regprocedure('app.jwt_role()') IS NOT NULL
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'profiles', to_regclass('public.profiles'),
               'jwt_profile_id', to_regprocedure('app.jwt_profile_id()'),
               'jwt_role', to_regprocedure('app.jwt_role()')
           ) AS detail
    UNION ALL

    SELECT 3 AS ord, 'A_estrutura_colunas_conversations' AS stage,
           CASE WHEN (SELECT count(*) FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='chat_conversations'
                          AND column_name IN ('id','profile_id','title','context','created_at','updated_at','last_message_at')) = 7
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('colunas', (SELECT string_agg(column_name, ',')
                                            FROM information_schema.columns
                                           WHERE table_schema='public' AND table_name='chat_conversations')) AS detail
    UNION ALL

    SELECT 4 AS ord, 'A_estrutura_colunas_messages' AS stage,
           CASE WHEN (SELECT count(*) FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='chat_messages'
                          AND column_name IN ('id','conversation_id','role','status','content','payload','intent','engine','period_analyzed','client_request_id','error','created_at')) = 12
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('colunas', (SELECT string_agg(column_name, ',')
                                            FROM information_schema.columns
                                           WHERE table_schema='public' AND table_name='chat_messages')) AS detail
    UNION ALL

    SELECT 5 AS ord, 'A_rls_habilitada_ambas' AS stage,
           CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_conversations'::regclass)
                 AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_messages'::regclass)
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'chat_conversations_rls', (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_conversations'::regclass),
               'chat_messages_rls', (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_messages'::regclass)
           ) AS detail
    UNION ALL

    SELECT 6 AS ord, 'A_politicas_own_profile' AS stage,
           CASE WHEN (SELECT count(*) FROM pg_policies
                        WHERE schemaname='public' AND tablename='chat_conversations'
                          AND (qual::text LIKE '%app%jwt_profile_id%' OR with_check::text LIKE '%app%jwt_profile_id%')) >= 1
                 AND (SELECT count(*) FROM pg_policies
                        WHERE schemaname='public' AND tablename='chat_messages'
                          AND (qual::text LIKE '%chat_conversations%' OR with_check::text LIKE '%chat_conversations%')) >= 1
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversations_usa_jwt_profile_id', (SELECT count(*) FROM pg_policies
                                                      WHERE schemaname='public' AND tablename='chat_conversations'
                                                        AND (qual::text LIKE '%app%jwt_profile_id%' OR with_check::text LIKE '%app%jwt_profile_id%')),
               'messages_usa_conversation_own', (SELECT count(*) FROM pg_policies
                                                    WHERE schemaname='public' AND tablename='chat_messages'
                                                      AND (qual::text LIKE '%chat_conversations%' OR with_check::text LIKE '%chat_conversations%'))
           ) AS detail
    UNION ALL

    SELECT 7 AS ord, 'A_politicas_por_comando' AS stage,
           CASE WHEN (SELECT count(*) FROM pg_policies
                        WHERE schemaname='public' AND tablename='chat_conversations'
                          AND cmd IN ('SELECT','INSERT','UPDATE','DELETE')) = 4
                 AND (SELECT count(*) FROM pg_policies
                        WHERE schemaname='public' AND tablename='chat_messages'
                          AND cmd IN ('SELECT','INSERT','UPDATE')) = 3
                 AND (SELECT count(*) FROM pg_policies
                        WHERE schemaname='public' AND tablename='chat_messages'
                          AND cmd = 'DELETE') = 0
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversations', (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies
                                  WHERE schemaname='public' AND tablename='chat_conversations'),
               'messages', (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies
                             WHERE schemaname='public' AND tablename='chat_messages')
           ) AS detail
    UNION ALL

    SELECT 8 AS ord, 'A_sem_policy_delete_em_mensagens' AS stage,
           CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies
                                  WHERE schemaname='public' AND tablename='chat_messages'
                                    AND (cmd = 'DELETE' OR policyname = 'chat_messages_delete_own'))
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'policies_delete_em_messages', (SELECT coalesce(string_agg(policyname || ':' || cmd, ','), '')
                                                 FROM pg_policies
                                                WHERE schemaname='public' AND tablename='chat_messages'
                                                  AND (cmd = 'DELETE' OR policyname = 'chat_messages_delete_own'))
           ) AS detail
    UNION ALL

    SELECT 9 AS ord, 'A_constraints_por_nome_estavel' AS stage,
           CASE WHEN (SELECT count(*) FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
                        WHERE rel.oid IN ('public.chat_conversations'::regclass, 'public.chat_messages'::regclass)
                          AND c.conname IN
                              ('chat_conversations_pkey',
                               'chat_conversations_profile_id_fkey',
                               'chat_conversations_title_length',
                               'chat_conversations_context_size',
                               'chat_messages_pkey',
                               'chat_messages_conversation_id_fkey',
                               'chat_messages_role_check',
                               'chat_messages_status_check',
                               'chat_messages_content_check',
                               'chat_messages_engine_check',
                               'chat_messages_client_request_id_check',
                               'chat_messages_response_payload',
                               'chat_messages_payload_size')) = 13
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('constraints_esperadas', 13) AS detail
    UNION ALL

    -- ÍNDICE ANTIGO (duas colunas, SEM role) deve estar ausente — por nome E
    -- por definição (nenhum UNIQUE de 2 colunas (conversation_id,
    -- client_request_id) restante sob qualquer nome).
    SELECT 10 AS ord, 'A_indice_antigo_ausente' AS stage,
           CASE WHEN NOT EXISTS (SELECT 1 FROM pg_indexes
                                  WHERE schemaname='public' AND tablename='chat_messages'
                                    AND indexname='uq_chat_messages_conversation_client_request')
                 AND NOT EXISTS (
                     SELECT 1
                       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                      WHERE i.indrelid = 'public.chat_messages'::regclass
                        AND i.indisunique
                        AND i.indnkeyatts = 2
                        AND (SELECT string_agg(a.attname, ',' ORDER BY g)
                               FROM generate_series(0, i.indnkeyatts - 1) g
                               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                              WHERE a.attrelid = i.indrelid) = 'conversation_id,client_request_id'
                 )
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'indice_antigo_por_nome', EXISTS (SELECT 1 FROM pg_indexes
                                                  WHERE schemaname='public' AND tablename='chat_messages'
                                                    AND indexname='uq_chat_messages_conversation_client_request'),
               'indice_2_colunas_qualquer_nome', EXISTS (
                   SELECT 1
                     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE i.indrelid = 'public.chat_messages'::regclass
                      AND i.indisunique
                      AND i.indnkeyatts = 2
                      AND (SELECT string_agg(a.attname, ',' ORDER BY g)
                             FROM generate_series(0, i.indnkeyatts - 1) g
                             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                            WHERE a.attrelid = i.indrelid) = 'conversation_id,client_request_id'
               )
           ) AS detail
    UNION ALL

    -- ÍNDICE FINAL: UNIQUE com as TRÊS colunas (conversation_id,
    -- client_request_id, role) na ordem EXATA.
    SELECT 11 AS ord, 'A_indice_novo_unique_ordem' AS stage,
           CASE WHEN EXISTS (
                     SELECT 1
                       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                      WHERE c.relname = 'uq_chat_messages_conversation_client_request_role'
                        AND i.indrelid = 'public.chat_messages'::regclass
                        AND i.indisunique
                        AND i.indnkeyatts = 3
                        AND (SELECT string_agg(a.attname, ',' ORDER BY g)
                               FROM generate_series(0, i.indnkeyatts - 1) g
                               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                              WHERE a.attrelid = i.indrelid)
                            = 'conversation_id,client_request_id,role'
                 )
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'existe', to_regclass('public.uq_chat_messages_conversation_client_request_role'),
               'unique', EXISTS (
                   SELECT 1
                     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE c.relname = 'uq_chat_messages_conversation_client_request_role'
                      AND i.indrelid = 'public.chat_messages'::regclass
                      AND i.indisunique),
               'colunas_ordem', (SELECT coalesce(string_agg(a.attname, ',' ORDER BY g), '')
                                   FROM pg_index i
                                   JOIN pg_class c ON c.oid = i.indexrelid
                                   JOIN LATERAL generate_series(0, i.indnkeyatts - 1) g ON true
                                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
                                  WHERE c.relname = 'uq_chat_messages_conversation_client_request_role'
                                    AND i.indrelid = 'public.chat_messages'::regclass)
           ) AS detail
    UNION ALL

    SELECT 12 AS ord, 'A_indices_aux_preservados' AS stage,
           CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_conversations' AND indexname='idx_chat_conversations_profile_last')
                 AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_messages' AND indexname='idx_chat_messages_conversation_created')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('indices', (SELECT string_agg(indexname, ',') FROM pg_indexes
                                            WHERE schemaname='public' AND (tablename='chat_conversations' OR tablename='chat_messages'))) AS detail
    UNION ALL

    SELECT 13 AS ord, 'A_cascata_mensagens' AS stage,
           CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
                              WHERE rel.oid = 'public.chat_messages'::regclass
                                AND c.conname = 'chat_messages_conversation_id_fkey'
                                AND c.contype = 'f'
                                AND c.confdeltype = 'c')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversas_delete_cascade', (SELECT confdeltype FROM pg_constraint c WHERE c.conname = 'chat_messages_conversation_id_fkey')
           ) AS detail
    UNION ALL

    SELECT 14 AS ord, 'A_acl_authenticated_conversations' AS stage,
           CASE WHEN has_table_privilege('authenticated', 'public.chat_conversations', 'SELECT')
                 AND has_table_privilege('authenticated', 'public.chat_conversations', 'INSERT')
                 AND has_table_privilege('authenticated', 'public.chat_conversations', 'UPDATE')
                 AND has_table_privilege('authenticated', 'public.chat_conversations', 'DELETE')
                 AND NOT has_table_privilege('authenticated', 'public.chat_conversations', 'TRUNCATE')
                 AND NOT has_table_privilege('authenticated', 'public.chat_conversations', 'REFERENCES')
                 AND NOT has_table_privilege('authenticated', 'public.chat_conversations', 'TRIGGER')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'select', has_table_privilege('authenticated', 'public.chat_conversations', 'SELECT'),
               'insert', has_table_privilege('authenticated', 'public.chat_conversations', 'INSERT'),
               'update', has_table_privilege('authenticated', 'public.chat_conversations', 'UPDATE'),
               'delete', has_table_privilege('authenticated', 'public.chat_conversations', 'DELETE'),
               'truncate', has_table_privilege('authenticated', 'public.chat_conversations', 'TRUNCATE'),
               'references', has_table_privilege('authenticated', 'public.chat_conversations', 'REFERENCES'),
               'trigger', has_table_privilege('authenticated', 'public.chat_conversations', 'TRIGGER')
           ) AS detail
    UNION ALL

    SELECT 15 AS ord, 'A_acl_authenticated_messages' AS stage,
           CASE WHEN has_table_privilege('authenticated', 'public.chat_messages', 'SELECT')
                 AND has_table_privilege('authenticated', 'public.chat_messages', 'INSERT')
                 AND has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE')
                 AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'DELETE')
                 AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'TRUNCATE')
                 AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'REFERENCES')
                 AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'TRIGGER')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'select', has_table_privilege('authenticated', 'public.chat_messages', 'SELECT'),
               'insert', has_table_privilege('authenticated', 'public.chat_messages', 'INSERT'),
               'update', has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE'),
               'delete', has_table_privilege('authenticated', 'public.chat_messages', 'DELETE'),
               'truncate', has_table_privilege('authenticated', 'public.chat_messages', 'TRUNCATE'),
               'references', has_table_privilege('authenticated', 'public.chat_messages', 'REFERENCES'),
               'trigger', has_table_privilege('authenticated', 'public.chat_messages', 'TRIGGER')
           ) AS detail
    UNION ALL

    SELECT 16 AS ord, 'A_acl_anon_nenhum_privilegio' AS stage,
           CASE WHEN NOT has_table_privilege('anon', 'public.chat_conversations', 'SELECT')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'INSERT')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'UPDATE')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'DELETE')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'TRUNCATE')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'REFERENCES')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'TRIGGER')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'SELECT')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'INSERT')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'UPDATE')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'DELETE')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'TRUNCATE')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'REFERENCES')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'TRIGGER')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversations', (SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '')
                                    FROM information_schema.role_table_grants
                                   WHERE grantee='anon' AND table_schema='public' AND table_name='chat_conversations'),
               'messages', (SELECT coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '')
                              FROM information_schema.role_table_grants
                             WHERE grantee='anon' AND table_schema='public' AND table_name='chat_messages')
           ) AS detail
    UNION ALL

    SELECT 17 AS ord, 'A_acl_public_default_revogado' AS stage,
           CASE WHEN NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c1.relacl, acldefault('r', c1.relowner)))
                                  WHERE grantee = 0)
                 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c2.relacl, acldefault('r', c2.relowner)))
                                  WHERE grantee = 0)
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'chat_conversations_grants_public', (SELECT coalesce(jsonb_agg(DISTINCT privilege_type), '[]'::jsonb)
                                                       FROM aclexplode(coalesce(c1.relacl, acldefault('r', c1.relowner)))
                                                      WHERE grantee = 0),
               'chat_messages_grants_public', (SELECT coalesce(jsonb_agg(DISTINCT privilege_type), '[]'::jsonb)
                                                  FROM aclexplode(coalesce(c2.relacl, acldefault('r', c2.relowner)))
                                                 WHERE grantee = 0)
           ) AS detail
    FROM pg_class c1, pg_class c2
    WHERE c1.oid = 'public.chat_conversations'::regclass
      AND c2.oid = 'public.chat_messages'::regclass
) relatorios_estrutura
ORDER BY ord;

-- ============================================================
-- PARTE B — VERIFICAÇÃO COMPORTAMENTAL DA IDEMPOTÊNCIA + RLS + ACL
-- (BEGIN/ROLLBACK)
--
-- Pre-condições verificadas na SESSÃO ADMINISTRATIVA, ANTES de qualquer
-- troca de role, pelo catálogo (to_regclass/to_regprocedure/pg_roles).
-- Dois perfis REAIS são selecionados silenciosamente para as fixtures
-- sintéticas (FK profiles.id íntegra) e nunca são impressos. request.jwt.
-- claims é configurado como a implementação real lê e o papel é alternado
-- via SET LOCAL. Erros esperados (23505, 42501) só contam como bloqueio com
-- o SQLSTATE EXATO; qualquer outro erro é relançado. Nenhuma chamada direta
-- a app.jwt_* sob authenticated/anon — os helpers canônicos são exercidos
-- apenas implicitamente pela RLS das próprias tabelas. Sem DDL/DML
-- persistente: tudo termina em ROLLBACK. Nenhum UUID/email/valor financeiro
-- é impresso (apenas contagens e textos de status).
-- ============================================================
BEGIN;

DO $$
DECLARE
    v_p1        uuid;
    v_p2        uuid;
    v_conv_a    uuid := '00000000-0000-4000-8000-0000000000c1';
    v_conv_b    uuid := '00000000-0000-4000-8000-0000000000c2';
    v_msg_u     uuid := '00000000-0000-4000-8000-0000000000d1';
    v_msg_a1    uuid := '00000000-0000-4000-8000-0000000000d2';
    v_msg_u2    uuid := '00000000-0000-4000-8000-0000000000d3';
    v_dup       uuid := '00000000-0000-4000-8000-0000000000d9';
    v_n         bigint;
    v_linhas    bigint;
    v_state     text;
    v_blocked   boolean;
BEGIN
    -- Guarda de pré-condições estruturais (catálogo, sessão administrativa).
    -- Nada é executado se faltar alguma condição estrutural.
    IF to_regclass('public.chat_conversations') IS NULL
       OR to_regclass('public.chat_messages') IS NULL
       OR to_regprocedure('app.jwt_profile_id()') IS NULL
       OR to_regprocedure('app.jwt_role()') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        RAISE NOTICE 'VERIFY 026 (comportamento): BLOCKED - pre-condicao estrutural ausente (nenhum DML executado)';
        RETURN;
    END IF;

    -- Dois perfis REAIS existentes, selecionados silenciosamente (nunca
    -- impressos: nenhum UUID real aparece na saída).
    SELECT id INTO v_p1 FROM public.profiles ORDER BY created_at, id LIMIT 1;
    SELECT id INTO v_p2 FROM public.profiles WHERE id IS DISTINCT FROM v_p1 ORDER BY created_at, id LIMIT 1;
    IF v_p1 IS NULL OR v_p2 IS NULL THEN
        RAISE NOTICE 'VERIFY 026 (comportamento): BLOCKED - menos de dois perfis para isolar (nenhum DML executado)';
        RETURN;
    END IF;

    -- Fixtures sintéticas na SESSÃO ADMINISTRATIVA (antes de qualquer troca
    -- de role): conversa por perfil + mensagem user inicial na conversa A com
    -- client_request_id ('req-a') — representa o estado pré-026 (user órfã,
    -- sem âncora).
    DELETE FROM public.chat_conversations WHERE id IN (v_conv_a, v_conv_b);
    INSERT INTO public.chat_conversations (id, profile_id, title)
    VALUES (v_conv_a, v_p1, 'fixture-a'), (v_conv_b, v_p2, 'fixture-b');
    INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
    VALUES (v_msg_u, v_conv_a, 'user', 'completed', 'msg-a', 'req-a');

    -- ---------- Perfil A ----------
    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'role', 'authenticated',
            'sub', '00000000-0000-4000-8000-0000000000a1',
            'profile_id', v_p1
        )::text,
        true
    );
    SET LOCAL ROLE authenticated;

    -- A vê somente a PRÓPRIA conversa e as próprias mensagens.
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_a;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil A nao enxerga a propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil A enxerga conversa do perfil B'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil A nao ve as mensagens da propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil A ve mensagens da conversa do perfil B'; END IF;

    -- CONTRATO CENTRAL 1 — USER E ASSISTANT COEXISTEM com o MESMO
    -- client_request_id 'req-a': a âncora assistant entra ao lado da user.
    INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
    VALUES (v_msg_a1, v_conv_a, 'assistant', 'pending', '', 'req-a');
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 2 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: user+assistant do mesmo crid nao coexistiram (esperado 2 mensagens)'; END IF;
    SELECT count(*) INTO v_n
      FROM public.chat_messages
     WHERE conversation_id = v_conv_a AND client_request_id = 'req-a';
    IF v_n <> 2 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: o mesmo client_request_id nao possui exatamente user+assistant'; END IF;
    SELECT count(*) INTO v_n
      FROM public.chat_messages
     WHERE conversation_id = v_conv_a AND client_request_id = 'req-a' AND role = 'user';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: mais de uma mensagem user para o crid'; END IF;
    SELECT count(*) INTO v_n
      FROM public.chat_messages
     WHERE conversation_id = v_conv_a AND client_request_id = 'req-a' AND role = 'assistant';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: mais de uma ancora assistant para o crid'; END IF;
    RAISE NOTICE 'VERIFY 026 OK: user e assistant coexistem com o mesmo client_request_id';

    -- Caminho de escrita padrão preservado (upsert/idempotência): identificar a
    -- âncora e concluí-la (UPDATE) funciona com grants mínimos + RLS.
    UPDATE public.chat_messages SET status = 'completed', content = 'ok-a'
     WHERE id = v_msg_a1;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE id = v_msg_a1 AND status = 'completed';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: UPDATE da ancora (escrita) quebrado'; END IF;
    RAISE NOTICE 'VERIFY 026 OK: UPDATE da ancora assistant (pending -> completed) funcionando';

    -- CONTRATO CENTRAL 2 — REENVIO DA USER NÃO CRIA DUPLICATA. O alvo de
    -- conflito TRIPLO é inferido exatamente contra o índice novo: se restasse
    -- o índice antigo de 2 colunas, este INSERT ... ON CONFLICT (...,role)
    -- falharia com 42P10 (alvo sem índice correspondente).
    INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
    VALUES (v_msg_u2, v_conv_a, 'user', 'completed', 'msg-a', 'req-a')
    ON CONFLICT (conversation_id, client_request_id, role) DO NOTHING;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: reenvio da user criou duplicata'; END IF;
    SELECT count(*) INTO v_n
      FROM public.chat_messages
     WHERE conversation_id = v_conv_a AND client_request_id = 'req-a' AND role = 'user';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: user duplicada apos reenvio (ON CONFLICT)'; END IF;
    RAISE NOTICE 'VERIFY 026 OK: reenvio da user nao cria duplicata (ON CONFLICT 3 colunas, 0 linhas)';

    -- CONTRATO CENTRAL 3 — SEGUNDA ASSISTANT IDÊNTICA levanta EXATAMENTE 23505.
    v_blocked := false;
    BEGIN
        INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
        VALUES (v_dup, v_conv_a, 'assistant', 'completed', '', 'req-a');
        v_blocked := false;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_state <> '23505' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 026 FAIL: segunda assistant identica nao violou a unicidade';
    END IF;
    RAISE NOTICE 'VERIFY 026 OK: segunda assistant identica bloqueada exatamente com 23505';

    -- ISOLAMENTO: A não pode inserir mensagem na conversa do perfil B (42501) e
    -- não vê as mensagens de B.
    v_blocked := false;
    BEGIN
        INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
        VALUES ('00000000-0000-4000-8000-0000000000d4', v_conv_b, 'assistant', 'completed', '', 'req-b');
        v_blocked := false;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_state <> '42501' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 026 FAIL: perfil A inseriu mensagem na conversa do perfil B';
    END IF;
    RAISE NOTICE 'VERIFY 026 OK: INSERT cruzado de mensagem negado exatamente com 42501';

    -- ---------- Perfil B (reset de role + claims antes da troca) ----------
    RESET ROLE;
    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'role', 'authenticated',
            'sub', '00000000-0000-4000-8000-0000000000a2',
            'profile_id', v_p2
        )::text,
        true
    );
    SET LOCAL ROLE authenticated;

    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil B nao enxerga a propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_a;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil B enxerga conversa do perfil A'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil B ve mensagens da conversa do perfil A'; END IF;

    UPDATE public.chat_conversations SET title = 'fixture-b2' WHERE id = v_conv_b;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b AND title = 'fixture-b2';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil B nao atualiza a propria conversa'; END IF;
    UPDATE public.chat_conversations SET title = 'hack' WHERE id = v_conv_a;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil B alterou conversa do perfil A'; END IF;

    -- Caminho LÍCITO de remoção preservado: DELETE da PRÓPRIA conversa remove
    -- mensagens por cascade.
    DELETE FROM public.chat_conversations WHERE id = v_conv_b;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 1 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: perfil B nao apagou a propria conversa'; END IF;

    RESET ROLE;

    -- Cascade provado na SESSÃO ADMINISTRATIVA (vê todas as linhas): as
    -- mensagens de B sumiram pelo cascade; a conversa A e as SUAS DUAS
    -- mensagens (user+assistant de 'req-a') continuam intactas.
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: cascade nao removeu mensagens da conversa B'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 2 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: cascade afetou mensagens da conversa A (user+assistant)'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 026 FAIL: conversa B ainda existe apos DELETE'; END IF;
    RAISE NOTICE 'VERIFY 026 OK: isolamento A/B preservado e cascade de conversa propria intacto';

    -- ---------- anon ----------
    -- Sem grants nas tabelas de chat: leitura falha exatamente com 42501.
    SET LOCAL ROLE anon;
    v_blocked := false;
    BEGIN
        PERFORM count(*) FROM public.chat_conversations;
        v_blocked := false;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_state <> '42501' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 026 FAIL: anon leu chat_conversations';
    END IF;
    RAISE NOTICE 'VERIFY 026 OK: anon sem acesso a chat_conversations (42501)';

    -- Reset limpo de role e claims antes do ROLLBACK.
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    RAISE NOTICE 'VERIFY 026 OK: idempotencia user+assistant, isolamento e cascade validados — ROLLBACK a seguir';
END $$;

ROLLBACK;

-- Confirmação final: a transação acima foi desfeita (nenhum resíduo).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.chat_conversations WHERE id IN (
        '00000000-0000-4000-8000-0000000000c1'::uuid,
        '00000000-0000-4000-8000-0000000000c2'::uuid
    )) THEN
        RAISE WARNING 'VERIFY 026: residuo de dados sinteticos encontrado (nada deveria persistir)';
    ELSE
        RAISE NOTICE 'VERIFY 026 OK: ROLLBACK confirmado - nenhum dado persistido';
    END IF;
END $$;