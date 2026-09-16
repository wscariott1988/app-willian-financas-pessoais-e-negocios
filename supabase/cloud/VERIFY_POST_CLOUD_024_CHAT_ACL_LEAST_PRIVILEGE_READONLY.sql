-- READ-ONLY: este arquivo NÃO contém DDL, DML persistente ou chamadas de RPC
-- externas. A Parte B roda em uma transação que termina em ROLLBACK e usa
-- dados 100% sintéticos, sem imprimir UUID reais, e-mails ou valores
-- financeiros.
-- ============================================================
-- VERIFY_POST_CLOUD_024_CHAT_ACL_LEAST_PRIVILEGE_READONLY.sql
-- Verificação PÓS-aplicação do 024_chat_acl_least_privilege.sql
-- (PESSOAL-13C2A.3) no Supabase de TESTE. Separado em duas camadas:
--
--   PARTE A — ESTRUTURA + ACL EXATA (catálogo): uma única statement SELECT
--             exporta a grade de pré-condições/esquema/RLS/policies/cascade e
--             os privilégios POR PRIVILÉGIO (has_table_privilege) de cada
--             tabela/role (PASS/BLOCKED).
--   PARTE B — COMPORTAMENTO (RLS real + ACL): dentro de BEGIN/ROLLBACK, com
--             request.jwt.claims simulados e SET LOCAL ROLE authenticated,
--             prova isolamento de perfis, o caminho de escrita (INSERT+UPDATE
--             para upsert/idempotência), a remoção LÍCITA de mensagens apenas
--             via ON DELETE CASCADE da conversa própria e — o contrato CENTRAL
--             do 024 — que DELETE direto em chat_messages levanta EXATAMENTE
--             42501. NÃO se aceita "DELETE 0": o teste falha se a operação
--             concluir sem erro.
--
-- Causa do erro real no TESTE (PESSOAL-13C2A.3): o bootstrap do Supabase
-- aplica ALTER DEFAULT PRIVILEGES IN SCHEMA public concedendo ALL ON TABLES a
-- anon/authenticated e ao "role de serviço"; o 023 criou as tabelas com grants mínimos
-- mas SEM revogar o herdado, deixando authenticated com DELETE (e
-- TRUNCATE/REFERENCES/TRIGGER) em chat_messages e anon com privilégios nas
-- duas tabelas. O VERIFY 023 (aplicado) provou o vazamento com o erro P0001
-- "authenticated concluiu DELETE individual de mensagem". O 024 revoga
-- PUBLIC/anon/authenticated e reaplica os grants mínimos; este VERIFY passa a
-- EXIGIR a grade exata de privilégios por tabela/role, não apenas a ausência
-- textual de DELETE.
--
-- PESSOAL-13C2A.2 (regressão 42501 schema app): os helpers canônicos
-- (app.jwt_profile_id/app.jwt_role) existem e são exercidos APENAS pela RLS
-- (comportamento real de produção). A existência deles é verificada SOMENTE
-- pelo CATÁLOGO (to_regprocedure) na PARTE A e na guarda da PARTE B, sempre
-- na SESSÃO ADMINISTRATIVA, antes de qualquer troca de role — nunca por
-- chamada direta sob authenticated/anon (exigiria USAGE no schema app em
-- projetos de teste que não concedem → 42501).
--
-- Erros esperados de permissão só contam como bloqueio quando o SQLSTATE é
-- EXATAMENTE o esperado (42501 para permissão/RLS; 23505 para a chave única
-- de idempotência); qualquer outro erro é relançado.
-- ============================================================

