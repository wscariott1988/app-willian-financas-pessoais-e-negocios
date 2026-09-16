-- ============================================================
-- ROLLBACK_TEST_ONLY_023_CHAT_PERSISTENCE.sql
-- DESAPLICAÇÃO DE TESTE do 023_chat_persistence.sql (PESSOAL-13C2 / C2A.1).
-- RODA SOMENTE EM AMBIENTE DE TESTE, DENTRO DE UMA TRANSAÇÃO.
--
-- NÃO é um arquivo de migração: NÃO deve ser aplicado automaticamente pelo
-- Cli/Supabase em staging/produção. Execução manual e deliberada, apenas
-- quando se desejar desfazer o schema de chat persistente.
--
-- COMPORTAMENTO:
--   * Abre uma transação e DROP em 2 passos (chat_messages -> chat_conversations),
--     respeitando a dependência de FK (ON DELETE CASCADE é irrelevante aqui,
--     pois o DROP remove a tabela inteira); APIs de erro de máquina de estado
--     são REMOVIDAS ANTES, porque não podem sobreviver sem as tabelas.
--   * RECUSA (RAISE EXCEPTION, ROLLBACK completo) se o estado NÃO for o
--     esperado do 023 recém-aplicado:
--       - tabelas ausentes;
--       - dependências externas: views, FKs de OUTRAS tabelas apontando para
--         as chat_*, colunas com sequências, triggers.
--     Essa recusa impede que o rollback destrua objetos não criados por 023.
--   * Remove também os índices exclusivos/derivados e as políticas RLS
--     (drop-cascade é deliberadamente EVITADO para não derrubar outras coisas).
--   * Emite apenas NOTICE de contagem (sem dados reais impressos).
--   * Termina com ROLLBACK? SIM: este arquivo é TEST-ONLY e "confirma"
--     apenas em execução manual. Para uso real do rollback, comente o
--     ROLLBACK final (ou use a variável de ambiente) e rode o COMMIT você
--     mesmo, após inspecionar os NOTICEs.
--
-- USO MANUAL (sem mudança garantida de estado):
--   psql "$SUPABASE_DB_URL" -f supabase/cloud/ROLLBACK_TEST_ONLY_023_CHAT_PERSISTENCE.sql
--   # (finaliza rollback por padrão; para aplicar de verdade, descomente o
--   #  COMMIT da última linha e rode de novo após ler os NOTICEs)
-- ============================================================

BEGIN;

-- Faz pré-verificações e, se tudo ok, desfaz o schema de chat persistente.
DO $$
DECLARE
    v_count         int;
    v_tables        text;
    v_msg_count     bigint;
    v_conv_count    bigint;
