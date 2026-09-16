// chatStore.ts — Persistência do chat persistente (PESSOAL-13C2).
//
// Todas as funções recebem um cliente Supabase já autenticado com o JWT do
// USUÁRIO (os mesmos "createUserSupabaseClient" do endpoint). A RLS da
// migration 023_chat_persistence.sql é quem garante o isolamento por perfil:
// esta camada NUNCA passa profile_id (nem do body, nem derivado) e NUNCA usa
// service_role.
//
// Idempotência (clique duplo / reenvio):
//   - a linha assistant com status 'pending' + UNIQUE(conversation_id,
//     client_request_id) é a âncora: só existe UMA tentativa por
//     client_request_id;
//   - reenvio do MESMO client_request_id → in_flight / cached / cached_failure;
//   - retry após falha usa um NOVO client_request_id (nova tentativa) e o
//     histórico mantém a mensagem failed visível.
//
// Sem transação distribuída: cada statement do PostgREST é atômico por si só;
// em caso de falha no meio, o status da âncora (pending/failed) permite
// recuperação determinística no próximo request.

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ChatContextState,
  ChatMessagePayload,
  ChatPeriod,
} from './chatTypes.js';
import { CHAT_CONTENT_MAX_CHARS } from './chatTypes.js';

const PGRST_ROW_MISSING = 'PGRST116';
const PG_UNIQUE_VIOLATION = '23505';

/** Conversa inexistente OU de outro perfil (indistinguíveis por design: RLS retorna 0 linhas). */
export class ChatOwnershipError extends Error {
  constructor() {
    super('Conversa não encontrada.');
    this.name = 'ChatOwnershipError';
  }
}

export interface ChatConversationSnapshot {
  id: string;
  title: string;
  context: ChatContextState | null;
}

export type BeginTurnResult =
  | { kind: 'fresh'; conversation: ChatConversationSnapshot }
  | { kind: 'in_flight' }
  | {
      kind: 'cached';
      answer: string;
      payload: ChatMessagePayload | null;
      periodAnalyzed: ChatPeriod | null;
    }
  | { kind: 'cached_failure'; message: string };

export interface BeginTurnInput {
  conversationId: string;
  clientRequestId: string;
  question: string;
}

export interface CompleteTurnInput {
  conversationId: string;
  clientRequestId: string;
  answer: string;
  payload: ChatMessagePayload;
  intent: string | null;
  engine: 'deterministic' | 'gemini';
  periodAnalyzed: ChatPeriod | null;
  context: ChatContextState;
  /** Preenchido apenas na PRIMEIRA pergunta da conversa (título automático). */
  setTitle: boolean;
  title: string;
}

export interface FailTurnInput {
  conversationId: string;
  clientRequestId: string;
  /** Mensagem amigável JÁ sanitizada (friendlyForOutcome). Nunca stack trace. */
  message: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

async function getConversationSnapshot(
  cli: SupabaseClient,
  conversationId: string,
): Promise<ChatConversationSnapshot | null> {
  const { data, error } = await cli
    .from('chat_conversations')
    .select('id, title, context')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) {
    if (error.code === PGRST_ROW_MISSING) return null;
    throw error;
  }
  if (!data) return null;
  return data as ChatConversationSnapshot;
}

interface AssistantRowLite {
  status: string;
  content: string;
  payload: ChatMessagePayload | null;
  period_analyzed: ChatPeriod | null;
  error: string | null;
}

async function findAssistantByRequestId(
  cli: SupabaseClient,
  conversationId: string,
  clientRequestId: string,
): Promise<AssistantRowLite | null> {
  const { data, error } = await cli
    .from('chat_messages')
    .select('status, content, payload, period_analyzed, error')
    .eq('conversation_id', conversationId)
    .eq('client_request_id', clientRequestId)
    .eq('role', 'assistant')
    .maybeSingle();
  if (error) {
    if (error.code === PGRST_ROW_MISSING) return null;
    throw error;
  }
  if (!data) return null;
  return data as AssistantRowLite;
}

