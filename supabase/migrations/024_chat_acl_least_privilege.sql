-- ============================================================
-- 024_chat_acl_least_privilege.sql
-- MENOR PRIVILÉGIO NAS TABELAS DO CHAT (PESSOAL-13C2A.3)
--
-- Causa confirmada no Supabase de TESTE: o bootstrap padrão do
-- Supabase executa default privileges no schema public que concedem
-- ALL ON TABLES aos roles anon/authenticated e ao role de serviço.
-- Quando o 023 criou chat_conversations e chat_messages, esses
-- default privileges concederam a anon e authenticated privilégios
-- ALÉM dos grants explícitos mínimos do 023 — inclusive DELETE em
-- chat_messages (só deve ser possível remover mensagens pelo cascade
-- da conversa) e TRUNCATE/REFERENCES/TRIGGER nas duas tabelas. O
-- VERIFY 023 comprovou com o erro P0001: "VERIFY 023 FAIL:
-- authenticated concluiu DELETE individual de mensagem" (a RLS
-- permitia deletar a própria mensagem e o privilégio extra vindo do
-- default deixou a operação concluir em vez de falhar com 42501).
--
-- Correção: REVOKE ALL das três origens de privilégio herdado
-- (PUBLIC, anon, authenticated) nas DUAS tabelas e reaplicação
-- EXATA dos grants mínimos por tabela:
--   * chat_conversations -> authenticated: SELECT, INSERT, UPDATE, DELETE
--   * chat_messages      -> authenticated: SELECT, INSERT, UPDATE
--
-- chat_messages NÃO concede DELETE/TRUNCATE/REFERENCES/TRIGGER;
-- anon PERMANECE sem nenhum privilégio nas duas tabelas.
--
-- Idempotente: REVOKE de privilégio inexistente é noop; GRANT
-- preserva grants existentes. Em transação, nomes totalmente
-- qualificados. NÃO altera RLS, NÃO toca policies, NÃO mexe em
-- constraints (o cascade da FK entre as duas tabelas permanece) e
-- NÃO revoga nada dos roles de serviço nem do dono das tabelas — os
-- privilégios deles (dono/superusuário e/ou defaults) ficam intactos.
-- Sem DML. Sem NOTIFY pgrst duplicado: 5 statements.
-- ============================================================

BEGIN;

-- ---------- 1. Revogar TODO privilégio herdado/default ----------
REVOKE ALL PRIVILEGES ON TABLE public.chat_conversations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.chat_conversations FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.chat_conversations FROM authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.chat_messages FROM authenticated;

-- ---------- 2. Grants mínimos por tabela ----------
-- Conversas: CRUD completo (o browser cria/edita a própria conversa via
-- PostgREST com a sessão; o DELETE é filtrado pela RLS para o próprio
-- perfil e cascateia as mensagens).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_conversations TO authenticated;

-- Mensagens: SEM DELETE para authenticated — remover mensagem individual
-- nunca faz parte do UX; apagar a conversa (DELETE em chat_conversations,
-- também filtrado pela RLS) remove tudo pelo cascade da FK.
-- Também sem TRUNCATE/REFERENCES/TRIGGER.
GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_messages TO authenticated;

COMMIT;