-- ============================================================
-- 023_chat_persistence.sql
-- CHAT DE "PERGUNTE AS SUAS FINANCAS" PERSISTENTE (PESSOAL-13C2)
-- LOCAL E CLOUD — NAO APLICAR NESTA FASE (validar antes no Supabase
-- de teste via SQL editor + scripts read-only PREFLIGHT/VERIFY 023).
--
-- O que entrega:
--   1. Determinada 2 tabelas publicas no schema public:
--        * chat_conversations  -> conversa por perfil (titulo, contexto de
--                                 continuidade, ultima atividade);
--        * chat_messages       -> historico user/assistant (status, payload
--                                 sanitizado para reconstruir cards, ids de
--                                 idempotencia sem clicar duas vezes).
--   2. RLS isolando por perfil usando a IDENTIDADE CANONICA do projeto
--      (app.jwt_profile_id()/app.jwt_role(), mesma regra das tabelas
--      financeiras reais). Nenhum profile_id vem do body legitimo: o browser
--      cria conversas via PostgREST com a sessao (INSERT passa pelo
--      WITH CHECK profile_id = app.jwt_profile_id()); o SERVIDOR (ask.ts)
--      grava mensagens usando o MESMO JWT do usuario — nunca service_role.
--   3. Idempotencia: UNIQUE(conversation_id, client_request_id) impede duplicar
--      a mensagem mesmo com clique duplo/reenvio (Postgres trata NULL como
--      DISTINTO: mensagens legadas sem client_request_id continuam valendo).
--   4. Colunas/CHECK defensivos (limites de texto, enum de status/role) e
--      indices de leitura (lista de conversas por perfil; linha do tempo da
--      conversa). Nenhuma retencao/exclusao automatica por tempo.
--
-- NUNCA armazenar nestas tabelas: JWT, GEMINI_API_KEY, resposta bruta do
-- provider, thoughtSignature, functionCall bruto, prompts internos, secrets.
-- O payload jsonb de chat_messages guarda SOMENTE o resultado sanitizado
-- (intent, engine, period_analyzed, tools_used, notice) para reconstrucao
-- dos cards no UI. A resposta de texto viva em content.
--
-- Compatibilidade cloud: usa apenas app.jwt_profile_id()/app.jwt_role()
-- (presentes em local e no Supabase Cloud a partir de 007_cloud_compat.sql)
-- e gen_random_uuid()/now() core do Postgres. Sem dependencia de serviço.
-- ============================================================

BEGIN;

-- ---------- 1. chat_conversations ----------
CREATE TABLE chat_conversations (
    id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    profile_id      uuid        NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    title           text        NOT NULL DEFAULT '',
    -- Contexto de continuidade (lens da ultima pergunta): json como
    -- {"category", "intent", "period": {start,end}, "summaries": [...]}.
    -- Fator de UX, nunca limite de seguranca (identidade vem do JWT/RLS).
    context         jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chat_conversations_title_length CHECK (char_length(title) <= 160),
    -- Tetos de tamanho (PESSOAL-13C2A.1): context compacto de continuidade.
    -- length() sobre a serialização é portável (não exige jsonb_octet_length PG14+).
    CONSTRAINT chat_conversations_context_size
        CHECK (context IS NULL OR length(context::text) <= 20480)
);

CREATE INDEX idx_chat_conversations_profile_last
    ON chat_conversations (profile_id, last_message_at DESC);

-- ---------- 2. chat_messages ----------
CREATE TABLE chat_messages (
    id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id   uuid        NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
    -- 'user'  -> pergunta persistida pelo servidor (fluxo ask.ts);
    -- 'assistant' -> resposta/erro (status pending -> completed/failed).
    role              text        NOT NULL CHECK (role IN ('user', 'assistant')),
    status            text        NOT NULL DEFAULT 'completed'
                                  CHECK (status IN ('pending', 'completed', 'failed')),
    content           text        NOT NULL DEFAULT '' CHECK (char_length(content) <= 12000),
    -- Sanitizado (NUNCA resposta bruta do provider nem secrets).
    payload           jsonb,
    intent            text,
    engine            text        CHECK (engine IS NULL OR engine IN ('deterministic', 'gemini')),
    period_analyzed   jsonb,
    client_request_id text        CHECK (client_request_id IS NULL OR char_length(client_request_id) <= 128),
    -- Erro AMIGAVEL sanitizado (apenas para status='failed'); sem stack traces.
    error             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chat_messages_response_payload CHECK (
        role <> 'assistant'
        OR payload IS NULL
        OR jsonb_typeof(payload) = 'object'
        OR jsonb_typeof(payload) = 'null'
    ),
    -- Tetos de tamanho (PESSOAL-13C2A.1): payload sanitizado (cards do UI)
    -- nunca transporta a resposta bruta do provedor nem secrets; o tamanho é
    -- limitado por CHECK portável.
    CONSTRAINT chat_messages_payload_size
        CHECK (payload IS NULL OR length(payload::text) <= 20480)
);

CREATE UNIQUE INDEX uq_chat_messages_conversation_client_request
    ON chat_messages (conversation_id, client_request_id);

CREATE INDEX idx_chat_messages_conversation_created
    ON chat_messages (conversation_id, created_at);

-- ---------- 3. RLS (identidade canonica: app.jwt_profile_id()) ----------
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- O usuario so ve/edita AS PROPRIAS conversas do proprio perfil.
CREATE POLICY chat_conversations_select_own ON chat_conversations FOR SELECT
    USING (profile_id = app.jwt_profile_id());
CREATE POLICY chat_conversations_insert_own ON chat_conversations FOR INSERT
    WITH CHECK (profile_id = app.jwt_profile_id());
CREATE POLICY chat_conversations_update_own ON chat_conversations FOR UPDATE
    USING (profile_id = app.jwt_profile_id())
    WITH CHECK (profile_id = app.jwt_profile_id());
CREATE POLICY chat_conversations_delete_own ON chat_conversations FOR DELETE
    USING (profile_id = app.jwt_profile_id());

-- mensagens: a propriedade vem da CONVERSA do proprio perfil (sem coluna
-- profile_id duplicada) — INSERT de mensagem em conversa alheia retorna 0
-- linhas e nao expoe conteudo; DELETE de conversa propria cascata mensagens.
CREATE POLICY chat_messages_select_own ON chat_messages FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM chat_conversations c
        WHERE c.id = chat_messages.conversation_id
          AND c.profile_id = app.jwt_profile_id()
    ));
CREATE POLICY chat_messages_insert_own ON chat_messages FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM chat_conversations c
        WHERE c.id = chat_messages.conversation_id
          AND c.profile_id = app.jwt_profile_id()
    ));
CREATE POLICY chat_messages_update_own ON chat_messages FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM chat_conversations c
        WHERE c.id = chat_messages.conversation_id
          AND c.profile_id = app.jwt_profile_id()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM chat_conversations c
        WHERE c.id = chat_messages.conversation_id
          AND c.profile_id = app.jwt_profile_id()
    ));
CREATE POLICY chat_messages_delete_own ON chat_messages FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM chat_conversations c
        WHERE c.id = chat_messages.conversation_id
          AND c.profile_id = app.jwt_profile_id()
    ));

-- ---------- 4. Grants (browser e servidor usam a sessao do usuario) ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON chat_messages TO authenticated;
-- chat_messages não tem DELETE para authenticated: remover mensagens
-- individuais nao faz parte do UX; apagar a conversa (DELETE em
-- chat_conversations) remove tudo por cascata.

COMMIT;