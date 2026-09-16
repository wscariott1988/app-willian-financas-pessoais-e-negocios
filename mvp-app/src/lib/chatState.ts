// chatState.ts — Lógica PURA do chat persistente "Pergunte às suas finanças"
// (PESSOAL-13C2). Reducer sem DOM/sem rede, testável em node. O componente
// FinanceAiSection apenas despacha ações e renderiza.
//
// Princípios:
//   - mensagens otimistas usam clientRequestId como chave; ao sincronizar com o
//     servidor, duplicatas do MESMO clientRequestId são descartadas (o servidor
//     garante UNIQUE(conversation_id, client_request_id));
//   - nova conversa nunca apaga o histórico salvo (a lista vive no DB);
//   - excluir conversa exige confirmação explícita (confirmDeleteId);
//   - página de mensagens: página mais recente carregada primeiro, "ver mais
//     antigas" prepend sem duplicar.

export interface ChatConversationItem {
  id: string;
  title: string;
  lastMessageAt: string;
}

export type UiMessageStatus = 'sent' | 'pending' | 'completed' | 'failed';

export interface UiMessage {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  status: UiMessageStatus;
  /** true = ainda não confirmado pelo servidor (mostrar enquanto processa). */
  optimistic: boolean;
  clientRequestId: string | null;
  createdAt: string;
  engine?: 'deterministic' | 'gemini';
  periodAnalyzed?: { start: string; end: string } | null;
  evidence?: Array<{ label: string; value: string }>;
  error?: string | null;
}

export interface ChatUiState {
  conversations: ChatConversationItem[];
  activeId: string | null;
  messages: UiMessage[];
  hasMore: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** id da conversa aguardando confirmação de exclusão. */
  confirmDeleteId: string | null;
}

export interface SentPayload {
  answer: string;
  engine?: 'deterministic' | 'gemini';
  periodAnalyzed?: { start: string; end: string } | null;
  evidence?: Array<{ label: string; value: string }>;
}

export type ChatAction =
  | { type: 'conversations_loaded'; conversations: ChatConversationItem[] }
  | { type: 'select'; id: string | null }
  | { type: 'new_chat' }
  | { type: 'messages_loaded'; messages: UiMessage[]; hasMore: boolean }
  | { type: 'older_loaded'; messages: UiMessage[]; hasMore: boolean }
  | { type: 'send_start'; clientRequestId: string; question: string }
  | { type: 'send_success'; clientRequestId: string; payload: SentPayload }
  | { type: 'send_error'; clientRequestId: string; message: string }
  | { type: 'delete_confirm'; id: string | null }
  | { type: 'deleted'; id: string }
  | { type: 'fail'; message: string }
  | { type: 'reset_error' };

/** Tamanho da página de mensagens carregada do backend. */
export const CHAT_PAGE_SIZE = 40;
/** Título de exibição otimista (o servidor é a fonte canônica do título salvo). */
export const CHAT_UI_TITLE_MAX = 80;

export function createChatState(): ChatUiState {
  return {
    conversations: [],
    activeId: null,
    messages: [],
    hasMore: false,
    status: 'idle',
    error: null,
    confirmDeleteId: null,
  };
}

/** O título otimista de uma nova pergunta para a lista, antes do servidor salvar. */
export function uiTitleFor(question: string): string {
  const firstLine = (question ?? '').split('\n')[0].trim();
  if (!firstLine) return 'Conversa';
  return firstLine.length <= CHAT_UI_TITLE_MAX
    ? firstLine
    : `${firstLine.slice(0, CHAT_UI_TITLE_MAX - 1).trimEnd()}…`;
}

/** Enter envia; Shift+Enter quebra linha (compatível com o comportamento do chat). */
export function shouldSendOnEnter(key: string, shiftKey: boolean): boolean {
  return key === 'Enter' && !shiftKey;
}

