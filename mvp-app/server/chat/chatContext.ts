// chatContext.ts — Derivação do contexto de continuidade do chat (PESSOAL-13C2).
// Lógica pura: monta o estado de contexto persistido na conversa, o resumo das
// últimas respostas e o bloco compacto enviado ao Gemini (com teto rígido).
//
// O contexto é fator de UX para follow-ups ("E em maio?") e NUNCA limite de
// segurança: o perímetro continua sendo a RLS via JWT. Por design, a lente de
// categoria/intenção SÓ é persistida quando o turno foi determinístico (lens
// canônica). Turns de análise/conselho (Gemini) não carregam categoria — o
// follow-up seguinte não herda uma lente que a última pergunta não teve.

import {
  CHAT_GEMINI_CONTEXT_CHARS,
  CHAT_GEMINI_RECENT_MSGS,
  CHAT_SUMMARIES_MAX,
  CHAT_TITLE_MAX_CHARS,
  type ChatAnalysisContext,
  type ChatContextState,
  type ChatPeriod,
  type ChatProjectionContext,
} from './chatTypes.js';

export function emptyContext(): ChatContextState {
  return { category: null, intent: null, period: null, summaries: [] };
}

function truncate(value: string, max: number): string {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1).trimEnd()}…`;
}

/** Resumo compacto de uma resposta (linha única, teto de caracteres). */
export function summaryOf(answer: string): string {
  return truncate(answer, 240);
}

/** Título automático: primeira linha limpa da primeira pergunta. */
export function titleFromQuestion(question: string): string {
  const firstLine = (question ?? '').split('\n')[0].trim();
  return truncate(firstLine || 'Conversa', CHAT_TITLE_MAX_CHARS);
}

function appendSummary(ctx: ChatContextState, summary: string): string[] {
  if (!summary) return ctx.summaries;
  const next = [...ctx.summaries, summary];
  if (next.length > CHAT_SUMMARIES_MAX) next.splice(0, next.length - CHAT_SUMMARIES_MAX);
  return next;
}

export interface ContextTurnInput {
  intent: string | null;
  category: string | null;
  periodAnalyzed: ChatPeriod | null;
  answer: string;
  /**
   * Contexto analítico persistente (PESSOAL-13C3B-E3). Quando definido, o turno
   * era analítico e o contexto é (re)gravado; quando ausente (turno tradicional
   * ou Gemini) o contexto analítico é LIMPO — nenhum follow-up de análise
   * sobrevive a um turno não analítico.
   */
  analysis?: ChatAnalysisContext | null;
  /**
   * Contexto de projeção persistente (PESSOAL-13C4A-E3). Quando definido, o
   * turno era de projeção real e o contexto é (re)gravado; quando ausente
   * (turno comum ou Gemini) o contexto de projeção é LIMPO — nenhum follow-up
   * de projeção sobrevive a um turno não-projeção.
   */
  projection?: ChatProjectionContext | null;
}

/**
 * Novo contexto após um turno concluído. Categoria/intenção persistem SOMENTE
 * quando o turno determinístico informou uma (lens canônica); caso contrário a
 * lente anterior é descartada (a última pergunta não teve aquela lente).
 */
export function contextFromTurn(
  prev: ChatContextState | null,
  input: ContextTurnInput,
): ChatContextState {
  const base = prev ?? emptyContext();
  return {
    category: input.category ?? null,
    intent: input.intent ?? null,
    period: input.periodAnalyzed ?? null,
    summaries: appendSummary(base, summaryOf(input.answer)),
    analysis: input.analysis ?? null,
    projection: input.projection ?? null,
  };
}

function periodPhrase(p: ChatPeriod | null): string | null {
  if (!p) return null;
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(p.start);
  const matchesSameMonth =
    !!m && `${m[1]}-${m[2]}` === p.end.slice(0, 7);
  if (!matchesSameMonth) return `${p.start} a ${p.end}`;
  const MONTHS = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];
  const monthName = MONTHS[Number(m[2]) - 1] ?? null;
  return monthName ? `${monthName} de ${m[1]}` : `${p.start} a ${p.end}`;
}

/**
 * Bloco compacto de contexto para o Gemini. Retorna '' quando não há contexto.
 * Teto rígido: total <= CHAT_GEMINI_CONTEXT_CHARS; últimas mensagens limitadas
 * a CHAT_GEMINI_RECENT_MSGS. Nunca contém dados brutos sensíveis: apenas a
 * lente persiste e resumos de respostas (sem secrets).
 */
export function geminiContextBlock(
  context: ChatContextState | null,
  recentMessages: string[] = [],
): string {
  const ctx = context ?? emptyContext();
  const lines: string[] = [];
  if (ctx.category) lines.push(`Categoria em foco: ${ctx.category}`);
  if (ctx.intent) lines.push(`Intenção anterior: ${ctx.intent}`);
  const p = periodPhrase(ctx.period);
  if (p) lines.push(`Período do contexto: ${p}`);
  if (ctx.summaries.length > 0) {
    lines.push(`Resumos de respostas anteriores: ${ctx.summaries.join(' · ')}`);
  }
  const recent = recentMessages
    .filter((r) => r && r.trim())
    .slice(-CHAT_GEMINI_RECENT_MSGS)
    .map((r) => truncate(r, 300));
  if (recent.length > 0) {
    lines.push(`Últimas mensagens: ${recent.join(' | ')}`);
  }
  if (lines.length === 0) return '';
  let block = lines.join('\n');
  if (block.length > CHAT_GEMINI_CONTEXT_CHARS) {
    block = truncate(block, CHAT_GEMINI_CONTEXT_CHARS);
  }
  return block;
}