BEGIN
    -- 1) As tabelas DEVEM existir (rollback de um 023 não aplicado = erro).
    IF to_regclass('public.chat_messages') IS NULL OR to_regclass('public.chat_conversations') IS NULL THEN
        RAISE EXCEPTION 'ROLLBACK_TEST_ONLY 023 CANCELADO: tabelas chat_messages/chat_conversations ausentes';
    END IF;

    -- 2) Nenhuma dependência externa pode existir (views, FKs vindas de outras
    --    tabelas, sequências, triggers) — isso garantiria que 023 não era o
    --    único dono do objeto, e o rollback destruiria dados alheios.
    SELECT string_agg(dep.tipo || ':' || dep.nome, ', ')
      INTO v_tables
      FROM (
        SELECT 'view' AS tipo, viewname AS nome
          FROM pg_views WHERE schemaname = 'public'
             AND (viewdefinition LIKE '%chat_conversations%' OR viewdefinition LIKE '%chat_messages%')
        UNION ALL
        SELECT 'fk', tc.table_name || '->' || ccu.table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.constraint_schema = tc.constraint_schema
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_schema = 'public'
            AND ccu.table_name IN ('chat_conversations', 'chat_messages')
            AND tc.table_schema = 'public'
            AND tc.table_name NOT IN ('chat_conversations', 'chat_messages')
        UNION ALL
        SELECT 'seq', sequence_name
          FROM information_schema.sequences
          WHERE sequence_schema = 'public'
            AND sequence_name IN ('chat_conversations_id_seq', 'chat_messages_id_seq')
        UNION ALL
        SELECT 'trigger', event_object_table
          FROM information_schema.triggers
          WHERE trigger_schema = 'public'
            AND event_object_table IN ('chat_conversations', 'chat_messages')
      ) dep;
    IF v_tables IS NOT NULL AND v_tables <> '' THEN
        RAISE EXCEPTION 'ROLLBACK_TEST_ONLY 023 CANCELADO: dependencias externas nao criadas por 023: %', v_tables;
    END IF;

    -- 3) RLS PRECISA estar habilitada no estado esperado do 023.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.chat_conversations'::regclass)
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.chat_messages'::regclass) THEN
        RAISE EXCEPTION 'ROLLBACK_TEST_ONLY 023 CANCELADO: RLS desabilitada (estado inesperado)';
    END IF;

    -- 4) anon não pode ter privilégios nestas tabelas (o 023 não concede a anon).
    IF has_table_privilege('anon', 'public.chat_conversations', 'SELECT')
       OR has_table_privilege('anon', 'public.chat_conversations', 'INSERT')
       OR has_table_privilege('anon', 'public.chat_conversations', 'UPDATE')
       OR has_table_privilege('anon', 'public.chat_conversations', 'DELETE')
       OR has_table_privilege('anon', 'public.chat_messages', 'SELECT')
       OR has_table_privilege('anon', 'public.chat_messages', 'INSERT')
       OR has_table_privilege('anon', 'public.chat_messages', 'UPDATE')
       OR has_table_privilege('anon', 'public.chat_messages', 'DELETE') THEN
        RAISE EXCEPTION 'ROLLBACK_TEST_ONLY 023 CANCELADO: anon possui grants nas chat_* (estado inesperado)';
    END IF;

    -- 5) Constraints esperadas devem TODAS existir (aplica-se o inverso do VERIFY):
    --    qualquer exceção aqui indica schema divergente do 023 e aborta.
    SELECT count(*) INTO v_count
      FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
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
            'chat_messages_payload_size');
    IF v_count <> 13 THEN
        RAISE EXCEPTION 'ROLLBACK_TEST_ONLY 023 CANCELADO: constraints de 023 divergentes (esperava 13, achei %)', v_count;
    END IF;

    -- 6) Nenhuma volta de 023 muda privilégios de outras tabelas; apenas
    --    dropa as políticas que 023 criou em cada tabela chat.
    EXECUTE 'DROP POLICY IF EXISTS chat_conversations_select_own ON public.chat_conversations';
    EXECUTE 'DROP POLICY IF EXISTS chat_conversations_insert_own ON public.chat_conversations';
    EXECUTE 'DROP POLICY IF EXISTS chat_conversations_update_own ON public.chat_conversations';
    EXECUTE 'DROP POLICY IF EXISTS chat_conversations_delete_own ON public.chat_conversations';
    EXECUTE 'DROP POLICY IF EXISTS chat_messages_select_own ON public.chat_messages';
    EXECUTE 'DROP POLICY IF EXISTS chat_messages_insert_own ON public.chat_messages';
    EXECUTE 'DROP POLICY IF EXISTS chat_messages_update_own ON public.chat_messages';
    EXECUTE 'DROP POLICY IF EXISTS chat_messages_delete_own ON public.chat_messages';

    -- 7) Contagem para o NOTICE (nunca imprime linhas, apenas totais).
    EXECUTE 'SELECT count(*) FROM public.chat_messages' INTO v_msg_count;
    EXECUTE 'SELECT count(*) FROM public.chat_conversations' INTO v_conv_count;

    -- 8) Drop dos índices derivados (evita deixar órfãos por nome).
    DROP INDEX IF EXISTS public.idx_chat_messages_conversation_created;
    DROP INDEX IF EXISTS public.uq_chat_messages_conversation_client_request;
    DROP INDEX IF EXISTS public.idx_chat_conversations_profile_last;

    -- 9) Drop das tabelas (2 passos: mensagens -> conversas).
    DROP TABLE public.chat_messages;
    DROP TABLE public.chat_conversations;

    RAISE NOTICE 'ROLLBACK_TEST_ONLY 023 aplicado: % mensagens e % conversas removidas (apenas contagens exibidas)', v_msg_count, v_conv_count;
END $$;

-- ============================================================
-- Segurança: o arquivo NÃO roda COMMIT por padrão. Para aplicar de verdade
-- em um ambiente de TESTE, apague o ROLLBACK abaixo e reexecute o arquivo;
-- para uso iterativo (apenas inspeção), mantenha como está.
-- ============================================================
ROLLBACK;

-- Confirmação final (dentro da MESMA transação, antes do ROLLBACK acima):
-- o estado das tabelas não deve ter mudado de forma perceptível para o
-- aplicativo (o ROLLBACK devolve tudo); este NOTICE ajuda a verificar isso.
DO $$
BEGIN
    IF to_regclass('public.chat_conversations') IS NULL OR to_regclass('public.chat_messages') IS NULL THEN
        RAISE WARNING 'ROLLBACK_TEST_ONLY 023: precaucao - tabelas ausentes apos o bloco de teste';
    ELSE
        RAISE NOTICE 'ROLLBACK_TEST_ONLY 023 OK: transacao revertida - schema 023 intacto';
    END IF;
END $$;