-- ============================================================
-- PARTE A — VERIFICAÇÃO ESTRUTURAL E DE ACL (read-only, catálogo)
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
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('constraints_esperadas', 13) AS detail
    UNION ALL

    SELECT 9 AS ord, 'A_indices_por_nome_estavel' AS stage,
           CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_conversations' AND indexname='idx_chat_conversations_profile_last')
                 AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_messages' AND indexname='uq_chat_messages_conversation_client_request')
                 AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='chat_messages' AND indexname='idx_chat_messages_conversation_created')
                THEN 'PASS' ELSE 'BLOCKED' END AS status,
           jsonb_build_object('indices', (SELECT string_agg(indexname, ',') FROM pg_indexes
                                            WHERE schemaname='public' AND (tablename='chat_conversations' OR tablename='chat_messages'))) AS detail
    UNION ALL

    SELECT 10 AS ord, 'A_cascata_mensagens' AS stage,
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

    SELECT 11 AS ord, 'A_acl_authenticated_conversations' AS stage,
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

    SELECT 12 AS ord, 'A_acl_authenticated_messages' AS stage,
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

    SELECT 13 AS ord, 'A_acl_anon_nenhum_privilegio' AS stage,
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

    SELECT 14 AS ord, 'A_acl_public_default_revogado' AS stage,
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
-- PARTE B — VERIFICAÇÃO COMPORTAMENTAL DA RLS + ACL (BEGIN/ROLLBACK)
--
-- Pre-condições verificadas na SESSÃO ADMINISTRATIVA, ANTES de qualquer
-- troca de role, pelo catálogo (to_regclass/to_regprocedure/pg_roles).
-- Dois perfis REAIS são selecionados silenciosamente para as fixtures
-- sintéticas (FK profiles.id íntegra) e nunca são impressos. request.jwt.
-- claims é configurado como a implementação real lê e o papel é alternado
-- via SET LOCAL. Erros esperados (42501, 23505) só contam como bloqueio com
-- o SQLSTATE EXATO; qualquer outro erro é relançado. Sem DDL/DML persistente:
-- tudo termina em ROLLBACK. Nenhum UUID/email/valor financeiro é impresso.
-- ============================================================
BEGIN;

DO $$
DECLARE
    v_p1        uuid;
    v_p2        uuid;
    v_conv_a    uuid := '00000000-0000-4000-8000-0000000000c1';
    v_conv_b    uuid := '00000000-0000-4000-8000-0000000000c2';
    v_msg_a1    uuid := '00000000-0000-4000-8000-0000000000d1';
    v_msg_b1    uuid := '00000000-0000-4000-8000-0000000000d2';
    v_msg_a2    uuid := '00000000-0000-4000-8000-0000000000d3';
    v_dup       uuid := '00000000-0000-4000-8000-0000000000d9';
    v_n         bigint;
    v_linhas    bigint;
    v_state     text;
    v_blocked   boolean;
