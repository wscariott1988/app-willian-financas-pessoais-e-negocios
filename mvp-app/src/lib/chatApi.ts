// chatApi.ts — CRUD do chat no browser via PostgREST (PESSOAL-13C2).
// Usa a sessão Supabase atual do browser: a RLS da migration 023 isola por
// perfil (app.jwt_profile_id()), então NUNCA há perfil arbitrário aqui — o
// INSERT de conversa passa pelo WITH CHECK (profile_id = jwt_profile_id()).
//
// Paginação: as mensagens são lidas da MAIS RECENTE para a mais antiga e
// devolvidas em ordem cronológica ao reducer ('older_loaded' faz o prepend).

import { supabase } from '../supabaseClient';
import { resolveProfileId } from './profileIdentity';
import {
  CHAT_PAGE_SIZE,
  type ChatConversationItem,
  type UiMessage,
} from './chatState';

interface RawChatRow {
  id: string;
  title: string | null;
  last_message_at: string;
}

interface RawMessageRow {
  id: string;
  role: 'user' | 'assistant';
  status: string;
  content: string | null;
  payload: {
    engine?: 'deterministic' | 'gemini';
    evidence?: Array<{ label: string; value: string }>;
  } | null;
  engine: string | null;
  period_analyzed: { start: string; end: string } | null;
  client_request_id: string | null;
  error: string | null;
  created_at: string;
}

export class ChatApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatApiError';
  }
}

async function ownProfileId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const profileId = resolveProfileId(data.user ? { user: data.user } : null);
  if (!profileId) {
    throw new ChatApiError('Perfil não identificado. Entre novamente para continuar.');
  }
  return profileId;
}

function toUiMessage(row: RawMessageRow): UiMessage {
  const status: UiMessage['status'] =
    row.role === 'user'
      ? 'sent'
      : row.status === 'pending'
        ? 'pending'
        : row.status === 'failed'
          ? 'failed'
          : 'completed';
  const engine =
    row.engine === 'deterministic' || row.engine === 'gemini'
      ? row.engine
      : undefined;
  return {
    key: row.id,
    role: row.role,
    text: status === 'failed' ? '' : (row.content ?? ''),
    status,
    optimistic: false,
    clientRequestId: row.client_request_id,
    createdAt: row.created_at,
    engine,
    periodAnalyzed: row.period_analyzed ?? undefined,
    evidence: row.payload?.evidence,
    error: status === 'failed' ? (row.error ?? 'Não foi possível responder agora.') : null,
  };
}

export async function listConversations(signal?: AbortSignal): Promise<ChatConversationItem[]> {
  let q = supabase
    .from('chat_conversations')
    .select('id, title, last_message_at')
    .order('last_message_at', { ascending: false })
    .limit(30);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) {
    throw new ChatApiError('Não foi possível carregar o histórico de conversas.');
  }
  const rows = (data ?? []) as RawChatRow[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title || '',
    lastMessageAt: r.last_message_at,
  }));
}

export async function createConversation(): Promise<{ id: string }> {
  const profileId = await ownProfileId();
  const { data, error } = await supabase
    .from('chat_conversations')
    .insert({ profile_id: profileId, title: '' })
    .select('id')
    .single();
  if (error) {
    throw new ChatApiError('Não foi possível criar a conversa.');
  }
  return { id: (data as { id: string }).id };
}

export async function deleteConversation(id: string): Promise<void> {
  const { error } = await supabase.from('chat_conversations').delete().eq('id', id);
  if (error) {
    throw new ChatApiError('Não foi possível excluir a conversa.');
  }
}

export interface MessagesPage {
  messages: UiMessage[];
  hasMore: boolean;
}

/**
 * Lê uma página de mensagens. page=0 é a MAIS RECENTE (janela que o usuário
 * vê no fim da conversa); page>0 são mensagens mais antigas (prepend).
 */
export async function listMessages(
  conversationId: string,
  page: number,
  signal?: AbortSignal,
): Promise<MessagesPage> {
  const from = page * CHAT_PAGE_SIZE;
  const to = from + CHAT_PAGE_SIZE - 1;
  let q = supabase
    .from('chat_messages')
    .select(
      'id, role, status, content, payload, engine, period_analyzed, client_request_id, error, created_at',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .range(from, to);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) {
    throw new ChatApiError('Não foi possível carregar as mensagens.');
  }
  const rows = (data ?? []) as RawMessageRow[];
  const messages = [...rows].reverse().map(toUiMessage);
  return { messages, hasMore: rows.length === CHAT_PAGE_SIZE };
}