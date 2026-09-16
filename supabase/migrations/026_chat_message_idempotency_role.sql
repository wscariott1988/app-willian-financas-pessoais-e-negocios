-- ============================================================
-- 026_chat_message_idempotency_role.sql
-- CHAT — IDEMPOTENCIA POR TENTATIVA USER+ASSISTANT (PESSOAL-13C2B.3)
-- LOCAL E CLOUD. Aplicar via SQL editor / supabase db push.
--
-- Contexto do bug real (PESSOAL-13C2B.2): o indice unico criado pelo 023,
-- UNIQUE(conversation_id, client_request_id) SEM role, impedia a coexistencia
-- da mensagem user e da ancora assistant de um MESMO client_request_id — a
-- insercao da ancora disparava 23505 em toda pergunta nova e o endpoint
-- devolvia 502 "Servico de inteligencia indisponivel no momento.".
--
-- Esta migration troca o indice para a chave final
-- (conversation_id, client_request_id, role), permitindo EXATAMENTE duas
-- linhas por tentativa:
--   * uma role='user'    (pergunta persistida);
--   * uma role='assistant' (ancora idempotente: pending -> completed/failed).
-- O reenvio de um MESMO client_request_id segue bloqueado por role: a ancora
-- duplicada levanta 23505 e o servidor re-resolve pending/in_flight,
-- completed/cached, failed/cached_failure.
--
-- Escopo: SOMENTE o indice unico de chat_messages. Nao altera dados, RLS,
-- policies, grants, FKs nem outras tabelas. Nao remove as mensagens orfas
-- (linhas user sem ancora) ja existentes.
--
-- Reaplicavel com seguranca: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF
-- NOT EXISTS + validacao defensiva da definicao final dentro da transacao.
-- Se o indice novo ja estiver correto (estado JA_APLICADO), a reexecucao e
-- um no-op e a validacao continua confirmando a definicao esperada.
-- ============================================================

BEGIN;

-- 1. Remove o indice antigo de DUAS colunas (sem role), se ainda existir.
DROP INDEX IF EXISTS public.uq_chat_messages_conversation_client_request;

-- 2. Indice UNIQUE final com as TRES colunas na ordem exata. Em PostgreSQL,
-- NULLS DISTINCT (padrao) mantem linhas legadas sem client_request_id como
-- distintas — o mesmo comportamento pretendido pelo 023.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_conversation_client_request_role
    ON public.chat_messages (conversation_id, client_request_id, role);

-- 3. Validacao defensiva da definicao final: indice presente, UNIQUE, com as
--    tres colunas (conversation_id, client_request_id, role) na ordem exata e
--    indice antigo ausente. Qualquer divergencia aborta a transacao.
DO $$
DECLARE
    v_ok boolean;
    v_indnkeyatts smallint;
BEGIN
    IF to_regclass('public.uq_chat_messages_conversation_client_request_role') IS NULL THEN
        RAISE EXCEPTION '026 FAIL: indice uq_chat_messages_conversation_client_request_role nao foi criado';
    END IF;

    IF to_regclass('public.uq_chat_messages_conversation_client_request') IS NOT NULL THEN
        RAISE EXCEPTION '026 FAIL: indice antigo uq_chat_messages_conversation_client_request ainda existe';
    END IF;

    SELECT i.indisunique, i.indnkeyatts
      INTO v_ok, v_indnkeyatts
      FROM pg_index i
     WHERE i.indexrelid = 'public.uq_chat_messages_conversation_client_request_role'::regclass;

    IF v_ok IS DISTINCT FROM true OR v_indnkeyatts <> 3 THEN
        RAISE EXCEPTION '026 FAIL: indice final nao e UNIQUE com 3 colunas de chave';
    END IF;

    SELECT (SELECT string_agg(a.attname, ',' ORDER BY g)
              FROM generate_series(0, i.indnkeyatts - 1) g
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[g]
             WHERE a.attrelid = i.indrelid) = 'conversation_id,client_request_id,role'
      INTO v_ok
      FROM pg_index i
     WHERE i.indexrelid = 'public.uq_chat_messages_conversation_client_request_role'::regclass;

    IF v_ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION '026 FAIL: ordem das colunas do indice final divergente (esperado conversation_id, client_request_id, role)';
    END IF;
END $$;

COMMIT;