-- READ-ONLY: este arquivo NÃO contém DDL, DML persistente ou chamadas de RPC
-- externas. A Parte B roda em uma transação que termina em ROLLBACK e usa
-- dados 100% sintéticos (UUIDs de teste), sem imprimir UUID reais, e-mails ou
-- valores financeiros.
-- ============================================================
-- VERIFY_POST_CLOUD_023_CHAT_RLS_READONLY.sql
-- Verificação PÓS-aplicação do 023_chat_persistence.sql (PESSOAL-13C2) no
-- Supabase de TESTE. Separado em duas camadas independentes:
--
--   PARTE A — ESTRUTURA (catálogo): uma única statement SELECT exporta a
--             grade de pré-condições/esquema/RLS/grants (PASS/BLOCKED).
--   PARTE B — COMPORTAMENTO (RLS real): dentro de BEGIN/ROLLBACK, com
--             request.jwt.claims simulados de forma COMPATÍVEL com a
--             implementação real (app.jwt_profile_id lê request.jwt.claims)
--             e SET LOCAL ROLE authenticated, prova isolamento/propriedade a
--             partir das POLÍTICAS. Termina SEMPRE em ROLLBACK (nunca altera
--             dados permanentemente).
-- ============================================================

-- ============================================================
-- PARTE A — VERIFICAÇÃO ESTRUTURAL DO CATÁLOGO (read-only)
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
                         AND cmd IN ('SELECT','INSERT','UPDATE','DELETE')) = 4
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversations', (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies
                                  WHERE schemaname='public' AND tablename='chat_conversations'),
               'messages', (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies
                             WHERE schemaname='public' AND tablename='chat_messages')
           ) AS detail
    UNION ALL

    SELECT 8 AS ord, 'A_constraints_por_nome_estavel' AS stage,
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
                 AND (SELECT count(*) FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
                       WHERE rel.oid IN ('public.chat_conversations'::regclass, 'public.chat_messages'::regclass)
                         AND c.conname NOT IN
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
                              'chat_messages_payload_size')) = 0
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'constraints_esperadas', 13,
               'constraints_inesperadas', (SELECT count(*) FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
                                            WHERE rel.oid IN ('public.chat_conversations'::regclass, 'public.chat_messages'::regclass)
                                              AND c.conname NOT IN
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
                                                   'chat_messages_payload_size'))
           ) AS detail
    UNION ALL

    SELECT 9 AS ord, 'A_msg_delete_cascata_e_sem_delete_individual' AS stage,
           CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
                              WHERE rel.oid = 'public.chat_messages'::regclass
                                AND c.conname = 'chat_messages_conversation_id_fkey'
                                AND c.contype = 'f'
                                AND c.confdeltype = 'c')
                 AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'DELETE')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversas_delete_cascade', (SELECT confdeltype FROM pg_constraint c WHERE c.conname = 'chat_messages_conversation_id_fkey'),
               'authenticated_delete_chat_messages', has_table_privilege('authenticated', 'public.chat_messages', 'DELETE')
           ) AS detail
    UNION ALL

    SELECT 10 AS ord, 'A_anon_sem_acesso' AS stage,
           CASE WHEN NOT has_table_privilege('anon', 'public.chat_conversations', 'SELECT')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'INSERT')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'UPDATE')
                 AND NOT has_table_privilege('anon', 'public.chat_conversations', 'DELETE')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'SELECT')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'INSERT')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'UPDATE')
                 AND NOT has_table_privilege('anon', 'public.chat_messages', 'DELETE')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'anon_grant_conversations', (SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
                                             WHERE grantee='anon' AND table_schema='public' AND table_name='chat_conversations'),
               'anon_grant_messages', (SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
                                        WHERE grantee='anon' AND table_schema='public' AND table_name='chat_messages')
           ) AS detail
    UNION ALL

    SELECT 11 AS ord, 'A_grants_authenticated' AS stage,
           CASE WHEN has_table_privilege('authenticated', 'public.chat_conversations', 'SELECT')
                 AND has_table_privilege('authenticated', 'public.chat_conversations', 'INSERT')
                 AND has_table_privilege('authenticated', 'public.chat_conversations', 'UPDATE')
                 AND has_table_privilege('authenticated', 'public.chat_conversations', 'DELETE')
                 AND has_table_privilege('authenticated', 'public.chat_messages', 'SELECT')
                 AND has_table_privilege('authenticated', 'public.chat_messages', 'INSERT')
                 AND has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE')
                 AND NOT has_table_privilege('authenticated', 'public.chat_messages', 'DELETE')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object(
               'conversations', (SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
                                  WHERE grantee='authenticated' AND table_schema='public' AND table_name='chat_conversations'),
               'messages', (SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
                             WHERE grantee='authenticated' AND table_schema='public' AND table_name='chat_messages')
           ) AS detail
    UNION ALL

    SELECT 12 AS ord, 'A_indices_por_nome_estavel' AS stage,
           CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_conversations' AND indexname='idx_chat_conversations_profile_last')
                 AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_messages' AND indexname='uq_chat_messages_conversation_client_request')
                 AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_messages' AND indexname='idx_chat_messages_conversation_created')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('indices', (SELECT string_agg(indexname, ',') FROM pg_indexes
                                            WHERE schemaname='public' AND (tablename='chat_conversations' OR tablename='chat_messages'))) AS detail
) relatorios_estrutura
ORDER BY ord;