BEGIN
    -- Guarda de pré-condições estruturais (catálogo, sessão administrativa).
    -- Nada é executado se faltar alguma categoria estrutural.
    IF to_regclass('public.chat_conversations') IS NULL
       OR to_regclass('public.chat_messages') IS NULL
       OR to_regprocedure('app.jwt_profile_id()') IS NULL
       OR to_regprocedure('app.jwt_role()') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        RAISE NOTICE 'VERIFY 024 (comportamento): BLOCKED - pre-condicao estrutural ausente (nenhum DML executado)';
        RETURN;
    END IF;

    -- Dois perfis REAIS existentes, selecionados silenciosamente (nunca
    -- impressos: nenhum UUID real aparece na saída).
    SELECT id INTO v_p1 FROM public.profiles ORDER BY created_at, id LIMIT 1;
    SELECT id INTO v_p2 FROM public.profiles WHERE id IS DISTINCT FROM v_p1 ORDER BY created_at, id LIMIT 1;
    IF v_p1 IS NULL OR v_p2 IS NULL THEN
        RAISE NOTICE 'VERIFY 024 (comportamento): BLOCKED - menos de dois perfis para isolar (nenhum DML executado)';
        RETURN;
    END IF;

    -- Fixtures sintéticas criadas na SESSÃO ADMINISTRATIVA (antes de qualquer
    -- troca de role): uma conversa por perfil + uma mensagem por conversa,
    -- com UUIDs sintéticos de teste (nunca impressos).
    DELETE FROM public.chat_conversations WHERE id IN (v_conv_a, v_conv_b);
    INSERT INTO public.chat_conversations (id, profile_id, title)
    VALUES (v_conv_a, v_p1, 'fixture-a'), (v_conv_b, v_p2, 'fixture-b');
    INSERT INTO public.chat_messages (id, conversation_id, role, status, content)
    VALUES (v_msg_a1, v_conv_a, 'user', 'completed', 'msg-a'),
           (v_msg_b1, v_conv_b, 'user', 'completed', 'msg-b');

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

    -- A vê somente a PRÓPRIA conversa e as próprias mensagens (comportamento
    -- das políticas — nenhuma chamada direta a helper do schema app).
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_a;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A nao enxerga a propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A enxerga conversa do perfil B'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A nao ve mensagens da propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A ve mensagens da conversa do perfil B'; END IF;

    -- A altera a própria conversa e não toca na do perfil B.
    UPDATE public.chat_conversations SET title = 'fixture-a2' WHERE id = v_conv_a;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_a AND title = 'fixture-a2';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A nao atualiza a propria conversa'; END IF;
    UPDATE public.chat_conversations SET title = 'hack' WHERE id = v_conv_b;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A alterou conversa do perfil B'; END IF;
    RAISE NOTICE 'VERIFY 024 OK: A ve e edita so a propria conversa (SELECT/UPDATE)';

    -- Caminho de escrita (upsert/idempotência) preservado: INSERT + UPDATE de
    -- mensagem na PRÓPRIA conversa funcionam com os grants mínimos + RLS.
    INSERT INTO public.chat_messages (id, conversation_id, role, status, content, client_request_id)
    VALUES (v_msg_a2, v_conv_a, 'assistant', 'pending', '', 'req-a');
    UPDATE public.chat_messages SET status = 'completed', content = 'ok-a' WHERE id = v_msg_a2;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE id = v_msg_a2 AND status = 'completed' AND content = 'ok-a';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: INSERT+UPDATE de mensagem (idempotencia) quebrado'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 2 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: contagem de mensagens da conversa A divergente'; END IF;
    RAISE NOTICE 'VERIFY 024 OK: INSERT + UPDATE de mensagem (upsert/idempotencia) funcionando';

    -- A é impedido de inserir mensagem na conversa do perfil B (erro RLS 42501).
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
        RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A inseriu mensagem na conversa do perfil B';
    END IF;

    -- CONTRATO CENTRAL DO 024: DELETE direto de mensagem (mesmo da PRÓPRIA
    -- conversa, com linha visível) deve falhar com EXATAMENTE 42501 — sem
    -- grant DELETE em chat_messages. NÃO se aceita "DELETE 0": concluir sem
    -- erro quer dizer que o privilégio DELETE existe (o erro real do 023).
    v_blocked := false;
    BEGIN
        DELETE FROM public.chat_messages WHERE conversation_id = v_conv_a;
        v_blocked := false;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_state <> '42501' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 024 FAIL: authenticated concluiu DELETE individual de mensagem';
    END IF;
    RAISE NOTICE 'VERIFY 024 OK: DELETE direto de mensagem negado exatamente com 42501';

    -- A: DELETE direto também na conversa do perfil B (sem linhas visíveis;
    -- mesmo assim o privilégio DELETE inexistente em chat_messages leva a 42501).
    v_blocked := false;
    BEGIN
        DELETE FROM public.chat_messages WHERE conversation_id = v_conv_b;
        v_blocked := false;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_state <> '42501' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 024 FAIL: authenticated (A) concluiu DELETE de mensagem da conversa B';
    END IF;

    -- A não apaga a conversa do perfil B (política de propriedade → 0 linhas).
    DELETE FROM public.chat_conversations WHERE id = v_conv_b;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil A apagou conversa do perfil B'; END IF;

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

    -- B só vê a própria conversa/mensagens; a conversa A permanece invisível.
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B nao enxerga a propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_a;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B enxerga conversa do perfil A'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_b;
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B nao ve mensagens da propria conversa'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B ve mensagens da conversa do perfil A'; END IF;

    -- B altera a própria conversa e não altera a de A.
    UPDATE public.chat_conversations SET title = 'fixture-b2' WHERE id = v_conv_b;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b AND title = 'fixture-b2';
    IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B nao atualiza a propria conversa'; END IF;
    UPDATE public.chat_conversations SET title = 'hack' WHERE id = v_conv_a;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B alterou conversa do perfil A'; END IF;

    -- DELETE direto de própria mensagem segue vedado para B (42501 exato).
    v_blocked := false;
    BEGIN
        DELETE FROM public.chat_messages WHERE conversation_id = v_conv_b;
        v_blocked := false;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
        IF v_state <> '42501' THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
        RAISE EXCEPTION 'VERIFY 024 FAIL: authenticated (B) concluiu DELETE individual de mensagem';
    END IF;

    -- Caminho LÍCITO de remoção de mensagens: DELETE da PRÓPRIA conversa
    -- (grant DELETE em conversas + policy do próprio perfil) remove a linha
    -- e todas as mensagens por ON DELETE CASCADE.
    DELETE FROM public.chat_conversations WHERE id = v_conv_b;
    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    IF v_linhas <> 1 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: perfil B nao apagou a propria conversa'; END IF;

    RESET ROLE;

    -- Cascade provado na SESSÃO ADMINISTRATIVA (vê todas as linhas, então a
    -- ausência NÃO é efeito de RLS): mensagens de B sumiram pelo cascade; a
    -- conversa A e as suas mensagens continuam intactas.
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: cascade nao removeu mensagens da conversa B'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_messages WHERE conversation_id = v_conv_a;
    IF v_n <> 2 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: cascade afetou mensagens da conversa A'; END IF;
    SELECT count(*) INTO v_n FROM public.chat_conversations WHERE id = v_conv_b;
    IF v_n <> 0 THEN RAISE EXCEPTION 'VERIFY 024 FAIL: conversa B ainda existe apos DELETE'; END IF;
    RAISE NOTICE 'VERIFY 024 OK: A e B isolados; DELETE da propria conversa remove mensagens por cascade';

    -- Idempotência por UNIQUE(conversation_id, client_request_id) preservada:
    -- duplicar (conv_a, 'req-a') viola o índice com 23505.
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
        RAISE EXCEPTION 'VERIFY 024 FAIL: chave unica de idempotencia nao bloqueou duplicata';
    END IF;

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
        RAISE EXCEPTION 'VERIFY 024 FAIL: anon leu chat_conversations';
    END IF;
    RAISE NOTICE 'VERIFY 024 OK: anon sem acesso a chat_conversations (42501)';

    -- Reset limpo de role e claims antes do ROLLBACK.
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    RAISE NOTICE 'VERIFY 024 OK: comportamento ACL/RLS validado (A/B/anon) — ROLLBACK a seguir';
END $$;

ROLLBACK;

-- Confirmação final: a transação acima foi desfeita (nenhum resíduo).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.chat_conversations WHERE id IN (
        '00000000-0000-4000-8000-0000000000c1'::uuid,
        '00000000-0000-4000-8000-0000000000c2'::uuid
    )) THEN
        RAISE WARNING 'VERIFY 024: residuo de dados sinteticos encontrado (nada deveria persistir)';
    ELSE
        RAISE NOTICE 'VERIFY 024 OK: ROLLBACK confirmado - nenhum dado persistido';
    END IF;
END $$;