function dedupeMessages(list: UiMessage[]): UiMessage[] {
  const seen = new Set<string>();
  const out: UiMessage[] = [];
  for (const m of list) {
    const id = m.key || m.clientRequestId || '';
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out;
}

/** Remove otimistas duplicados de um lote de mensagens vindas do servidor. */
export function mergeServerMessages(
  existing: UiMessage[],
  incoming: UiMessage[],
): UiMessage[] {
  const serverKeys = new Set(incoming.map((m) => m.key));
  const serverCrids = new Set(
    incoming.map((m) => m.clientRequestId).filter((c): c is string => !!c),
  );
  const kept = existing.filter(
    (m) =>
      !serverKeys.has(m.key) &&
      !(m.optimistic && m.clientRequestId && serverCrids.has(m.clientRequestId)),
  );
  return dedupeMessages([...kept, ...incoming]);
}

export function chatReducer(state: ChatUiState, action: ChatAction): ChatUiState {
  switch (action.type) {
    case 'conversations_loaded': {
      const activeGone =
        state.activeId !== null &&
        !action.conversations.some((c) => c.id === state.activeId);
      return {
        ...state,
        conversations: action.conversations,
        status: 'ready',
        error: null,
        activeId: activeGone ? null : state.activeId,
        messages: activeGone ? [] : state.messages,
        hasMore: activeGone ? false : state.hasMore,
      };
    }
    case 'select':
      return {
        ...state,
        activeId: action.id,
        messages: [],
        hasMore: false,
        status: action.id === null ? 'ready' : 'loading',
        error: null,
        confirmDeleteId: null,
      };
    case 'new_chat':
      return {
        ...state,
        activeId: null,
        messages: [],
        hasMore: false,
        status: 'ready',
        error: null,
        confirmDeleteId: null,
      };
    case 'messages_loaded':
      return {
        ...state,
        messages: action.messages,
        hasMore: action.hasMore,
        status: 'ready',
        error: null,
      };
    case 'older_loaded':
      return {
        ...state,
        messages: dedupeMessages([...action.messages, ...state.messages]),
        hasMore: action.hasMore,
        status: 'ready',
      };
    case 'send_start': {
      const crid = action.clientRequestId;
      const now = new Date().toISOString();
      const cleaned = state.messages.filter(
        (m) => m.clientRequestId !== crid,
      );
      return {
        ...state,
        messages: [
          ...cleaned,
          {
            key: `u-${crid}`,
            role: 'user',
            text: action.question,
            status: 'sent',
            optimistic: true,
            clientRequestId: crid,
            createdAt: now,
          },
          {
            key: crid,
            role: 'assistant',
            text: '',
            status: 'pending',
            optimistic: true,
            clientRequestId: crid,
            createdAt: now,
            error: null,
          },
        ],
        error: null,
      };
    }
    case 'send_success': {
      const p = action.payload;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.role === 'assistant' && m.clientRequestId === action.clientRequestId
            ? {
                ...m,
                status: 'completed',
                optimistic: false,
                text: p.answer,
                engine: p.engine,
                periodAnalyzed: p.periodAnalyzed ?? undefined,
                evidence: p.evidence ?? undefined,
                error: null,
              }
            : m,
        ),
        error: null,
      };
    }
    case 'send_error':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.role === 'assistant' && m.clientRequestId === action.clientRequestId
            ? {
                ...m,
                status: 'failed',
                optimistic: false,
                text: '',
                error: action.message,
              }
            : m,
        ),
      };
    case 'delete_confirm':
      return { ...state, confirmDeleteId: action.id };
    case 'deleted': {
      const conversations = state.conversations.filter((c) => c.id !== action.id);
      const wasActive = state.activeId === action.id;
      return {
        ...state,
        conversations,
        confirmDeleteId: null,
        activeId: wasActive ? null : state.activeId,
        messages: wasActive ? [] : state.messages,
        hasMore: wasActive ? false : state.hasMore,
      };
    }
    case 'fail':
      return { ...state, status: 'error', error: action.message };
    case 'reset_error':
      return { ...state, error: null, status: state.status === 'error' ? 'idle' : state.status };
    default:
      return state;
  }
}