-- ============================================================
-- PARTE B — VERIFICAÇÃO COMPORTAMENTAL DA RLS (BEGIN/ROLLBACK)
--
-- Pre-condições verificadas ANTES de qualquer teste: as funções canônicas do
-- projeto existem (app.jwt_profile_id/app.jwt_role) e as tabelas existem.
-- request.jwt.claims é configurado EXATAMENTE como a implementação real lê
-- (current_setting('request.jwt.claims')::jsonb) e o papel é alternado para
-- authenticated via SET LOCAL. Sem DDL/DML persistente: tudo termina em
-- ROLLBACK. Nenhum UUID/email/valor financeiro real é impresso.
-- ============================================================
BEGIN;

DO $$
DECLARE
    v_p1       uuid := '00000000-0000-4000-8000-000000000001';
    v_conv_p1  uuid := '00000000-0000-4000-8000-0000000000c1';
    v_n        bigint;
    v_blocked  boolean;
BEGIN
    -- Guarda de pré-condições (nada é executado se faltar categoria estrutural).
    IF to_regclass('public.chat_conversations') IS NULL
       OR to_regclass('public.chat_messages') IS NULL
       OR to_regprocedure('app.jwt_profile_id()') IS NULL
       OR to_regprocedure('app.jwt_role()') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        RAISE NOTICE 'VERIFY 023 (comportamento): BLOCKED - pre-condicao ausente (nenhum DML executado)';
        RETURN;
    END IF;

    -- Identidade simulada P1 (claims compatíveis com a implementação real).
    PERFORM set_config(
        'request.jwt.claims',
        '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000000a1","profile_id":"00000000-0000-4000-8000-000000000001"}',
        true
    );
    SET LOCAL ROLE authenticated;

    -- (1) app.jwt_profile_id() resolve os claims simulados.
    IF app.jwt_profile_id() IS DISTINCT FROM v_p1 THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: jwt_profile_id nao resolve os claims simulados';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: jwt_profile_id resolve os claims simulados (authenticated)';

    -- (2) tabela vazia: nada vaza (SELECT limitado pela policy de propriedade).
    SELECT count(*) INTO v_n FROM public.chat_conversations;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 023 FAIL: conversa visivel sem dados'; END IF;
    RAISE NOTICE 'VERIFY 023 OK: SELECT em tabela vazia retorna 0 linhas';

    -- (3) P1 cria a PRÓPRIA conversa (WITH CHECK profile_id = jwt_profile_id()).
    INSERT INTO public.chat_conversations (id, profile_id, title)
    VALUES (v_conv_p1, v_p1, 'teste');
    IF NOT EXISTS (SELECT 1 FROM public.chat_conversations WHERE id = v_conv_p1 AND profile_id = v_p1) THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: proprio INSERT de conversa foi bloqueado';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: INSERT da propria conversa permitido';

    -- (4) P1 insere mensagem na própria conversa (EXISTS na conversa do perfil).
    INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
    VALUES ('00000000-0000-4000-8000-0000000000d1', v_conv_p1, 'user', 'completed', 'oi', 'req-1');
    IF NOT EXISTS (SELECT 1 FROM public.chat_messages WHERE conversation_id = v_conv_p1 AND role = 'user') THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: proprio INSERT de mensagem foi bloqueado';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: INSERT de mensagem na propria conversa permitido';

    -- (5) P2 não vê a conversa de P1 nem consegue criar conversa do perfil de P1
    --     (a flag v_blocked vira true com erro de RLS/privilégio OU com 0 linhas).
    PERFORM set_config(
        'request.jwt.claims',
        '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000000a2","profile_id":"00000000-0000-4000-8000-000000000002"}',
        true
    );
    SELECT count(*) INTO v_n FROM public.chat_conversations;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 023 FAIL: conversa de OUTRO perfil visivel'; END IF;
    RAISE NOTICE 'VERIFY 023 OK: conversa de outro perfil invisivel (SELECT)';

    v_blocked := false;
    BEGIN
        INSERT INTO public.chat_conversations (id, profile_id, title)
        VALUES ('00000000-0000-4000-8000-0000000000c2', v_p1, 'teste');
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_blocked := (v_n = 0);
    EXCEPTION
        WHEN OTHERS THEN
            v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: INSERT de conversa com perfil de OUTRO usuario permitido';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: INSERT de conversa sob perfil alheio foi bloqueado';

    v_blocked := false;
    BEGIN
        INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
        VALUES ('00000000-0000-4000-8000-0000000000d2', v_conv_p1, 'assistant', 'pending', '', 'req-2');
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_blocked := (v_n = 0);
    EXCEPTION
        WHEN OTHERS THEN
            v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: INSERT de mensagem em conversa de OUTRO perfil permitido';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: INSERT de mensagem em conversa de outro perfil bloqueado';

    -- (6) UPDATE/consulta da própria conversa segue valendo após a troca de claims
    --     (volta para P1 e confirma a propriedade na leitura).
    PERFORM set_config(
        'request.jwt.claims',
        '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000000a1","profile_id":"00000000-0000-4000-8000-000000000001"}',
        true
    );
    UPDATE public.chat_conversations SET title = 'teste-2' WHERE id = v_conv_p1;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_p1 AND title = 'teste-2';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 023 FAIL: UPDATE da propria conversa bloqueado'; END IF;
    RAISE NOTICE 'VERIFY 023 OK: UPDATE da propria conversa permitido';

    -- (7) DELETE individual de mensagem é vedado por privilégio (sem DELETE grant).
    v_blocked := false;
    BEGIN
        DELETE FROM public.chat_messages WHERE conversation_id = v_conv_p1 AND role = 'user';
        v_blocked := false;
    EXCEPTION
        WHEN OTHERS THEN
            v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: authenticated concluiu DELETE individual de mensagem';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: DELETE individual de mensagem negado a authenticated';

    -- (8) anon (sem grants) também não acessa via papel anônimo.
    SET LOCAL ROLE anon;
    v_blocked := false;
    BEGIN
        PERFORM count(*) FROM public.chat_conversations;
        v_blocked := false;
    EXCEPTION
        WHEN OTHERS THEN
            v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 023 FAIL: anon conseguiu ler chat_conversations';
    END IF;
    RAISE NOTICE 'VERIFY 023 OK: anon sem acesso a chat_conversations';
END $$;

ROLLBACK;

-- Confirmação final: a transação acima foi desfeita (nenhum resíduo).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.chat_conversations WHERE id = '00000000-0000-4000-8000-0000000000c1'::uuid) THEN
        RAISE WARNING 'VERIFY 023: residuo de dados sinteticos encontrado (nada deveria persistir)';
    ELSE
        RAISE NOTICE 'VERIFY 023 OK: ROLLBACK confirmado - nenhum dado persistido';
    END IF;
END $$;