// chatTypes.ts — Tipos do chat persistente "Pergunte às suas finanças"
// (PESSOAL-13C2). Lógica pura, sem I/O, sem secrets.
//
// O desenho segue o modelo canônico do projeto: 1 usuário ⇝ 1 perfil
// (app_metadata.profile_id) ⇝ N conversas de chat com RLS por perfil via
// app.jwt_profile_id(). Nenhum profile_id atravessa estas interfaces: a
// identidade vem exclusivamente do JWT do usuário em cada requisição.

import type { TrendCard } from '../finance-ai/types.js';

export type ChatRole = 'user' | 'assistant';

export type ChatMessageStatus = 'pending' | 'completed' | 'failed';

export interface ChatPeriod {
  start: string;
  end: string;
}

// ── Contexto analítico persistente (PESSOAL-13C3B-E3) ────────────

export type ChatAnalysisIntent = 'growth_categories' | 'savings_opportunities';
export type ChatAnalysisWindowStyle = 'six_complete' | 'five_plus_current' | 'six_plus_current';

/** Âmbito da janela de tendência NO TURNO ATUAL (só datas; jamais valores). */
export interface ChatAnalysisWindow {
  start: string;
  end: string;
  baseStart: string;
  baseEnd: string;
  recentStart: string;
  recentEnd: string;
}

/**
 * Contexto analítico persistido na conversa para follow-ups elípticos
 * ("E 5%?", "E só em supermercado?", "E incluindo este mês?") de tendências e
 * oportunidades de economia. Regras PESSOAL-13C3B-E3:
 *   - Pode persistir: intent, datas, estilo de janela, percentual e path
 *     canônico de categoria;
 *   - JAMAIS persiste valores monetários, médias, deltas, cards, linhas,
 *     descrições, UUIDs nem agregados (o follow-up SEMPRE re-consulta dados).
 */
export interface ChatAnalysisContext {
  version: 1;
  intent: ChatAnalysisIntent;
  windowStyle: ChatAnalysisWindowStyle;
  /** Relógio local (YYYY-MM-DD) usado ao derivar a janela atual. */
  anchorDate: string;
  window: ChatAnalysisWindow;
  includeCurrentMonth: boolean;
  isPartialCurrent: boolean;
  simulationPct?: number;
  /** Lente canônica resolvida (matchTerm de resolveCategory), quando restrita. */
  categoryPath?: string;
}

/**
 * Contexto de continuidade persistido na conversa (coluna context jsonb) e
 * usado como fator de UX para resolver follow-ups ("E em maio?"). NUNCA é
 * limite de segurança: a identidade/perímetro vem da RLS via JWT.
 */
export interface ChatContextState {
  /** Lente de categoria efetivamente usada na última pergunta (ex.: "Alimentação > Supermercado"). */
  category: string | null;
  /** Intenção determinística da última pergunta, quando determinada. */
  intent: string | null;
  /** Período efetivamente analisado na última pergunta. */
  period: ChatPeriod | null;
  /** Resumos das últimas respostas (teto CHAT_SUMMARIES_MAX) para o bloco do Gemini. */
  summaries: string[];
  /**
   * Contexto analítico persistente (PESSOAL-13C3B-E3). Presente somente após
   * turno analítico concluído; os turnos não analíticos o limpam e os contextos
   * legados não o contêm (retrocompatível).
   */
  analysis?: ChatAnalysisContext | null;
}

/** Payload SANITIZADO da resposta assistant (reconstrói os cards no UI). */
export interface ChatMessagePayload {
  engine?: 'deterministic' | 'gemini';
  geminiCallCount?: number;
  toolsUsed?: string[];
  evidence?: Array<{ label: string; value: string }>;
  notice?: string;
  /**
   * Cards temáticos (tendências/oportunidades) já sanitizados em
   * payloadSanitize.ts (PESSOAL-13C3B-E4): somente fields mapeados, nunca a
   * resposta bruta do router/Gemini. `cards: []` significa "houve cards, mas
   * vazios"; ausente significa "turno sem cards" (retrocompatível).
   */
  cards?: TrendCard[];
}

export interface ChatConversationRow {
  id: string;
  title: string;
  context: ChatContextState | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  status: ChatMessageStatus;
  content: string;
  payload: ChatMessagePayload | null;
  intent: string | null;
  engine: string | null;
  period_analyzed: ChatPeriod | null;
  client_request_id: string | null;
  error: string | null;
  created_at: string;
}

export const CHAT_SUMMARIES_MAX = 4;
export const CHAT_TITLE_MAX_CHARS = 160;
export const CHAT_CONTENT_MAX_CHARS = 12000;
export const CHAT_CLIENT_REQUEST_ID_MAX = 128;

/** Teto do bloco de contexto compacto enviado ao Gemini (caracteres). */
export const CHAT_GEMINI_CONTEXT_CHARS = 2000;
/** Limite de mensagens recentes inclusas no bloco do Gemini. */
export const CHAT_GEMINI_RECENT_MSGS = 3;