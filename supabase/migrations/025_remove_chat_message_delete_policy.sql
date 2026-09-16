-- ============================================================
-- 025_remove_chat_message_delete_policy.sql
-- REMOÇÃO DA POLICY LATENTE DE DELETE INDIVIDUAL (PESSOAL-13C2A.4)
--
-- O VERIFY 024 comprovou a ACL correta (authenticated SEM DELETE em
-- chat_messages; DELETE direto -> 42501; cascade funcionando). Porém a
-- policy chat_messages_delete_own criada pelo 023 permanece no catálogo.
-- Embora inativa pela ACL, ela é desnecessária e reduz a defesa em
-- profundidade: a única forma de remover mensagens deve ser o cascade da
-- conversa (DELETE em chat_conversations). Esta migration remove SOMENTE
-- essa policy, sem tocar em nada mais.
--
-- Não altera grants, as demais policies, tabelas, constraints (o cascade
-- entre as duas tabelas permanece), dados nem functions.
-- Idempotente (DROP POLICY IF EXISTS). Em transação.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS chat_messages_delete_own ON public.chat_messages;

COMMIT;