function resolveExisting(row: AssistantRowLite): BeginTurnResult {
  if (row.status === 'pending') return { kind: 'in_flight' };
  if (row.status === 'completed') {
    return {
      kind: 'cached',
      answer: row.content ?? '',
      payload: row.payload ?? null,
      periodAnalyzed: row.period_analyzed ?? null,
    };
  }
  return {
    kind: 'cached_failure',
    message:
      row.error && row.error.trim()
        ? row.error
        : 'A análise anterior falhou. Tente novamente.',
  };
}

async function upsertUserMessage(
  cli: SupabaseClient,
  input: BeginTurnInput,
): Promise<void> {
  // PESSOAL-13C2B.3: alvo de conflito TRIPLO (conversation_id,
  // client_request_id, role) casando EXATAMENTE o índice único final
  // uq_chat_messages_conversation_client_request_role do 026. A âncora
  // assistant usa o MESMO client_request_id com role='assistant': sem a role
  // no índice (023 antigo) a segunda linha violava 23505 e toda pergunta nova
  // falhava com 502 genérico.
  const { error } = await cli.from('chat_messages').upsert(
    {
      conversation_id: input.conversationId,
      client_request_id: input.clientRequestId,
      role: 'user',
      status: 'completed',
      content: input.question,
    },
    {
      onConflict: 'conversation_id,client_request_id,role',
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

/**
 * Abre um turno: valida a conversa (própria), registra a pergunta do usuário e
 * a âncora assistant 'pending'. Devolve o veredito de idempotência. Nunca
 * lança quando o turno já existe (in_flight/cached/cached_failure).
 */
export async function beginChatTurn(
  cli: SupabaseClient,
  input: BeginTurnInput,
): Promise<BeginTurnResult> {
  const snapshot = await getConversationSnapshot(cli, input.conversationId);
  if (!snapshot) throw new ChatOwnershipError();

  const existing = await findAssistantByRequestId(
    cli,
    input.conversationId,
    input.clientRequestId,
  );
  if (existing) return resolveExisting(existing);

  await upsertUserMessage(cli, input);

  const { error } = await cli.from('chat_messages').insert({
    conversation_id: input.conversationId,
    client_request_id: input.clientRequestId,
    role: 'assistant',
    status: 'pending',
    content: '',
  });
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findAssistantByRequestId(
        cli,
        input.conversationId,
        input.clientRequestId,
      );
      if (raced) return resolveExisting(raced);
      throw error;
    }
    throw error;
  }

  return { kind: 'fresh', conversation: snapshot };
}

/** Conclui a âncora assistant + atualiza a conversa (contexto/título/atividade). */
export async function completeChatTurn(
  cli: SupabaseClient,
  input: CompleteTurnInput,
): Promise<void> {
  const now = new Date().toISOString();
  const { error: msgErr } = await cli
    .from('chat_messages')
    .update({
      status: 'completed',
      content: input.answer.slice(0, CHAT_CONTENT_MAX_CHARS),
      payload: input.payload,
      intent: input.intent,
      engine: input.engine,
      period_analyzed: input.periodAnalyzed ?? null,
      error: null,
    })
    .eq('conversation_id', input.conversationId)
    .eq('client_request_id', input.clientRequestId)
    .eq('role', 'assistant');
  if (msgErr) throw msgErr;

  const patch: Record<string, unknown> = {
    context: input.context,
    updated_at: now,
    last_message_at: now,
  };
  if (input.setTitle) patch.title = input.title;
  const { error: convErr } = await cli
    .from('chat_conversations')
    .update(patch)
    .eq('id', input.conversationId);
  if (convErr) throw convErr;
}

/** Marca a âncora assistant como failed (erro amigável sanitizado) e registra atividade. */
export async function failChatTurn(
  cli: SupabaseClient,
  input: FailTurnInput,
): Promise<void> {
  const now = new Date().toISOString();
  const { error: msgErr } = await cli
    .from('chat_messages')
    .update({
      status: 'failed',
      content: '',
      payload: { error: true },
      error: input.message.slice(0, 2000),
    })
    .eq('conversation_id', input.conversationId)
    .eq('client_request_id', input.clientRequestId)
    .eq('role', 'assistant');
  if (msgErr) throw msgErr;

  const { error: convErr } = await cli
    .from('chat_conversations')
    .update({ updated_at: now, last_message_at: now })
    .eq('id', input.conversationId);
  if (convErr) throw convErr;
}