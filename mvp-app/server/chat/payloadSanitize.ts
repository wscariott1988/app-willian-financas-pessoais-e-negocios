// payloadSanitize.ts — Sanitização defensiva do payload persistido das
// mensagens assistant (PESSOAL-13C3B-E4).
//
// Fronteira única de persistência: completeChatTurn (chatStore) passa o payload
// vindo do router por sanitizeChatPayload antes de gravar em
// chat_messages.payload. Assim o que sobrevive a um F5/remount (listMessages)
// é SEMPRE o conteúdo sanitizado, nunca a resposta bruta do router/Gemini.
//
// Regras PESSOAL-13C3B-E4:
//   - aceita SOMENTE os 4 kinds conhecidos de cards (growth/new/spike/savings);
//   - remove cards/rows/evidências com tipos inválidos (degradação controlada,
//     nunca lança nem derruba a requisição com 500);
//   - truncagem segura com limites nomeados por campo (sem números mágicos);
//   - texto simples: tags HTML arbitrárias são removidas;
//   - nunca persiste linhas completas de transação, objetos do Supabase,
//     raw_description, UUIDs, JWT, profile_id nem a resposta bruta: só os
//     campos mapeados abaixo atravessam esta fronteira.
//
// O payload gravado permanece confortavelmente abaixo do CHECK de tamanho da
// migration 023 (chat_messages_payload_size ≤ 20.480 caracteres).

import type { ChatMessagePayload } from './chatTypes.js';
import type { TrendCard, TrendCardKind, TrendCardRow } from '../finance-ai/types.js';

export const PAYLOAD_CARDS_MAX = 3;
export const PAYLOAD_CARD_ROWS_MAX = 7;
export const PAYLOAD_CARD_TITLE_MAX = 160;
export const PAYLOAD_CARD_SUBTITLE_MAX = 200;
export const PAYLOAD_CARD_ROW_LABEL_MAX = 120;
export const PAYLOAD_CARD_ROW_VALUE_MAX = 120;
export const PAYLOAD_NOTICE_MAX = 500;
export const PAYLOAD_EVIDENCE_MAX = 12;
export const PAYLOAD_EVIDENCE_LABEL_MAX = 120;
export const PAYLOAD_EVIDENCE_VALUE_MAX = 200;
export const PAYLOAD_TOOLS_MAX = 12;
export const PAYLOAD_TOOL_MAX = 60;

const TREND_CARD_KINDS: ReadonlySet<string> = new Set<TrendCardKind>([
  'growth',
  'new',
  'spike',
  'savings',
]);

const HTML_TAG_RE = /<[^>]*>/g;

/** Texto simples sem tags HTML arbitrárias, truncado com segurança. Nunca lança. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const plain = value.replace(HTML_TAG_RE, '').trim();
  if (!plain) return null;
  return plain.length > max ? plain.slice(0, max) : plain;
}

function cleanTextList(input: unknown, max: number, cap: number): string[] {
  const out: string[] = [];
  if (!Array.isArray(input)) return out;
  for (const item of input) {
    if (out.length >= cap) break;
    const text = cleanText(item, max);
    if (text) out.push(text);
  }
  return out;
}

function sanitizeEvidence(
  input: unknown,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (!Array.isArray(input)) return out;
  for (const item of input) {
    if (out.length >= PAYLOAD_EVIDENCE_MAX) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const label = cleanText(raw.label, PAYLOAD_EVIDENCE_LABEL_MAX);
    const value = cleanText(raw.value, PAYLOAD_EVIDENCE_VALUE_MAX);
    if (!label || !value) continue;
    out.push({ label, value });
  }
  return out;
}

function sanitizeCardRow(input: unknown): TrendCardRow | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const label = cleanText(raw.label, PAYLOAD_CARD_ROW_LABEL_MAX);
  const value = cleanText(raw.value, PAYLOAD_CARD_ROW_VALUE_MAX);
  if (!label || !value) return null;
  return { label, value };
}

function sanitizeCard(input: unknown): TrendCard | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.kind !== 'string' || !TREND_CARD_KINDS.has(raw.kind)) return null;
  const title = cleanText(raw.title, PAYLOAD_CARD_TITLE_MAX);
  if (!title) return null;
  const subtitle = cleanText(raw.subtitle, PAYLOAD_CARD_SUBTITLE_MAX) ?? '';
  const rows: TrendCardRow[] = [];
  if (Array.isArray(raw.rows)) {
    for (const row of raw.rows) {
      if (rows.length >= PAYLOAD_CARD_ROWS_MAX) break;
      const sane = sanitizeCardRow(row);
      if (sane) rows.push(sane);
    }
  }
  return { kind: raw.kind as TrendCardKind, title, subtitle, rows };
}

/**
 * Sanitiza um payload de resposta assistant para persistência. A cardinalidade
 * de PRESENÇA de `cards` e `notice` é preservada quando já vieram definidos
 * (mesmo vazios), para o cache reconstituir exatamente o que o turno original
 * produziu — um turno com cards `[]` deve voltar `cards: []`, nunca omitido.
 */
export function sanitizeChatPayload(input: unknown): ChatMessagePayload {
  const out: ChatMessagePayload = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const raw = input as Record<string, unknown>;

  if (raw.engine === 'deterministic' || raw.engine === 'gemini') {
    out.engine = raw.engine;
  }
  if (
    typeof raw.geminiCallCount === 'number' &&
    Number.isFinite(raw.geminiCallCount) &&
    raw.geminiCallCount >= 0
  ) {
    out.geminiCallCount = Math.floor(raw.geminiCallCount);
  }
  const tools = cleanTextList(raw.toolsUsed, PAYLOAD_TOOL_MAX, PAYLOAD_TOOLS_MAX);
  if (tools.length > 0) out.toolsUsed = tools;
  const evidence = sanitizeEvidence(raw.evidence);
  if (evidence.length > 0) out.evidence = evidence;
  if (raw.notice !== undefined) {
    const notice = cleanText(raw.notice, PAYLOAD_NOTICE_MAX);
    if (notice !== null) out.notice = notice;
  }
  if (raw.cards !== undefined) {
    if (Array.isArray(raw.cards)) {
      const cards: TrendCard[] = [];
      for (const card of raw.cards) {
        if (cards.length >= PAYLOAD_CARDS_MAX) break;
        const sane = sanitizeCard(card);
        if (sane) cards.push(sane);
      }
      out.cards = cards;
    } else {
      out.cards = [];
    }
  }
  return out;
}