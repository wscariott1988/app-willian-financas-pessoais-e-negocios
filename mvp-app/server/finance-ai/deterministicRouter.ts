// deterministicRouter.ts — Roteador determinístico de alta confiança (PESSOAL-13C1).
//
// Perguntas financeiras SIMPLES são respondidas direto dos dados financeiros,
// SEM instanciar nem chamar o Gemini (custo zero). O Gemini fica para análises,
// explicações e recomendações — quando a intenção não é reconhecida com alta
// confiança, ou quando a pergunta pede conselho/opinião, o fast-path devolve
// null e o endpoint mantém o fluxo Gemini atual.
//
// Regras canônicas reutilizadas (fonte única, nunca duplicada):
//   - summaryByPeriod / expenseMonthlyAggregate / matchesCategoryTerm (src/lib);
//   - transferências NUNCA entram como receita nem despesa;
//   - status NÃO filtra totais (mesma regra do Resumo do período);
//   - categorias vêm SOMENTE do category_id vinculado (canonical_path/display_name);
//   - deleted_at IS NULL sempre;
//   - nenhum profile_id no body: o isolamento vem da RLS via JWT do usuário.
//
// Contrato de período (tela): quando o frontend envia `period`, ele é o período
// EFETIVAMENTE aplicado na tela (start/end). Regras:
//   - sem data explícita → usa exatamente o período selecionado na tela;
//   - "neste mês", "esse mês", "no período" → período da tela;
//   - mês/ano explicitamente mencionado na pergunta PREVALECE sobre a tela;
//   - "em 2026" → 01/01/2026 a 31/12/2026.
//
// Observabilidade: o percurso determinístico que retorna é sinalizado pelo
// endpoint como engine='deterministic' com geminiCallCount=0.
//
// Interpretação da pergunta (PESSOAL-13C1.1):
//   - a pergunta principal é separada de instruções complementares: rótulos
//     copiados ("Pergunta", "Resultado esperado"), texto após '?', quebra de
//     linha, ';', '!' ou verbos de instrução ("informe", "diga", ...) NUNCA
//     participam da interpretação da intenção nem da categoria;
//   - precedência de intenções: "qual mês mais gastei" > categoria > comparação
//     mensal > "quantas despesas" > "quanto gastei" > receitas > saldo. A
//     presença isolada de "resultado" (ex.: "resultado esperado") não vira saldo;
//   - a categoria termina antes de instrução, período explícito ("em 2026"),
//     expressão relativa ("no mês") ou pontuação delimitadora;
//   - a categoria é resolvida para o nome canônico (categories table, RLS via
//     JWT) ANTES da consulta. Categoria inválida → esclarecimento sem custo
//     (nunca consulta texto contaminado, nunca R$ 0,00, nunca Gemini). R$ 0,00
//     só quando a categoria foi reconhecida e realmente não há despesas.
//
// Degradação segura: o fast-path exige paginação via `.range` (presente no
// postgREST real e em clients que o implementam). Clients sem `.range` (test
// doubles / integrações incompletas) NÃO geram total possivelmente truncado:
// o router devolve null e o endpoint segue o fluxo Gemini conhecido — mantendo
// os contratos existentes. O comportamento completo (paginação) vale em produção.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AskResponse, EvidenceItem, TrendCard, TrendCardRow } from './types.js';
import {
  summaryByPeriod,
  expenseMonthlyAggregate,
  matchesCategoryTerm,
  normalizeCategoryTerm,
  MONTH_FULL,
} from '../../src/lib/analyticsInsights.js';
import type { AnalyticsTxRow } from '../../src/lib/analytics.js';
import type {
  ProjectionEngineResult,
  ProjectionLensInput,
  YearMonth,
} from '../../src/lib/analyticsProjection.js';
import { addMonths, formatShortDate } from '../../src/lib/period.js';
import {
  fetchProjection,
  saoPauloTodayISO,
  ProjectionDataError,
} from './projectionAdapter.js';
import {
  mapProjectionToPayloadV1,
  PROJECTION_INTENTS,
  type ProjectionPayloadDeviation,
  type ProjectionPayloadInsufficientV1,
  type ProjectionPayloadIntent,
  type ProjectionPayloadQuality,
  type ProjectionPayloadSuccessV1,
  type ProjectionPayloadV1,
} from './projectionPayloadV1.js';
import {
  analyzeCategoryGrowth,
  buildTrendWindow,
  savingsOpportunities,
  classifySavingsCategory,
  type ExcludedSavingsOpportunity,
  type GrowthCategoryResult,
  type GrowthClassification,
  type SavingsClassification,
  type SavingsOpportunity,
  type TrendWindow,
  type TrendWindowStyle,
} from '../../src/lib/analyticsTrends.js';
import { MAX_QUESTION_LENGTH } from './orchestrator.js';
import { AskError, isSupabaseQueryError, providerStatusOf, type ProjectionRouteMode } from './observability.js';
import type { ChatAnalysisContext, ChatContextState, ChatPeriod, ChatProjectionContext } from '../chat/chatTypes.js';
import { PAYLOAD_NOTICE_MAX } from '../chat/payloadSanitize.js';
import { dedupeDisplayNames } from './noticeDedup.js';

export type DeterministicIntent =
  | 'total_expenses'
  | 'total_income'
  | 'period_balance'
  | 'expense_count'
  | 'category_total'
  | 'month_most_spent'
  | 'monthly_comparison'
  | 'growth_categories'
  | 'savings_opportunities'
  | 'projection_base'
  | 'projection_current_month'
  | 'projection_month_comparison'
  | 'projection_categories'
  | 'projection_clarification';

export interface DeterministicIntentResult {
  intent: DeterministicIntent;
  category?: string;
  /** Janela de tendência detectada (PESSOAL-13C3B-E2); padrão six_complete. */
  trendWindow?: TrendWindowStyle;
  /** Percentual de simulação (PESSOAL-13C3B-E2); padrão 10. */
  percent?: number;
  /** true quando o percentual explícito é inválido (0/negativo/>100). */
  percentInvalid?: boolean;
}

export interface DeterministicAnswer {
  intent: DeterministicIntent;
  response: AskResponse;
  /** Lente de categoria efetivamente aplicada (matchTerm canônico), quando resolvida. */
  category?: string;
  /**
   * Contexto analítico persistível (PESSOAL-13C3B-E3): apenas intent/datas/
   * estilo/percentual/path canônico — nunca valores monetários. Ausente em
   * turnos tradicionais (o endpoint então limpa o contexto analítico).
   */
  analysis?: ChatAnalysisContext;
  /**
   * Contexto de projeção persistível (PESSOAL-13C4A-E3): intent, mês de
   * referência (YYYY-MM), lente canônica + rótulo — nunca payload/valores.
   * Presente apenas em turnos de projeção REAL (payload.status === 'success');
   * ausente em projeções que caíram em esclarecimento.
   */
  projection?: ChatProjectionContext;
  /** Como o turno de projeção surgiu ('direct' | 'follow_up'); ausente sem projeção. */
  projectionRoute?: ProjectionRouteMode;
}

export interface DeterministicRouterDeps {
  supabase: SupabaseClient;
  question: string;
  period?: { start: string; end: string };
  /** Contexto de continuidade da conversa (PESSOAL-13C2). Opcional: sem contexto = comportamento atual. */
  context?: ChatContextState;
  /**
   * Relógio local injetável (YYYY-MM-DD, America/Sao_Paulo) para as janelas de
   * tendência (PESSOAL-13C3B-E2). Sem ele usa a data de hoje — nunca
   * recomenda período por extrapolação.
   */
  nowISO?: string;
}

// ── Helpers de formatação (pt-BR, sem Markdown) ───────────────

function numberValue(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function signedBrl(v: number): string {
  return v >= 0 ? `+${brl(v)}` : brl(v);
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function pad2(v: number): string {
  return String(v).padStart(2, '0');
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function lastDayOf(year: string, month: number): string {
  return `${year}-${pad2(month)}-${pad2(new Date(Number(year), month, 0).getDate())}`;
}

// ── Normalização de texto (acentos/maiúsculas/espaços) ─────────

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Separação da pergunta principal (PESSOAL-13C1.1) ───────────

const COMPLEMENT_VERBS =
  /\b(?:informe|diga|mostre|retorne|responda)\b/i;
const COPIED_LABELS =
  /\b(?:pergunta|resultado\s+esperado)\b/gi;

/**
 * Extrai SOMENTE a pergunta principal. Delimitadores que encerram a pergunta:
 * rótulos copiados de prompt ("Pergunta", "Resultado esperado" — removidos),
 * primeiro '?', quebra de linha, ';'/'!' e verbos de instrução complementar.
 * Instruções complementares podem sugerir campos, mas NUNCA participam da
 * interpretação (nem da categoria).
 */
function extractMainQuestion(raw: string): string {
  const firstNl = raw.indexOf('\n');
  let t = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
  t = t
    .replace(COPIED_LABELS, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  let end = t.length;
  const qIndex = t.indexOf('?');
  if (qIndex >= 0) end = Math.min(end, qIndex);
  const verb = COMPLEMENT_VERBS.exec(t);
  if (verb) end = Math.min(end, verb.index);
  const punct = /[;!]/.exec(t);
  if (punct) end = Math.min(end, punct.index);
  return t.slice(0, end).trim();
}

// ── Meses (português) ──────────────────────────────────────────

const MONTH_FULL_NORM: ReadonlyArray<string> = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

const MONTH_SHORT_NORM: ReadonlyArray<string> = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez',
];

const MONTH_ALT = [...MONTH_FULL_NORM, ...MONTH_SHORT_NORM].join('|');

const MONTH_BY_NORM: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (const [i, name] of MONTH_FULL_NORM.entries()) map[name] = i + 1;
  for (const [i, abbr] of MONTH_SHORT_NORM.entries()) map[abbr] = i + 1;
  return map;
})();

function monthNameOfYearMonth(key: string): string {
  const year = key.slice(0, 4);
  const month = Number(key.slice(5, 7));
  return `${MONTH_FULL[month - 1] ?? ''} de ${year}`;
}

// ── Período da pergunta ────────────────────────────────────────

export type DetectedPeriodSource = 'month' | 'year' | 'screen' | 'current' | 'context';

export interface ResolvedQueryPeriod {
  start: string;
  end: string;
  source: DetectedPeriodSource;
  year?: string;
  month?: string;
  monthLower?: string;
}

function yearOfToken(norm: string): string | null {
  const m = /\b((?:19|20)\d{2})\b/.exec(norm);
  return m ? m[1] : null;
}

function collectMonthNumbers(norm: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`\\b(${MONTH_ALT})\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const n = MONTH_BY_NORM[m[1]];
    if (n !== undefined && !out.includes(n)) out.push(n);
  }
  return out;
}

function firstMonthNumber(norm: string): number | null {
  const re = new RegExp(`\\b(${MONTH_ALT})\\b`);
  const m = re.exec(norm);
  if (!m) return null;
  return MONTH_BY_NORM[m[1]] ?? null;
}

function resolveQueryPeriod(
  question: string,
  screen: { start: string; end: string } | null,
): ResolvedQueryPeriod {
  const norm = normalizeText(question);
  const monthNumber = firstMonthNumber(norm);
  const year = yearOfToken(norm);

  const screenYear =
    screen && /^\d{4}-\d{2}-\d{2}$/.test(screen.start) ? screen.start.slice(0, 4) : null;
  const currentYear = String(new Date().getFullYear());

  if (monthNumber) {
    const y = year ?? screenYear ?? currentYear;
    return {
      start: `${y}-${pad2(monthNumber)}-01`,
      end: lastDayOf(y, monthNumber),
      source: 'month',
      year: y,
      month: `${y}-${pad2(monthNumber)}`,
      monthLower: `${MONTH_FULL[monthNumber - 1] ?? ''} de ${y}`,
    };
  }
  const currentYearRef = /\b(?:este|esse|neste|nesse|em todo|todo o|o|no|nesse) ano\b/.test(norm);
  if (currentYearRef) {
    const y = year ?? String(new Date().getFullYear());
    return { start: `${y}-01-01`, end: `${y}-12-31`, source: 'year', year: y };
  }
  if (year) {
    return { start: `${year}-01-01`, end: `${year}-12-31`, source: 'year', year };
  }
  if (screen && isValidScreenPeriod(screen)) {
    return { start: screen.start, end: screen.end, source: 'screen' };
  }
  const now = new Date();
  const y = String(now.getFullYear());
  const m = now.getMonth() + 1;
  return {
    start: `${y}-${pad2(m)}-01`,
    end: lastDayOf(y, m),
    source: 'current',
    year: y,
    month: `${y}-${pad2(m)}`,
    monthLower: `${MONTH_FULL[m - 1] ?? ''} de ${y}`,
  };
}

function isValidScreenPeriod(p: { start: string; end: string }): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(p.start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(p.end) &&
    p.start <= p.end
  );
}

// ── Contexto de continuidade (PESSOAL-13C2) ────────────────────

/** Prefixos de follow-up que indicam continuacao da conversa. */
const CONTINUATION_RE =
  /^(?:e|e\s+(?:em|no|na|com|para|ai|agora|depois|sobre)|e\s+se|entao|depois)\b/i;

export interface AppliedContext {
  /** Pergunta (possivelmente aumentada) para interpretacao. */
  question: string;
  /** Categoria herdada do contexto nesta pergunta (lens), ou null. */
  inheritedCategory: string | null;
  /**
   * true = o periodo NÃO foi citado explicitamente na pergunta, logo o periodo
   * do contexto prevalece sobre o periodo da tela (prioridade do briefing:
   * explicito > contexto > tela).
   */
  contextPeriodFallback: boolean;
}

/**
 * Aplica a continuidade da conversa a uma pergunta follow-up:
 *   - "E em maio?"            => herda a categoria do contexto, mantem maio;
 *   - "E aí?"/"E no período?"  => monta pergunta canonica com categoria+periodo
 *                                  do contexto (e marca fallback de periodo);
 *   - "E com combustível?"     => troca a lente (categoria nova); periodo herda
 *                                  do contexto se nao citado;
 *   - "E com combustível em junho?" => substitui ambos (nada herdado);
 *   - pergunta SEM prefixo de continuacao => igual a hoje (sem contexto).
 * Nunca injeta contexto em perguntas de conselho/analise (não canonizáveis).
 */
export function applyContextToQuestion(
  question: string,
  context: ChatContextState,
): AppliedContext {
  const q = (question ?? '').trim();
  const fallback: AppliedContext = {
    question: q,
    inheritedCategory: null,
    contextPeriodFallback: false,
  };
  if (!context || !q) return fallback;
  const norm = normalizeText(q);
  if (!CONTINUATION_RE.test(norm)) return fallback;

  const tempResolved = resolveQueryPeriod(q, null);
  const stripped = stripPeriodPhrases(norm, tempResolved);
  const explicitCategory =
    extractCategoryTerm(stripped) ?? extractContinuationCategory(stripped);
  const explicitPeriod =
    tempResolved.source === 'month' || tempResolved.source === 'year';

  if (explicitCategory || (context.intent !== 'category_total' &&
      context.intent !== 'month_most_spent' &&
      context.intent !== 'total_expenses' &&
      context.intent !== 'total_income' &&
      context.intent !== 'period_balance' &&
      context.intent !== 'expense_count')) {
    // Lente nova explícita OU sem intencao canonizavel no contexto: apenas o
    // período pode ser herdado quando nao citado ("E com combustível?").
    return { question: q, inheritedCategory: null, contextPeriodFallback: !explicitPeriod };
  }

  if (!explicitPeriod) {
    // "E aí?" / "E no período?" => pergunta canonica herda tudo (categoria menor).
    let augmented: string | null = null;
    if (context.category) {
      augmented = `quanto gastei em ${context.category} no período`;
    } else if (context.intent === 'total_expenses') {
      augmented = 'quanto gastei no período';
    } else if (context.intent === 'total_income') {
      augmented = 'quanto recebi no período';
    } else if (context.intent === 'period_balance') {
      augmented = 'qual foi o resultado do período';
    } else if (context.intent === 'expense_count') {
      augmented = 'quantas despesas no período';
    }
    return {
      question: augmented ?? q,
      inheritedCategory: context.category,
      contextPeriodFallback: true,
    };
  }

  // "E em maio?" => herda a categoria (lens), mantem o periodo citado.
  if (context.category) {
    const phrase = tempResolved.monthLower ?? '';
    return {
      question: `quanto gastei em ${context.category} em ${phrase}`.trim(),
      inheritedCategory: context.category,
      contextPeriodFallback: false,
    };
  }
  return { question: q, inheritedCategory: null, contextPeriodFallback: false };
}

/** Converte um período do contexto em ResolvedQueryPeriod (fonte 'context'). */
function resolvedFromContextPeriod(p: ChatPeriod): ResolvedQueryPeriod {
  const m = /^(\d{4})-(\d{2})-01$/.exec(p.start);
  const fullMonth =
    !!m && p.end === lastDayOf(m[1], Number(m[2]));
  return fullMonth
    ? {
        start: p.start,
        end: p.end,
        source: 'context',
        year: m[1],
        month: `${m[1]}-${m[2]}`,
        monthLower: `${MONTH_FULL[Number(m[2]) - 1] ?? ''} de ${m[1]}`,
      }
    : { start: p.start, end: p.end, source: 'context' };
}

function periodPhraseOf(p: ResolvedQueryPeriod): string {
  if (p.source === 'month' || (p.source === 'context' && p.monthLower)) {
    return `em ${p.monthLower ?? ''}`.trim();
  }
  if (p.source === 'year') return `em ${p.year ?? ''}`.trim();
  return 'no período';
}

function periodDisplay(p: { start: string; end: string }): string {
  return `${formatShortDate(p.start)} a ${formatShortDate(p.end)}`;
}

/**
 * Remove as referências de período (mês/ano/mês corrente) do texto normalizado,
 * isolando o possível termo de categoria. Nunca altera dados reais — só análise.
 */
function stripPeriodPhrases(norm: string, resolved: ResolvedQueryPeriod): string {
  let t = norm;
  if (resolved.year) {
    t = t.replace(new RegExp(`\\s*(?:em|no|na|de|durante)?\\s*${resolved.year}\\b`, 'g'), ' ');
  }
  if (resolved.monthLower) {
    const normMonth = normalizeText(resolved.monthLower);
    t = t.replace(new RegExp(`\\s*(?:em|no|na|de|durante)?\\s*${normMonth}\\b`, 'g'), ' ');
  }
  const monthNames = [...MONTH_FULL_NORM, ...MONTH_SHORT_NORM].join('|');
  t = t.replace(
    new RegExp(`\\s*(?:em|no|na|de|durante)?\\s*(?:${monthNames})(?:\\s+de\\s+(?:19|20)\\d{2})?\\b`, 'g'),
    ' ',
  );
  t = t.replace(
    /\s+(?:no|neste|nesse|este|esse|do|o)?\s*(?:mes|meses|periodo|ano|trimestre)\b/g,
    ' ',
  );
  return t.replace(/\s{2,}/g, ' ').trim();
}

function extractCategoryTerm(stripped: string): string | null {
  let t = stripped.replace(/[?.!;]+$/g, '').trim();
  if (!t) return null;
  const re =
    /\b(?:gastei|gasto|gastos|gaste|despesas|despesa|compras|total)\s+(?:em|com|na|no|para)\s+(.+)$/i;
  const m = re.exec(t);
  if (!m) return null;
  // A categoria termina antes de: pontuação delimitadora, instrução residual,
  // lista (vírgula), período explícito ("em 2026") e expressão relativa
  // ("no mês"). Paths canônicos ("Alimentação > Supermercado") são preservados.
  let term = m[1];
  term = term
    .replace(/[?!.;]+.*$/, ' ')
    .split(',')[0]
    .replace(/^\s*(?:em|com|na|no|para)\s+/, ' ')
    .replace(/\s+(?:em|no|na|de|durante)?\s*(?:(?:19|20)\d{2})\b.*$/g, ' ')
    .replace(
      /\s+(?:no|o|neste|nesse|este|esse|do|em)?\s*(?:mes|meses|periodo|ano|trimestre)\b.*$/g,
      ' ',
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!term) return null;
  const normTerm = normalizeText(term);
  if (
    /\b(?:quanto|qual|meses?|periodo|ano|informe|diga|mostre|retorne|responda)\b/.test(
      normTerm,
    )
  ) {
    return null;
  }
  const firstToken = normTerm.split(/\s+/)[0];
  if (MONTH_BY_NORM[firstToken]) return null;
  return term;
}

/**
 * Follow-ups do tipo "E com <termo>?" (ou "E em <termo>?") trocam a lente de
 * categoria: o termo após a preposição vira a categoria explícita da pergunta.
 * Palavras de ligação/vazio ("aí", "agora", "depois", "no período") não contam
 * como lente. Period refs já foram removidos de `stripped` (ver
 * stripPeriodPhrases), então "E com combustível em junho?" cai aqui como
 * "e com combustivel".
 */
const CONTINUATION_CATEGORY_RE = /^e\s+(?:com|em|na|no|de|para|sobre)\s+(.+)$/i;

function extractContinuationCategory(stripped: string): string | null {
  const t = (stripped ?? '').replace(/[?.!;]+$/g, '').trim();
  if (!t) return null;
  const m = CONTINUATION_CATEGORY_RE.exec(t);
  if (!m) return null;
  let term = m[1].replace(/\s{2,}/g, ' ').trim();
  if (!term) return null;
  const normTerm = normalizeText(term);
  if (
    !normTerm.includes('>') &&
    /\b(?:quanto|qual|ai|agora|depois|meses?|periodo|ano|informe|diga|entao)\b/.test(
      normTerm,
    )
  ) {
    return null;
  }
  const firstToken = normTerm.split(/\s+/)[0];
  if (MONTH_BY_NORM[firstToken]) return null;
  return term;
}

// ── Detecção de intenção (alta confiança) ──────────────────────

const ADVICE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(analis[aeiou]|analise|analisar|suger[ei]|sugest[ao]es?|recomend|conselh|opiniao|acharia|devo|deveria|estrategia|estrategic|planejamento|como posso|como faco|melhor forma|impacto|reduzir|cortar gastos?|economizar|investir)\b/,
];

function isAdviceQuestion(norm: string): boolean {
  return ADVICE_PATTERNS.some((re) => re.test(norm));
}

function hasRelativeTimeRef(norm: string): boolean {
  return /\b(mes passado|mes anterior|meses atras|ano passado|mes atras|proximo mes|semana passada|ultimo mes|ultima semana|ainda este mes)\b/.test(norm);
}

function isMonthMostQuestion(norm: string): boolean {
  if (/\bmes(?:es)?\b/.test(norm) && /\bgastei\b/.test(norm) && /\b(mais|maior)\b/.test(norm)) {
    return true;
  }
  return /\bmes\b[^?.!;]{0,30}\b(maior gasto|mais gasto|maior despesa|mais despesa)\b/.test(norm);
}

function isIncomeQuestion(norm: string): boolean {
  return /\b(recebi|receita|receitas|ganhei|ganho|entrou)\b/.test(norm);
}

function isTotalIncomeQuestion(norm: string): boolean {
  if (/\bquanto [eu ]?(recebi|entrou|ganhei|ganho)\b/.test(norm)) return true;
  if (/\btotal de receitas?\b/.test(norm)) return true;
  if (/\breceitas? totais? do periodo\b/.test(norm)) return true;
  if (/\bquanto (foram|foi)\b[^?.!;]{0,30}\b(receitas|receita)\b/.test(norm)) return true;
  return false;
}

function isCategoryQuestion(stripped: string): boolean {
  if (
    !/\b(?:gastei|gasto|gastos|gaste|despesas|despesa|compras|total)\s+(?:em|com|na|no|para)\b/.test(
      stripped,
    )
  ) {
    return false;
  }
  return extractCategoryTerm(stripped) !== null;
}

// PESSOAL-13C1.2: NUNCA fuzzy matching irrestrito da pergunta. Sinais combinados
// e controlados para "quanto (eu) gastei" — variantes típicas de UM erro de
// letra (uanto/qanto/qunto/qto/quato) + verbo "gastei" + proximidade + ausência
// de termos de receita + ausência de referência a tempo ("gastei de tempo" não é
// despesa financeira).
const QUANTO_VARIANTS_SRC = ['quanto', 'uanto', 'qanto', 'qunto', 'qto', 'quato'];
const QUANTO_VARIANTS_RE = new RegExp(`\\b(?:${QUANTO_VARIANTS_SRC.join('|')})\\b`);
const INCOME_TERM_RE = /\b(?:recebi|receita|receitas|ganhei|ganho|entrou)\b/;
const TIME_TERM_RE = /\b(?:tempo|horas?|minutos?|segundos?)\b/;
const QUANTO_TO_GASTEI_WINDOW = 24;

function isQuantoGasteiLike(t: string): boolean {
  if (!/\bgastei\b/.test(t)) return false;
  if (INCOME_TERM_RE.test(t)) return false;
  if (TIME_TERM_RE.test(t)) return false;
  const amount = QUANTO_VARIANTS_RE.exec(t);
  const verb = /\bgastei\b/.exec(t);
  if (!amount || !verb) return false;
  return Math.abs(verb.index - amount.index) <= QUANTO_TO_GASTEI_WINDOW;
}

function isTotalExpenseQuestion(norm: string): boolean {
  const t = norm.replace(/[?!.;]+$/g, '');
  if (isQuantoGasteiLike(t)) return true;
  if (/\bquanto (eu )?gasgastei\b/.test(t)) return true;
  if (/\bquanto (foi|foram) (o|a|os|as|as minhas|os meus)?\s*(gasto|gastos|despesa|despesas)\b/.test(t)) return true;
  if (/\btotal de (gastos|despesas)\b/.test(t)) return true;
  if (/\b(gastos|despesas) totais\b/.test(t)) return true;
  if (/\bsome (os )?(gastos|despesas)\b/.test(t)) return true;
  return false;
}

function isBalanceQuestion(norm: string): boolean {
  // "resultado esperado" é rótulo copiado de prompt; nunca vira saldo.
  if (/\bresultado esperado\b/.test(norm)) return false;
  if (/\b(conta bancaria|saldo da conta|saldo bancario|saldo em conta)\b/.test(norm)) return false;
  if (/\b(sobrou|sobram|restou|sobra)\b/.test(norm)) return true;
  if (/\bresultado do periodo\b/.test(norm)) return true;
  if (/\bsaldo do periodo|saldo no periodo\b/.test(norm)) return true;
  if (/\bqual\s+(?:o\s+)?(?:meu\s+)?(?:resultado|saldo)\b/.test(norm)) return true;
  if (/\bqual (o|era|foi) o (resultado|saldo)\b/.test(norm)) return true;
  if (/\b(resultado|saldo)\b/.test(norm) && /\b(periodo|mes|ano)\b/.test(norm)) return true;
  return false;
}

function isExpenseCountQuestion(norm: string): boolean {
  return (
    /\bquantas despesas\b/.test(norm) ||
    /\bquantos gastos\b/.test(norm) ||
    /\b(quantidade|numero|quantas) de despesas?\b/.test(norm) ||
    /\b(quantidade|numero|quantos) de gastos?\b/.test(norm)
  );
}

function isMonthlyComparison(norm: string): boolean {
  const months = collectMonthNumbers(norm);
  if (months.length < 2) return false;
  return /\b(comp[aá]r[aã]|comparacao|diferenc|vs\b|versus|se comparado)\b/.test(norm);
}

// ── Tendências / oportunidades (PESSOAL-13C3B-E2) ──────────────
//
// Dois intents determinísticos NOVOS, detectados ANTES do isAdviceQuestion e
// do contexto (nunca deixam a simulação "E se eu reduzisse 10%?" ser reescrita
// como follow-up canônico de categoria).
//   - growth_categories:      "Onde/quais + gastos/categorias + aumentar/crescer"
//   - savings_opportunities:  "onde/quais + (economizar|oportunidade)" ou
//                             "e se eu reduzisse meus gastos em X%" /
//                             "quanto eu economizaria reduzindo X%?"
// Devem continuar caindo no Gemini (conselho/opinião): "Devo economizar mais?",
// "É melhor cortar gastos ou investir?", "Você acha que estou gastando demais?",
// "Como devo organizar minha vida financeira?" — nenhum desses sinais.

function isGrowthCategoriesQuestion(norm: string): boolean {
  const growthVerb = /\b(?:aument[a-z]*|cresc[a-z]*|subir[a-z]*|elev[a-z]*)\b/.test(norm);
  if (!growthVerb) return false;
  const target = /\b(?:gastos?|despesas?|categorias?)\b/.test(norm);
  if (!target) return false;
  return /\b(?:onde|quais)\b/.test(norm);
}

function isSavingsOpportunitiesQuestion(norm: string): boolean {
  if (
    /\bonde\b/.test(norm) &&
    /\b(?:oportunidades?|posso|possa|consigo)\b/.test(norm) &&
    /\b(?:economiz[a-z]*|economias?|poupar[a-z]*|poupanc[a-z]*)\b/.test(norm)
  ) {
    return true;
  }
  if (/\bquanto\b/.test(norm) && /\beconomizaria\b/.test(norm)) return true;
  const reduce = /\b(?:reduziss[a-z]*|reduzindo|reduzir|cortand[a-z]*|cortass[a-z]*|cortar)\b/.test(norm);
  const gasto = /\b(?:gastos?|despesas?)\b/.test(norm);
  if (reduce && gasto) {
    if (/\d+\s*%/.test(norm)) return true;
    if (/\b(?:e se|se (?:eu )?reduziss|quanto\s+economizaria|eu\s+economizaria)\b/.test(norm)) return true;
  }
  return false;
}

/**
 * Janela de tendência a partir da pergunta (PESSOAL-13C3B-E2).
 *   - "últimos 6 meses" (sem marcador)                    → six_complete (padrão)
 *   - "incluindo este mês / até hoje / com o mês atual"   → five_plus_current
 *   - "seis meses completos mais este mês" explícito      → six_plus_current
 * Sempre reusa buildTrendWindow (mesma definição do motor puro).
 */
function trendWindowStyleOf(norm: string): TrendWindowStyle {
  if (
    /\b(?:seis\s*meses|6\s*meses)\s+completos\b\s+(?:mais|e)\s+(?:o\s+mes\s+(?:atual|corrente)|este\s+mes|esse\s+mes)\b/i.test(
      norm,
    )
  ) {
    return 'six_plus_current';
  }
  if (
    /\b(?:incluindo|considerando|contando)\s+(?:este|esse|o\s+mes\s+(?:atual|corrente)|mes\s+atual)\b/i.test(norm) ||
    /\b(?:ate|com\s+o)\s*(?:mes\s+(?:atual|corrente)|hoje|agora)\b/i.test(norm) ||
    /\bneste\s+mes\b/i.test(norm)
  ) {
    return 'five_plus_current';
  }
  return 'six_complete';
}

const PERCENT_RE = /(-?\d+(?:[.,]\d+)?)\s*%/i;

interface PercentResult {
  value: number;
  invalid: boolean;
}

/** Percentual de simulação: padrão 10; inválido => invalid=true (nunca erro). */
function extractPercent(norm: string): PercentResult {
  const m = PERCENT_RE.exec(norm);
  if (!m) return { value: 10, invalid: false };
  const raw = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(raw) || raw <= 0 || raw > 100) return { value: raw, invalid: true };
  return { value: raw, invalid: false };
}

function detectTrendIntent(norm: string): DeterministicIntentResult | null {
  if (!norm) return null;
  if (isGrowthCategoriesQuestion(norm)) {
    return { intent: 'growth_categories', trendWindow: trendWindowStyleOf(norm) };
  }
  if (isSavingsOpportunitiesQuestion(norm)) {
    const pct = extractPercent(norm);
    return {
      intent: 'savings_opportunities',
      trendWindow: trendWindowStyleOf(norm),
      percent: pct.value,
      percentInvalid: pct.invalid,
    };
  }
  return null;
}

function detectIntent(question: string, resolved: ResolvedQueryPeriod): DeterministicIntentResult | null {
  const norm = normalizeText(question);
  if (!norm || norm.length > MAX_QUESTION_LENGTH) return null;
  if (isAdviceQuestion(norm)) return null;
  if (hasRelativeTimeRef(norm)) return null;

  const stripped = stripPeriodPhrases(norm, resolved);

  // Precedência (PESSOAL-13C1.1): expressões específicas primeiro, saldo por
  // último. "resultado esperado" (rótulo) jamais seleciona saldo.
  if (isMonthMostQuestion(norm)) {
    const category = extractCategoryTerm(stripped);
    if (category) return { intent: 'month_most_spent', category };
    return null;
  }

  if (isCategoryQuestion(stripped)) {
    const category = extractCategoryTerm(stripped);
    if (category) return { intent: 'category_total', category };
  }

  if (isMonthlyComparison(norm)) return { intent: 'monthly_comparison' };
  if (isExpenseCountQuestion(norm)) return { intent: 'expense_count' };
  if (isTotalExpenseQuestion(norm)) return { intent: 'total_expenses' };
  if (isIncomeQuestion(norm)) {
    if (isTotalIncomeQuestion(norm)) return { intent: 'total_income' };
    return null;
  }
  if (isBalanceQuestion(norm)) return { intent: 'period_balance' };
  return null;
}

// ── Consulta enxuta e paginada (sem truncamento) ───────────────

const DETERMINISTIC_SELECT =
  'transaction_kind, amount, occurred_on, category_id, categories(display_name, canonical_path)';
const DETERMINISTIC_PAGE_SIZE = 1000;

interface LeanTx {
  transaction_kind?: string | null;
  amount?: number | string | null;
  occurred_on?: string | null;
  category_id?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
}

function toAnalyticsRows(rows: LeanTx[]): AnalyticsTxRow[] {
  return (rows ?? []).map((r) => ({
    id: '',
    transaction_kind: r.transaction_kind === 'expense' || r.transaction_kind === 'transfer' ? r.transaction_kind : 'income',
    amount: r.amount ?? 0,
    account_id: '',
    category_id: typeof r.category_id === 'string' ? r.category_id : null,
    occurred_on: typeof r.occurred_on === 'string' ? r.occurred_on : '',
    status: null,
    raw_description: '',
    accounts: null,
    categories: (r.categories ?? null) as AnalyticsTxRow['categories'],
  }) as AnalyticsTxRow);
}

function toAskSupabaseError(err: unknown): unknown {
  if (isSupabaseQueryError(err)) {
    return new AskError('supabase_query', {
      category: 'supabase_query_error',
      providerStatus: providerStatusOf(err),
      retryable: false,
    });
  }
  return new AskError('financial_tool_execution', {
    category: 'tool_failed',
    providerStatus: providerStatusOf(err),
    retryable: false,
  });
}

async function fetchPeriodRows(
  supabase: SupabaseClient,
  start: string,
  end: string,
): Promise<AnalyticsTxRow[]> {
  const rows: LeanTx[] = [];
  let totalCount: number | null = null;
  let from = 0;
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from('transactions')
      .select(DETERMINISTIC_SELECT, { count: 'exact' })
      .is('deleted_at', null)
      .gte('occurred_on', start)
      .lte('occurred_on', end);
    q = q.range(from, from + DETERMINISTIC_PAGE_SIZE - 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error, count } = (await q) as { data: unknown; error: unknown; count: number | null };
    if (error) throw error;
    const page = (data as LeanTx[] | null) ?? [];
    rows.push(...page);
    totalCount = typeof count === 'number' ? count : totalCount;
    if (totalCount !== null) {
      if (rows.length >= totalCount) break;
      if (page.length === 0) {
        throw new Error(`consulta de período abortada (${rows.length}/${totalCount})`);
      }
    } else if (page.length < DETERMINISTIC_PAGE_SIZE || page.length === 0) {
      break;
    }
    from += DETERMINISTIC_PAGE_SIZE;
  }
  return toAnalyticsRows(rows);
}

function supportsPaginableAsync(supabase: SupabaseClient): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe: any = supabase.from('transactions').select(DETERMINISTIC_SELECT);
    return typeof probe.range === 'function';
  } catch {
    return false;
  }
}

// ── Construção das respostas determinísticas ───────────────────

function makeResponse(
  answer: string,
  resolved: ResolvedQueryPeriod,
  toolsUsed: string[],
  evidence: EvidenceItem[],
): AskResponse {
  return {
    answer,
    period: { start: resolved.start, end: resolved.end },
    toolsUsed,
    evidence,
    engine: 'deterministic',
    geminiCallCount: 0,
    periodAnalyzed: { start: resolved.start, end: resolved.end },
  };
}

function categoryExpenseTotals(
  rows: AnalyticsTxRow[],
  category: string,
): { amount: number; count: number } {
  let amount = 0;
  let count = 0;
  for (const r of rows) {
    if (r.transaction_kind !== 'expense') continue;
    if (!matchesCategoryTerm(r, category)) continue;
    amount += numberValue(r.amount);
    count += 1;
  }
  return { amount, count };
}

interface CategoryLabel {
  display_name: string;
  canonical_path: string | null;
}

const CATEGORY_CLARIFICATION =
  'Não consegui identificar a categoria. Você pode informar somente o nome, como supermercado, aluguel ou combustível?';

/** Uma consulta enxuta/paginada à tabela categories (RLS via JWT do usuário). */
async function fetchExpenseCategories(supabase: SupabaseClient): Promise<CategoryLabel[]> {
  const labels: CategoryLabel[] = [];
  let from = 0;
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from('categories')
      .select('display_name, canonical_path', { count: 'exact' })
      .eq('direction', 'expense');
    q = q.range(from, from + DETERMINISTIC_PAGE_SIZE - 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error, count } = (await q) as { data: unknown; error: unknown; count: number | null };
    if (error) throw error;
    const page = (data as CategoryLabel[] | null) ?? [];
    labels.push(...page);
    if (typeof count === 'number') {
      if (labels.length >= count) break;
      if (page.length === 0) {
        throw new Error(`consulta de categorias abortada (${labels.length}/${count})`);
      }
    } else if (page.length < DETERMINISTIC_PAGE_SIZE) {
      break;
    }
    from += DETERMINISTIC_PAGE_SIZE;
  }
  return labels;
}

interface ResolvedCategoryMatch {
  /** Nó da tabela categories usado como referência (nunca exibido como path de descendente). */
  label: CategoryLabel;
  /**
   * Alvo canônico de correspondência para a regra de match das transações:
   * path BASE no segmento que casou (ex.: "Alimentação > Supermercado"). Um
   * descendente ("Alimentação > Supermercado > Sem sub-categoria" ou uma
   * subcategoria real) casado no segmento "supermercado" devolve esse prefixo —
   * NUNCA o path textual exato do descendente. Assim a consulta abrange a própria
   * categoria, registros sem subcategoria e subcategorias descendentes, e a regra
   * canônica reutilizada é EXATAMENTE matchesCategoryTerm (mesma definição do
   * agregador Gemini / analyticsInsights — fonte única, nunca divergente).
   */
  matchTerm: string;
}

type ResolvedCategory =
  | { status: 'resolved'; label: CategoryLabel; matchTerm: string }
  | { status: 'ambiguous'; matches: ResolvedCategoryMatch[] }
  | null;

/**
 * Sinônimos de segmento canônico (PESSOAL-13C4A-E3.1): um termo dito
 * naturalmente que corresponde a um segmento de path com outro nome. O match é
 * SEMPRE por igualdade de segmento inteiro — nunca por substring. Assim
 * "mercado" → "supermercado" (semântica coloquial) cobre as despesas de mercado
 * sem recair no fallback antigo que casava "Mercado Livre" por substring.
 */
const SEGMENT_ALIAS: Readonly<Record<string, string>> = { mercado: 'supermercado' };

function depthOfPath(path: string | null): number {
  return path ? path.split('>').length : 1;
}

/**
 * Resolve a categoria extraída para a classificação CANÔNICA do usuário
 * (display_name/canonical_path da tabela categories). Nunca devolve a string
 * bruta da pergunta.
 *
 * Regras (PESSOAL-13C4A-E3.1):
 *   - igualdade EXATA de display_name/canonical_path prevalece;
 *   - hierárquico por SEGMENTO inteiro: o segmento é igual ao termo OU ao
 *     sinônimo canônico (SEGMENT_ALIAS). NUNCA substring;
 *   - um descendente (mesma causa canônica) devolve o path BASE até o segmento
 *     casado; correspondências que produzem o MESMO matchTerm colapsam em uma;
 *   - entre múltiplas causas canônicas prefere-se o nó ancestral (menor
 *     profundidade). Quando restam ≥2 matchTerms canônicos DISTINTOS, a
 *     resolução é AMBÍGUA e devolve os matches — o chamador decide o
 *     esclarecimento com os nomes de exibição;
 *   - retorna null quando a categoria não é reconhecida.
 */
function resolveCategory(labels: CategoryLabel[], term: string): ResolvedCategory {
  const target = normalizeCategoryTerm(term);
  if (!target) return null;
  const aliasTarget = SEGMENT_ALIAS[target];
  const exact: ResolvedCategoryMatch[] = [];
  const hierarchic: ResolvedCategoryMatch[] = [];
  for (const l of labels) {
    const dn = normalizeCategoryTerm(l.display_name);
    const rawPath = l.canonical_path;
    const cp = rawPath ? normalizeCategoryTerm(rawPath) : null;
    if (dn === target || cp === target) {
      exact.push({ label: l, matchTerm: rawPath ?? l.display_name });
      continue;
    }
    if (cp) {
      const normSegs = cp.split('>').map((s) => s.trim());
      const rawSegs = rawPath ? rawPath.split('>').map((s) => s.trim()) : [];
      const eqIdx = normSegs.indexOf(target);
      const aliasIdx =
        aliasTarget && aliasTarget !== target ? normSegs.indexOf(aliasTarget) : -1;
      const idx = eqIdx >= 0 ? eqIdx : aliasIdx >= 0 ? aliasIdx : -1;
      if (idx >= 0) {
        hierarchic.push({
          label: l,
          matchTerm: rawSegs.slice(0, idx + 1).join(' > '),
        });
      }
    }
  }
  const all = [...exact, ...hierarchic];
  if (all.length === 0) return null;
  const seen = new Set<string>();
  const uniq: ResolvedCategoryMatch[] = [];
  for (const m of all) {
    if (!seen.has(m.matchTerm)) {
      seen.add(m.matchTerm);
      uniq.push(m);
    }
  }
  if (uniq.length === 1) {
    return { status: 'resolved', label: uniq[0].label, matchTerm: uniq[0].matchTerm };
  }
  uniq.sort((a, b) => depthOfPath(a.label.canonical_path) - depthOfPath(b.label.canonical_path));
  return { status: 'ambiguous', matches: uniq };
}

/** Nomes de exibição (folha do matchTerm canônico) deduplicados para esclarecimento. */
function ambiguousCategoryNames(matches: ResolvedCategoryMatch[]): string[] {
  return dedupeDisplayNames(matches.map((m) => leafLabelOfPath(m.matchTerm)));
}

const CATEGORY_AMBIGUITY_CLARIFICATION =
  'Isso pode ser mais de uma categoria da sua lista. Informe só o nome de UMA delas para eu analisar.';

async function buildPeriodSummary(
  supabase: SupabaseClient,
  resolved: ResolvedQueryPeriod,
  intent: 'total_expenses' | 'total_income' | 'period_balance' | 'expense_count',
): Promise<DeterministicAnswer> {
  const rows = await fetchPeriodRows(supabase, resolved.start, resolved.end);
  const s = summaryByPeriod(rows);
  const expenseCount = rows.filter((r) => r.transaction_kind === 'expense').length;
  const incomeCount = rows.filter((r) => r.transaction_kind === 'income').length;
  const phrase = periodPhraseOf(resolved);

  let answer = '';
  let evidence: EvidenceItem[] = [];
  if (intent === 'total_expenses') {
    answer =
      `Suas despesas ${phrase} totalizaram ${brl(s.expense)}, considerando ` +
      `${expenseCount} ${plural(expenseCount, 'despesa')}.`;
    evidence = [
      { label: 'Despesas', value: brl(s.expense) },
      { label: 'Quantidade de despesas', value: String(expenseCount) },
      { label: 'Período analisado', value: periodDisplay(resolved) },
    ];
  } else if (intent === 'total_income') {
    answer =
      `Suas receitas ${phrase} totalizaram ${brl(s.income)}, considerando ` +
      `${incomeCount} ${plural(incomeCount, 'receita')}.`;
    evidence = [
      { label: 'Receitas', value: brl(s.income) },
      { label: 'Quantidade de receitas', value: String(incomeCount) },
      { label: 'Período analisado', value: periodDisplay(resolved) },
    ];
  } else if (intent === 'period_balance') {
    answer =
      `O resultado do período foi ${signedBrl(s.balance)} ` +
      `(receitas de ${brl(s.income)} menos despesas de ${brl(s.expense)}).`;
    evidence = [
      { label: 'Receitas', value: brl(s.income) },
      { label: 'Despesas', value: brl(s.expense) },
      { label: 'Resultado', value: signedBrl(s.balance) },
      { label: 'Período analisado', value: periodDisplay(resolved) },
    ];
  } else {
    answer =
      `Foram ${expenseCount} ${plural(expenseCount, 'despesa')} ${phrase}, ` +
      `totalizando ${brl(s.expense)}.`;
    evidence = [
      { label: 'Quantidade de despesas', value: String(expenseCount) },
      { label: 'Total de despesas', value: brl(s.expense) },
      { label: 'Período analisado', value: periodDisplay(resolved) },
    ];
  }

  return {
    intent,
    response: makeResponse(answer, resolved, ['financial_summary'], evidence),
  };
}

async function buildCategoryTotal(
  supabase: SupabaseClient,
  resolved: ResolvedQueryPeriod,
  category: string,
): Promise<DeterministicAnswer> {
  const cats = await fetchExpenseCategories(supabase);
  const resolvedCat = resolveCategory(cats, category);
  if (resolvedCat?.status === 'ambiguous') {
    // Categoria pode corresponder a mais de um item canônico → esclarecimento
    // sem custo (nunca consulta o texto contaminado e nunca aciona o Gemini).
    const names = ambiguousCategoryNames(resolvedCat.matches);
    const clarification = names.length >= 2
      ? `Achei mais de uma categoria possível: ${names.join(' e ')}. Informe só o nome de UMA delas para eu analisar.`
      : CATEGORY_AMBIGUITY_CLARIFICATION;
    return {
      intent: 'category_total',
      response: makeResponse(
        clarification,
        resolved,
        [],
        [{ label: 'Período analisado', value: periodDisplay(resolved) }],
      ),
    };
  }
  if (!resolvedCat) {
    // Categoria não reconhecida → esclarecimento sem custo (nunca consulta o
    // texto contaminado, nunca R$ 0,00 e nunca aciona o Gemini).
    return {
      intent: 'category_total',
      response: makeResponse(
        CATEGORY_CLARIFICATION,
        resolved,
        [],
        [{ label: 'Período analisado', value: periodDisplay(resolved) }],
      ),
    };
  }
  const label = resolvedCat.matchTerm;
  const rows = await fetchPeriodRows(supabase, resolved.start, resolved.end);
  const { amount, count } = categoryExpenseTotals(rows, label);
  const phrase = periodPhraseOf(resolved);

  const answer =
    amount > 0
      ? `Suas despesas com ${label} ${phrase} totalizaram ${brl(amount)}, ` +
        `considerando ${count} ${plural(count, 'despesa')}.`
      : `Não encontrei despesas em ${label} ${phrase}.`;

  const evidence: EvidenceItem[] = [
    { label, value: brl(amount) },
    { label: 'Quantidade de despesas', value: String(count) },
    { label: 'Período analisado', value: periodDisplay(resolved) },
  ];
  return {
    intent: 'category_total',
    response: makeResponse(answer, resolved, ['expenses_by_category'], evidence),
    category: label,
  };
}

async function buildMonthMost(
  supabase: SupabaseClient,
  resolved: ResolvedQueryPeriod,
  category: string,
): Promise<DeterministicAnswer> {
  const cats = await fetchExpenseCategories(supabase);
  const resolvedCat = resolveCategory(cats, category);
  if (resolvedCat?.status === 'ambiguous') {
    const names = ambiguousCategoryNames(resolvedCat.matches);
    const clarification = names.length >= 2
      ? `Achei mais de uma categoria possível: ${names.join(' e ')}. Informe só o nome de UMA delas para eu analisar.`
      : CATEGORY_AMBIGUITY_CLARIFICATION;
    return {
      intent: 'month_most_spent',
      response: makeResponse(
        clarification,
        resolved,
        [],
        [{ label: 'Período analisado', value: periodDisplay(resolved) }],
      ),
    };
  }
  if (!resolvedCat) {
    return {
      intent: 'month_most_spent',
      response: makeResponse(
        CATEGORY_CLARIFICATION,
        resolved,
        [],
        [{ label: 'Período analisado', value: periodDisplay(resolved) }],
      ),
    };
  }
  const label = resolvedCat.matchTerm;
  const rows = await fetchPeriodRows(supabase, resolved.start, resolved.end);
  const agg = expenseMonthlyAggregate(
    rows,
    { start: resolved.start, end: resolved.end, category: label },
    todayISO(),
  );

  if (!agg.hasData) {
    const answer = `Não encontrei despesas em ${label} no período analisado.`;
    return {
      intent: 'month_most_spent',
      response: makeResponse(answer, resolved, ['expense_monthly_aggregate'], [
        { label: `${label}`, value: brl(0) },
        { label: 'Período analisado', value: periodDisplay(resolved) },
      ]),
      category: label,
    };
  }

  const winners = (agg.winnerMonths ?? []).map((w) => {
    const year = w.key.slice(0, 4);
    const month = Number(w.key.slice(5, 7));
    const mStart = `${w.key}-01`;
    const mEnd = lastDayOf(year, month);
    const monthRows = rows.filter((r) => {
      const d = r.occurred_on ?? '';
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= mStart && d <= mEnd;
    });
    const monthly = summaryByPeriod(monthRows);
    const categoryCount = (agg.months ?? []).find((m) => m.key === w.key)?.count ?? 0;
    return {
      key: w.key,
      monthLabel: monthNameOfYearMonth(w.key),
      categoryAmount: numberValue(agg.winnerAmount),
      categoryCount,
      overallExpense: monthly.expense,
    };
  });

  let answer: string;
  const evidence: EvidenceItem[] = [];
  if (winners.length === 1) {
    const w = winners[0];
    answer =
      `${cap(w.monthLabel.split(' de ')[0])} foi o mês em que você mais gastou em ${label}: ` +
      `${brl(w.categoryAmount)} em ${w.categoryCount} ${plural(w.categoryCount, 'despesa')}. ` +
      `Considerando todas as categorias, suas despesas totais em ${w.monthLabel} foram ${brl(w.overallExpense)}.`;
    evidence.push({ label: `${cap(w.monthLabel.split(' de ')[0])} com maior gasto`, value: brl(w.categoryAmount) });
    evidence.push({ label: 'Despesas consideradas', value: String(w.categoryCount) });
    evidence.push({ label: 'Total geral (todas as categorias)', value: brl(w.overallExpense) });
  } else {
    const names = winners.map((w) => cap(w.monthLabel.split(' de ')[0]));
    answer =
      `${names.join(' e ')} foram os meses em que você mais gastou em ${label}, ` +
      `com ${brl(agg.winnerAmount)} em ${agg.winnerCount} despesas. ` +
      winners
        .map(
          (w) => `Em ${w.monthLabel}, suas despesas totais (todas as categorias) foram ${brl(w.overallExpense)}`,
        )
        .join('; ') +
      '.';
    for (const w of winners) {
      evidence.push({ label: `${cap(w.monthLabel.split(' de ')[0])} com maior gasto`, value: brl(w.categoryAmount) });
    }
    evidence.push({ label: 'Despesas consideradas (meses empatados)', value: String(agg.winnerCount) });
    for (const w of winners) {
      evidence.push({ label: `Total geral em ${w.monthLabel}`, value: brl(w.overallExpense) });
    }
  }
  evidence.push({ label: 'Período analisado', value: periodDisplay(resolved) });

  return {
    intent: 'month_most_spent',
    response: makeResponse(answer, resolved, ['expense_monthly_aggregate'], evidence),
    category: label,
  };
}

async function buildMonthlyComparison(
  supabase: SupabaseClient,
  question: string,
): Promise<DeterministicAnswer> {
  const norm = normalizeText(question);
  const months = collectMonthNumbers(norm).sort((a, b) => a - b);
  const year = yearOfToken(norm) ?? String(new Date().getFullYear());
  const start = `${year}-${pad2(months[0])}-01`;
  const end = lastDayOf(year, months[months.length - 1]);
  const resolved: ResolvedQueryPeriod = {
    start,
    end,
    source: 'year',
    year,
    month: `${year}-${pad2(months[0])}`,
    monthLower: `${MONTH_FULL[months[0] - 1] ?? ''} de ${year}`,
  };
  const rows = await fetchPeriodRows(supabase, start, end);

  const points = months.map((m) => {
    const mStart = `${year}-${pad2(m)}-01`;
    const mEnd = lastDayOf(year, m);
    const monthRows = rows.filter((r) => {
      const d = r.occurred_on ?? '';
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= mStart && d <= mEnd;
    });
    const s = summaryByPeriod(monthRows);
    return {
      label: `${MONTH_FULL[m - 1] ?? ''} de ${year}`,
      expense: s.expense,
      count: monthRows.filter((r) => r.transaction_kind === 'expense').length,
    };
  });

  const parts = points.map(
    (p) => `${cap(p.label.split(' de ')[0])}: ${brl(p.expense)} (${p.count} ${plural(p.count, 'despesa')})`,
  );
  const diff = points.length >= 2 ? points[points.length - 1].expense - points[0].expense : 0;
  let answer = `Comparando os meses, ${parts.join('; ')}.`;
  if (diff !== 0) {
    const last = points[points.length - 1];
    const direction = diff > 0 ? 'a mais' : 'a menos';
    answer += ` A diferença foi de ${brl(Math.abs(diff))} ${direction} em ${last.label}.`;
  } else {
    answer += ' Os meses empataram em despesas.';
  }

  const evidence: EvidenceItem[] = points.map((p) => ({
    label: `Despesas em ${cap(p.label)}`,
    value: brl(p.expense),
  }));
  evidence.push({ label: 'Período analisado', value: periodDisplay(resolved) });

  return {
    intent: 'monthly_comparison',
    response: makeResponse(answer, resolved, ['expense_monthly_aggregate'], evidence),
  };
}

// ── Contexto analítico persistente + follow-ups (PESSOAL-13C3B-E3) ──

/**
 * Restringe um resultado de tendência à lente canônica persistida (matchTerm de
 * resolveCategory). Um descendente ("Alimentação > Supermercado > X") continua
 * pertencente à mesma lente do segmento casado.
 */
function matchesCategoryPath(label: string, categoryPath: string): boolean {
  return label === categoryPath || label.startsWith(`${categoryPath} >`);
}

function analysisWindowOf(w: TrendWindow): ChatAnalysisContext['window'] {
  return {
    start: w.start,
    end: w.end,
    baseStart: w.baseStart,
    baseEnd: w.baseEnd,
    recentStart: w.recentStart,
    recentEnd: w.recentEnd,
  };
}

/**
 * Contexto analítico persistível do turno (fonte dos follow-ups). JAMAIS
 * valores monetários, médias, deltas, cards, linhas/descrições ou UUIDs:
 * somente intent, datas, estilo de janela, percentual e path canônico.
 */
function analysisOf(opts: {
  intent: 'growth_categories' | 'savings_opportunities';
  w: TrendWindow;
  anchorISO: string;
  simulationPct?: number;
  categoryPath?: string;
}): ChatAnalysisContext {
  return {
    version: 1,
    intent: opts.intent,
    windowStyle: opts.w.style,
    anchorDate: opts.anchorISO,
    window: analysisWindowOf(opts.w),
    includeCurrentMonth: opts.w.style !== 'six_complete',
    isPartialCurrent: opts.w.isPartialCurrent,
    simulationPct: opts.simulationPct,
    categoryPath: opts.categoryPath,
  };
}

/** "E incluindo este mês?"/"E até hoje?" → five_plus_current; "E sem incluir este mês?" → six_complete; "E considerando seis meses completos mais este mês?" → six_plus_current. */
function detectAnalysisWindowFollowUp(norm: string): TrendWindowStyle | null {
  if (!CONTINUATION_RE.test(norm)) return null;
  if (
    /\b(?:seis\s*meses|6\s*meses)\s+completos\b\s+(?:mais|e)\s+(?:o\s+mes\s+(?:atual|corrente)|este\s+mes|esse\s+mes)\b/i.test(
      norm,
    )
  ) {
    return 'six_plus_current';
  }
  if (
    /\b(?:incluindo|considerando|contando)\s+(?:este|esse|o\s+mes\s+(?:atual|corrente)|mes\s+atual)\b/i.test(
      norm,
    ) ||
    /\b(?:ate|com\s+o)\s*(?:mes\s+(?:atual|corrente)|hoje|agora)\b/i.test(norm) ||
    /\bneste\s+mes\b/i.test(norm)
  ) {
    return 'five_plus_current';
  }
  if (
    /\b(?:sem\s+incluir|excluindo|sem\s+considerar)\s*(?:este|esse|o\s+)?\s*mes(?:es)?(?:\s+(?:atual|corrente))?\b/i.test(
      norm,
    )
  ) {
    return 'six_complete';
  }
  return null;
}

/** Prefixos de continuidade analítica, incluindo elipse inicial "só/somente/apenas" (PESSOAL-13C3B.12). */
const ANALYSIS_ELISION_PREFIX_RE =
  /^(?:e\b|entao\b|depois\b|so\b|somente\b|apenas\b)/i;

/**
 * Intro consumível de um follow-up de categoria. Exige "e" SEGUIDO de
 * modificador/preposição, ou início DIRETO por modificador. Isso preserva
 * "E o que você acha disso?"/"E como ficaria?"/"E depois disso?" como
 * não-categoria e admite "E apenas investimentos?", "Só em aluguel?" e
 * "Somente em combustível?".
 */
const ANALYSIS_CATEGORY_INTRO_RE =
  /^(?:e\s+(?:(?:so\s+|somente\s+|apenas\s+)(?:(?:em|com|na|no|de|para|sobre)\s+)?|(?:em|com|na|no|de|para|sobre)\s+)|(?:so\s+|somente\s+|apenas\s+)(?:(?:em|com|na|no|de|para|sobre)\s+)?)/i;

/** Termo de categoria de um follow-up tipo "E só em alimentação?", "E em supermercado?", "E com combustível?" ou "Só em aluguel?". */
function extractAnalysisCategoryTerm(norm: string): string | null {
  if (!ANALYSIS_ELISION_PREFIX_RE.test(norm)) return null;
  const m = ANALYSIS_CATEGORY_INTRO_RE.exec(norm);
  if (!m || !m[0]) return null;
  let term = norm
    .slice(m[0].length)
    .replace(/\s{2,}/g, ' ')
    .replace(/[?.!;]+$/g, '')
    .trim();
  if (!term) return null;
  const normTerm = normalizeText(term);
  // Sovraproteção numérica: "só 5%?" nunca vira lente de categoria (o
  // percentual de simulação exige prefixo "e", tratado antes).
  if (/^[-+]?\d+(?:[.,]\d+)?\s*%?$/.test(normTerm)) return null;
  if (
    !normTerm.includes('>') &&
    /\b(?:quanto|qual|ai|agora|depois|meses?|periodo|ano|informe|diga|entao|incluindo|ate|hoje|atual|corrente)\b/.test(
      normTerm,
    )
  ) {
    return null;
  }
  const firstToken = normTerm.split(/\s+/)[0];
  if (MONTH_BY_NORM[firstToken]) return null;
  return term;
}

interface ResolvedAnalysisFollowUp {
  intent: 'growth_categories' | 'savings_opportunities';
  style: TrendWindowStyle;
  /** Âncora preservada quando a janela NÃO muda (estável entre turnos e F5/remount). */
  anchorDate?: string;
  percent?: number;
  percentInvalid?: boolean;
  /** Lente canônica já resolvida (matchTerm de resolveCategory). */
  categoryPath?: string;
  /** true = termo de categoria não reconhecido → responde com esclarecimento amigável. */
  unknownCategory?: boolean;
  /** true = a categoria corresponde a múltiplos itens canônicos → esclarecer a qual referir. */
  ambiguousNames?: string[];
}

/**
 * Follow-up elíptico compatível com o contexto analítico (prioridade 3 do
 * contrato PESSOAL-13C3B-E3: analítico explícito → determinístico tradicional →
 * elíptico de análise → herança tradicional → Gemini). Ordem interna:
 * percentual → janela → categoria. Percentual SÓ em savings_opportunities
 * ("após crescimento, 'E 5%?' é ambíguo e não é capturado"). Um follow-up de
 * categoria preserva intent/janela/percentual e troca apenas a lente para o
 * path canônico. Toda janela é re-derivada e o executor SEMPRE consulta os
 * dados de novo (nunca "recalcula sem consulta").
 */
async function resolveAnalysisFollowUp(
  q: string,
  analysis: ChatAnalysisContext | null | undefined,
  supabase: SupabaseClient,
): Promise<ResolvedAnalysisFollowUp | null> {
  if (!analysis) return null;
  const norm = normalizeText(q);
  if (!norm || !ANALYSIS_ELISION_PREFIX_RE.test(norm)) return null;

  if (analysis.intent === 'savings_opportunities') {
    // "E 5%?" | "E com 12,5%?" | "E se fosse 20%?"
    const m = /^e\s+(?:se\s+fosse\s+|com\s+)?(-?\d+(?:[.,]\d+)?)\s*%/.exec(norm);
    if (m) {
      const raw = Number(m[1].replace(',', '.'));
      return {
        intent: 'savings_opportunities',
        style: analysis.windowStyle,
        anchorDate: analysis.anchorDate,
        percent: raw,
        percentInvalid: !Number.isFinite(raw) || raw <= 0 || raw > 100,
      };
    }
  }

  // Mudança de janela → re-deriva com o relógio local injetável (novo âmbito).
  const style = detectAnalysisWindowFollowUp(norm);
  if (style) {
    const pct =
      analysis.intent === 'savings_opportunities'
        ? analysis.simulationPct
        : undefined;
    return {
      intent: analysis.intent,
      style,
      percent: pct,
      percentInvalid:
        pct != null && !(Number.isFinite(pct) && pct > 0 && pct <= 100),
    };
  }

  // Troca de lente de categoria, preservando intent/janela/percentual.
  const term = extractAnalysisCategoryTerm(norm);
  if (term) {
    const cats = await fetchExpenseCategories(supabase);
    let resolvedCat = resolveCategory(cats, term);
    if (resolvedCat?.status === 'ambiguous') {
      const names = ambiguousCategoryNames(resolvedCat.matches);
      return {
        intent: analysis.intent,
        style: analysis.windowStyle,
        anchorDate: analysis.anchorDate,
        percent: analysis.simulationPct,
        ambiguousNames: names.length >= 2 ? names : undefined,
        unknownCategory: false,
      };
    }
    if (!resolvedCat) {
      // Lente virtual conservadora (PESSOAL-13C3B.12): a categoria excluída
      // pode NÃO existir na tabela categories (ex.: "investimentos" sem
      // categoria lançável no catálogo). Nesses casos o termo também é uma
      // classe excluída → respondemos com a política; nunca inovamos em
      // categoria percentual desconhecida (mantém o esclarecimento atual).
      const virtualLabel = cap(term);
      const virtualClass = classifySavingsCategory(virtualLabel);
      if (virtualClass !== 'percentage_candidate') {
        resolvedCat = {
          status: 'resolved',
          label: { display_name: virtualLabel, canonical_path: virtualLabel },
          matchTerm: virtualLabel,
        };
      }
    }
    return {
      intent: analysis.intent,
      style: analysis.windowStyle,
      anchorDate: analysis.anchorDate,
      categoryPath: resolvedCat?.status === 'resolved' ? resolvedCat.matchTerm : undefined,
      percent: analysis.simulationPct,
      unknownCategory: !resolvedCat,
    };
  }

  return null;
}

// ── Tendências / oportunidades — builders (PESSOAL-13C3B-E2) ───

function resolvidoAPartirDaJanela(w: TrendWindow): ResolvedQueryPeriod {
  return { start: w.start, end: w.end, source: 'screen' };
}

function windowDisplay(w: TrendWindow): string {
  const first = w.months[0];
  const last = w.months[w.months.length - 1];
  if (!first || !last) return 'período analisado';
  return `de ${first.label} a ${last.label}`;
}

function brlCents(cents: number): string {
  return brl(cents / 100);
}

function signedBrlCents(cents: number): string {
  return signedBrl(cents / 100);
}

function formatPctRatio(v: number): string {
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function growthSummarySentence(results: GrowthCategoryResult[]): string {
  const total = results.length;
  const growth = results.filter((r) => r.classification === 'growth').length;
  const newly = results.filter((r) => r.classification === 'new').length;
  const spikes = results.filter((r) => r.classification === 'spike').length;
  const parts: string[] = [];
  if (growth > 0) {
    parts.push(`${growth} ${growth === 1 ? 'categoria' : 'categorias'} com aumento de gasto`);
  }
  if (newly > 0) {
    parts.push(
      `${newly} ${newly === 1 ? 'categoria' : 'categorias'} que ${newly === 1 ? 'passou' : 'passaram'} a aparecer no período recente`,
    );
  }
  if (spikes > 0) {
    parts.push(`${spikes} ${spikes === 1 ? 'pico' : 'picos'} ${spikes === 1 ? 'pontual' : 'pontuais'} de gasto`);
  }
  if (parts.length === 0) return 'Nenhuma mudança relevante neste período.';
  return `Encontrei ${total} ${total === 1 ? 'mudança relevante' : 'mudanças relevantes'} neste período: ${parts.join('; ')}.`;
}

function growthCardOf(
  r: GrowthCategoryResult,
  w: TrendWindow,
): TrendCard {
  const isNew = r.classification === 'new';
  const rows: TrendCardRow[] = isNew
    ? [
        { label: 'Média mensal (período recente)', value: brlCents(r.meanRCents) },
        { label: 'Aumento mensal observado', value: signedBrlCents(r.deltaCents) },
        { label: 'Despesas recentes', value: String(r.transactionCount) },
      ]
    : [
        { label: 'Média anterior (por mês)', value: brlCents(r.meanACents) },
        { label: 'Média recente (por mês)', value: brlCents(r.meanRCents) },
        { label: 'Variação mensal', value: signedBrlCents(r.deltaCents) },
        { label: 'Variação relativa', value: formatPctRatio(r.growthPct ?? 0) },
        { label: 'Despesas recentes', value: String(r.transactionCount) },
      ];
  return {
    kind: r.classification === 'new' ? 'new' : r.classification === 'spike' ? 'spike' : 'growth',
    title: r.label,
    subtitle: 'Crescimento identificado por comparação entre médias mensais',
    rows,
  };
}

function savingCardOf(
  s: SavingsOpportunity,
  w: TrendWindow,
): TrendCard {
  const regularity = `${s.monthsRecentWithSpend} de 3 meses recentes`;
  const variability =
    s.variability === 'low' ? 'Baixa' : s.variability === 'medium' ? 'Média' : 'Alta';
  const share = formatPctRatio(s.share);
  return {
    kind: 'savings' as const,
    title: s.label,
    subtitle: 'Oportunidade potencial para revisar',
    rows: [
      { label: 'Média mensal recente', value: brlCents(s.meanRCents) },
      { label: `Economia mensal (cenário ${formatPercent(s.percent)})`, value: brlCents(s.economyMonthlyCents) },
      { label: 'Economia anualizada (simulação)', value: brlCents(s.economyAnnualCents) },
      { label: 'Participação no total recente', value: share },
      { label: 'Regularidade', value: regularity },
      { label: 'Variabilidade', value: variability },
    ],
  };
}

function formatPercent(v: number): string {
  return `${String(v).replace('.', ',')}%`;
}

function savingsNotice(pct: number): string {
  return (
    `Simulação de ${formatPercent(pct)} sobre a média mensal recente; ` +
    'a economia anualizada corresponde ao valor mensal × 12. ' +
    'É apenas um cenário, não uma previsão nem recomendação automática.'
  );
}

function joinEn(w: readonly string[]): string {
  if (w.length === 0) return '';
  if (w.length === 1) return w[0];
  if (w.length === 2) return `${w[0]} e ${w[1]}`;
  return `${w.slice(0, -1).join(', ')} e ${w[w.length - 1]}`;
}

/** Nome curto exibível de uma categoria excluída (último segmento do path canônico). */
function displayNameOf(e: ExcludedSavingsOpportunity): string {
  const segments = e.label
    .split('>')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : e.label.trim();
}

/**
 * Nomes exibíveis deduplicados (ordem de exibição preservada, PESSOAL-13C3B.21).
 * A deduplicação compara apenas o TEXTO exibido ("Seguro do Carro" ♢ "seguro
 * carro"); registros e classificações financeiras permanecem intactos.
 */
function displayNamesOf(list: ReadonlyArray<ExcludedSavingsOpportunity>): string[] {
  return dedupeDisplayNames(list.map((e) => displayNameOf(e)));
}

/**
 * Aviso curto (PESSOAL-13C3B.10/.18/.21) sobre categorias excluídas da
 * simulação percentual. Nunca inventa valores de economia e jamais recomenda
 * corte em débitos ou despesas protegidas sem análise de contrato/condições.
 * Apenas os TIPOS efetivamente excluídos na análise são citados; sem "e
 * outras" quando as categorias podem ser informadas corretamente.
 *
 * Concordância estável (PESSOAL-13C3B.21): o sujeito é sempre o substantivo
 * invariável "categoria/categorias", nunca o texto interno do rótulo — mesmo
 * um nome no plural ("Investimentos") permanece gramaticalmente correto:
 *   - um item:  "A categoria Investimentos ficou fora: ...";
 *   - vários:   "As categorias Aluguel, Seguro do Carro e Empréstimo ficaram fora: ...".
 */
function savingsExclusionNotice(excluded: ReadonlyArray<ExcludedSavingsOpportunity>): string {
  if (excluded.length === 0) return '';
  const fixed = excluded.filter((e) => e.classification === 'fixed_contract');
  const debt = excluded.filter((e) => e.classification === 'debt_commitment');
  const health = excluded.filter((e) => e.classification === 'protected_essential');
  const asset = excluded.filter((e) => e.classification === 'asset_allocation');
  const subject = (names: readonly string[]): string =>
    names.length === 1 ? `A categoria ${names[0]}` : `As categorias ${joinEn(names)}`;
  const ficou = (n: number): string => (n === 1 ? 'ficou' : 'ficaram');

  const sentences: string[] = [];
  if (fixed.length > 0 && debt.length > 0) {
    const names = displayNamesOf([...fixed, ...debt]);
    sentences.push(
      `${subject(names)} ${ficou(names.length)} fora: compromissos fixos e dívidas exigem análise de contrato, saldo e taxas.`,
    );
  } else if (fixed.length > 0) {
    const names = displayNamesOf(fixed);
    const reason =
      names.length === 1
        ? 'é compromisso fixo e exige análise de contrato e condições'
        : 'são compromissos fixos e exigem análise de contrato e condições';
    sentences.push(`${subject(names)} ${ficou(names.length)} fora: ${reason}.`);
  } else if (debt.length > 0) {
    const names = displayNamesOf(debt);
    const reason =
      names.length === 1
        ? 'é dívida e exige análise de saldo, prazo, taxa e condições'
        : 'são dívidas e exigem análise de saldo, prazo, taxa e condições';
    sentences.push(`${subject(names)} ${ficou(names.length)} fora: ${reason}.`);
  }
  if (health.length > 0) {
    const names = displayNamesOf(health);
    sentences.push(
      `${subject(names)} ${ficou(names.length)} fora: corte em despesas de saúde exige avaliação de necessidade.`,
    );
  }
  if (asset.length > 0) {
    const names = displayNamesOf(asset);
    sentences.push(
      `${subject(names)} ${ficou(names.length)} fora: ${names.length === 1 ? 'representa alocação patrimonial, não consumo' : 'representam alocação patrimonial, não consumo'}.`,
    );
  }
  return sentences.join(' ');
}

/**
 * Aviso por TIPO (sem enumerar categorias). Somente usado quando a enumeração
 * completa estouraria o teto defensivo de PAYLOAD_NOTICE_MAX — assim a resposta
 * fresca, o cache e o F5 permanecem idênticos dentro do limite.
 */
function savingsExclusionNoticeByType(
  excluded: ReadonlyArray<ExcludedSavingsOpportunity>,
): string {
  const present: Array<{ noun: string; reason: string }> = [];
  if (excluded.some((e) => e.classification === 'fixed_contract')) {
    present.push({ noun: 'compromissos fixos', reason: 'exigem análise de contrato e condições' });
  }
  if (excluded.some((e) => e.classification === 'debt_commitment')) {
    present.push({ noun: 'dívidas', reason: 'exigem análise de saldo, prazo e taxas' });
  }
  if (excluded.some((e) => e.classification === 'protected_essential')) {
    present.push({ noun: 'despesas de saúde', reason: 'corte exige avaliação de necessidade' });
  }
  if (excluded.some((e) => e.classification === 'asset_allocation')) {
    present.push({ noun: 'investimentos', reason: 'são alocação patrimonial, não consumo' });
  }
  const nouns = joinEn(present.map((p) => p.noun));
  const verb = present.length === 1 ? 'ficou' : 'ficaram';
  return `${nouns} ${verb} fora da simulação percentual: ${present.map((p) => p.reason).join('; ')}.`;
}

/** Aviso completo da simulação (base + exclusões), sempre dentro de PAYLOAD_NOTICE_MAX. */
function composeSavingsNotice(
  pct: number,
  excluded: ReadonlyArray<ExcludedSavingsOpportunity>,
): string {
  const base = savingsNotice(pct);
  const exclusion = savingsExclusionNotice(excluded);
  if (!exclusion) return base;
  const full = `${base} ${exclusion}`;
  if (full.length <= PAYLOAD_NOTICE_MAX) return full;
  return `${base} ${savingsExclusionNoticeByType(excluded)}`;
}

/** Resposta de lente quando a categoria pedida é excluída da simulação. */
function excludedLensMessage(label: string, classification: SavingsClassification): string {
  if (classification === 'fixed_contract') {
    return `A categoria ${label} representa um compromisso fixo e não entra na simulação percentual. O histórico de pagamentos sozinho não permite estimar uma economia real; seria necessário avaliar o contrato e suas condições.`;
  }
  if (classification === 'debt_commitment') {
    return `A categoria ${label} representa uma dívida e não entra na simulação percentual. Para estimar uma possível redução, seriam necessários saldo, prazo, taxa e CET.`;
  }
  if (classification === 'asset_allocation') {
    return `A categoria ${label} representa alocação patrimonial, não consumo reduzível, e por isso não entra na simulação percentual.`;
  }
  return `A categoria ${label} representa uma despesa essencial de saúde e não entra na simulação percentual; não é prudente sugerir corte sem avaliação de necessidade.`;
}

const NO_GROWTH_MESSAGE =
  'Comparando as médias dos últimos 6 meses, não identifiquei categoria com crescimento significativo nos seus gastos.';

const INSUFFICIENT_SAVINGS_MESSAGE =
  'Não há dados suficientes de despesas recorrentes nos últimos 6 meses para estimar uma simulação de economia.';

const INVALID_PERCENT_MESSAGE =
  'Informe um percentual entre 0 e 100 para a simulação (por exemplo, "em 10%" ou "em 12,5%").';

interface TrendBuildOptions {
  /** Lente canônica (matchTerm de resolveCategory) para restringir o resultado. */
  categoryPath?: string;
}

async function buildGrowthCategories(
  supabase: SupabaseClient,
  style: TrendWindowStyle,
  nowISO?: string,
  opts: TrendBuildOptions = {},
  anchorDate?: string,
): Promise<DeterministicAnswer> {
  const anchor = anchorDate ?? nowISO ?? todayISO();
  const w = buildTrendWindow(anchor, style);
  const rows = await fetchPeriodRows(supabase, w.start, w.end);
  const analysis = analyzeCategoryGrowth(rows, w);

  let top = analysis.top;
  if (opts.categoryPath) {
    top = top.filter((r) => matchesCategoryPath(r.label, opts.categoryPath as string));
  }

  const evidence: EvidenceItem[] = [
    { label: 'Aumento identificado', value: analysis.insufficientData ? 'nenhum' : String(top.length) },
    { label: 'Período analisado', value: windowDisplay(w) },
  ];

  if (analysis.insufficientData || top.length === 0) {
    const answer = opts.categoryPath
      ? `Não identifiquei crescimento significativo em ${opts.categoryPath} no período analisado.`
      : NO_GROWTH_MESSAGE;
    const response = makeResponse(
      answer,
      resolvidoAPartirDaJanela(w),
      ['trend_growth'],
      evidence,
    );
    response.cards = [];
    response.notice = 'Nenhuma categoria apresentou crescimento significativo.';
    return {
      intent: 'growth_categories',
      response,
      analysis: analysisOf({
        intent: 'growth_categories',
        w,
        anchorISO: anchor,
        categoryPath: opts.categoryPath,
      }),
    };
  }

  const cards: TrendCard[] = top.map((r) => growthCardOf(r, w));

  const topNames = top
    .map((r) => `${r.label} (${signedBrlCents(r.deltaCents)} por mês)`)
    .join('; ');
  const answer =
    `Sim, identifiquei crescimento significativo em ${top.length} ` +
    `${top.length === 1 ? 'categoria' : 'categorias'}: ${topNames}. ` +
    `${growthSummarySentence(top)} ` +
    'Considere revisar esses itens para entender o motivo do aumento.';

  const response = makeResponse(answer, resolvidoAPartirDaJanela(w), ['trend_growth'], evidence);
  response.cards = cards;
  return {
    intent: 'growth_categories',
    response,
    analysis: analysisOf({
      intent: 'growth_categories',
      w,
      anchorISO: anchor,
      categoryPath: opts.categoryPath,
    }),
  };
}

async function buildSavingsOpportunities(
  supabase: SupabaseClient,
  style: TrendWindowStyle,
  percent: number,
  percentInvalid: boolean,
  nowISO?: string,
  opts: TrendBuildOptions = {},
  anchorDate?: string,
): Promise<DeterministicAnswer> {
  const anchor = anchorDate ?? nowISO ?? todayISO();
  const w = buildTrendWindow(anchor, style);
  if (percentInvalid) {
    const response = makeResponse(
      INVALID_PERCENT_MESSAGE,
      resolvidoAPartirDaJanela(w),
      ['trend_savings'],
      [],
    );
    response.cards = [];
    response.notice = 'Valores de simulação não foram calculados.';
    return {
      intent: 'savings_opportunities',
      response,
      analysis: analysisOf({
        intent: 'savings_opportunities',
        w,
        anchorISO: anchor,
        categoryPath: opts.categoryPath,
      }),
    };
  }

  const rows = await fetchPeriodRows(supabase, w.start, w.end);
  const result = savingsOpportunities(rows, w, percent);

  let top = result.top;
  let excluded = result.excluded;
  if (opts.categoryPath) {
    top = top.filter((s) => matchesCategoryPath(s.label, opts.categoryPath as string));
    excluded = excluded.filter((e) => matchesCategoryPath(e.label, opts.categoryPath as string));
  }

  const exclusionNotice = savingsExclusionNotice(excluded);

  if (result.insufficientData || top.length === 0) {
    let answer: string;
    let notice: string;
    let evidence: EvidenceItem[] = [{ label: 'Período analisado', value: windowDisplay(w) }];
    if (opts.categoryPath) {
      const lensClass = classifySavingsCategory(opts.categoryPath);
      if (lensClass !== 'percentage_candidate') {
        answer = excludedLensMessage(opts.categoryPath, lensClass);
        notice = '';
        evidence = [];
      } else {
        answer =
          `Não encontrei dados suficientes de despesas recorrentes em ${opts.categoryPath} para estimar a simulação.`;
        notice = exclusionNotice || 'Nenhuma simulação de economia foi calculada.';
      }
    } else if (excluded.length > 0) {
      answer =
        'Não encontrei despesas adequadas para uma simulação percentual: as categorias com despesas recorrentes são compromissos fixos, dívidas, despesas de saúde ou alocação patrimonial.';
      notice = exclusionNotice || 'Nenhuma simulação de economia foi calculada.';
    } else {
      answer = INSUFFICIENT_SAVINGS_MESSAGE;
      notice = 'Nenhuma simulação de economia foi calculada.';
    }
    const response = makeResponse(
      answer,
      resolvidoAPartirDaJanela(w),
      ['trend_savings'],
      evidence,
    );
    response.cards = [];
    if (notice) response.notice = notice;
    return {
      intent: 'savings_opportunities',
      response,
      analysis: analysisOf({
        intent: 'savings_opportunities',
        w,
        anchorISO: anchor,
        simulationPct: percent,
        categoryPath: opts.categoryPath,
      }),
    };
  }

  const cards: TrendCard[] = top.map((s) => savingCardOf(s, w));
  const topNames = top.map((s) => s.label).join('; ');
  const answer =
    `Com uma redução de ${formatPercent(percent)} sobre as médias mensais recentes, ` +
    `as maiores oportunidades potenciais para revisar estão em: ${topNames}.`;

  const response = makeResponse(answer, resolvidoAPartirDaJanela(w), ['trend_savings'], [
    { label: 'Período analisado', value: windowDisplay(w) },
  ]);
  response.cards = cards;
  response.notice = composeSavingsNotice(percent, excluded);
  return {
    intent: 'savings_opportunities',
    response,
    analysis: analysisOf({
      intent: 'savings_opportunities',
      w,
      anchorISO: anchor,
      simulationPct: percent,
      categoryPath: opts.categoryPath,
    }),
  };
}

// ── Projeção determinística (PESSOAL-13C4A-E2 — Fase 3) ────────
//
// Fase 3 cobre APENAS os intents diretos e o despacho ao adapter:
//   projection_base                 próximos 12 meses / anualizada
//   projection_current_month        fechamento estimado do mês atual
//   projection_month_comparison     mês atual ou passado vs média dos 12 anteriores
//   projection_categories           projeção geral por categorias
//   projection_clarification        esclarecimento determinístico SEM banco
//
// Regras desta fase:
//   - sinais fortes: projeção, previsão de gastos, estimativa, continuar nesse
//     ritmo, quanto vou gastar, quanto fecho o mês;
//   - "Projeção" / "quero uma previsão" / "e a projeção?" → pergunta com quatro
//     opções determinística, NUNCA Gemini;
//   - "fechamento do ano" → esclarece ano-calendário × próximos 12 meses (não
//     são equivalentes);
//   - mês futuro → explicação determinística, sem inventar cálculo;
//   - categoria isolada ("projeção de supermercado") → esclarecer nesta fase
//     (filtros/lentes contextuais pertencem ao E3);
//   - reconhecida → fetchProjection (relógio injetado nowISO repassado como
//     todayISO); ambígua → zero consulta; erro do adapter → FALHA CONTROLADA
//     propagada pelo contrato existente do endpoint (AskError → HTTP ≠ 200, sem
//     Gemini, sem persistir/cachear resposta) — NUNCA vira clarification;
//   - nenhum registro em toolRegistry.ts; apenas texto determinístico mínimo
//     (sem payload/cards/persistência/follow-ups/observabilidade).
//
// Precedência: growth/savings rodam antes; as perguntas de projeção não contêm
// aqueles sinais (sem regressão). A detecção ocorre na pergunta principal CRUA,
// antes do contexto — "e a projeção?" nunca vira follow-up de categoria.

type ProjectionClarificationKind =
  | 'ambiguous'
  | 'year_close'
  | 'category'
  | 'future_month'
  | 'reference_month'
  | 'unknown_lens';

interface ProjectionRoute {
  intent:
    | 'projection_base'
    | 'projection_current_month'
    | 'projection_month_comparison'
    | 'projection_categories'
    | 'projection_clarification';
  clarification?: ProjectionClarificationKind;
  referenceMonth?: YearMonth;
  /** Termo de categoria isolada capturado (clarification 'category'), resolvido contextualmente no E3. */
  lensTerm?: string | null;
}

const PROJECTION_AMBIGUOUS_TEXT =
  'Posso te ajudar com a projeção em quatro cenários: 1) os próximos 12 meses ' +
  '(anualizado); 2) o fechamento estimado do mês atual; 3) o mês atual ou o mês ' +
  'passado comparado com a média dos 12 meses anteriores; 4) a projeção geral ' +
  'por categorias. Escolha um cenário para eu seguir.';

const PROJECTION_YEAR_CLOSE_TEXT =
  'Você quer o fechamento do ano-calendário ou a projeção dos próximos 12 meses?';

const PROJECTION_CATEGORY_TEXT =
  'Ainda não consigo projetar uma categoria isolada nesta versão. Posso projetar ' +
  'o cenário geral (próximos 12 meses), o fechamento do mês atual, a comparação ' +
  'do mês com a média dos 12 anteriores ou a projeção por categorias.';

const PROJECTION_FUTURE_TEXT =
  'Ainda não consigo projetar meses futuros. Posso projetar o fechamento do mês ' +
  'atual, a comparação de um mês anterior com a média dos 12 meses anteriores ou ' +
  'o cenário dos próximos 12 meses.';

// PESSOAL-13C4A-E3: esclarecimentos dos follow-ups contextuais — texto de
// exibição, nunca lógica. A rota da resposta é sempre determinística.
const PROJECTION_REFERENCE_MONTH_TEXT =
  'O fechamento estimado vale para o mês atual. Posso comparar um mês anterior ' +
  'com a média dos 12 meses anteriores ou projetar os próximos 12 meses. Qual prefere?';

const PROJECTION_UNKNOWN_LENS_TEXT =
  'Não identifiquei essa categoria na sua lista. Informe só o nome, como ' +
  'supermercado, transporte ou aluguel, para eu restringir a projeção a ela.';

const PROJECTION_UNCATEGORIZED_LABEL = 'Sem categoria';
const PROJECTION_MONTHS_AGO_RE = /\b(?:mes\s+passado|ultimo\s+mes|mes\s+anterior)\b/i;
const PROJECTION_UNCATEGORIZED_RE =
  /\b(?:sem\s+categoria|sem\s+categorizar|nao\s+categorizad[ao])\b/i;
const PROJECTION_CLEAR_LENS_RE =
  /\b(?:sem\s+filtro|sem\s+filtrar|visao\s+geral|projec(?:ao|oes)\s+geral|tudo\s+de\s+novo)\b/i;
// Follow-ups que claramente pedem valores financeiros ("E quanto gastei?",
// "E o saldo?") NUNCA podem ser leitura de lente/mês de projeção.
const PROJECTION_FOLLOWUP_REJECT =
  /\b(?:gastei|gasto|gastou|recebi|recebemos|saldo|resultad(?:o|os?))\b/i;
// Termos que, se aparecerem, indicam que o follow-up NÃO é uma lente de categoria
// (inclui os introtips de visão do E3: comparação, média, categorias, anual, fechamento).
const PROJECTION_LENS_TERM_REJECT =
  /\b(?:quanto|qual|quais|ai|agora|depois|mes(?:es)?|ano|periodo|informe|diga|entao|incluindo|ate|hoje|atual|corrente|como|ficaria|fosse|poderia|seria|acha|isso|disso|tudo|todos|total|geral|categorias?|comparar|comparaca?o|comparad[oa]?|versus|media|medias|anual|anualizad|proximos?|12|fech(?:o|ar|amento|ando|a)|este|esse|neste|nesse)\b/i;
const PROJECTION_LENS_PREFIX_RE =
  /^(?:e\s+|entao\s+|depois\s+)?(?:so\s+|somente\s+|apenas\s+)?(?:(?:o|a|os|as)\s+)?(?:(?:em|com|na|no|de|do|da|para|sobre)\s+)?/i;
const PROJECTION_GASTO_PREFIX_RE = /^(?:gast[oa]s?|despesas?|foco)\s+(?:com\s+|em\s+|de\s+|no\s+|na\s+|para\s+|sobre\s+)+/;

/**
 * Lente de categoria da projeção (PESSOAL-13C4A-E3). Só path canônico (matchTerm
 * de resolveCategory) + rótulo de exibição — nunca UUIDs/paths internos.
 */
type ProjectionRouteLens =
  | { kind: 'category'; categoryPath: string; label: string }
  | { kind: 'uncategorized'; label: string };

function leafLabelOfPath(path: string): string {
  return path
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop() ?? path;
}

function toLensInput(lens: ProjectionRouteLens | null | undefined): ProjectionLensInput | null {
  if (!lens) return null;
  if (lens.kind === 'uncategorized') return { kind: 'uncategorized' };
  return { kind: 'category', categoryPath: lens.categoryPath };
}

function projectCtxReference(ctx: ChatProjectionContext, todayISO: string): YearMonth {
  const parsed = /^\d{4}-\d{2}$/.test(ctx.referenceMonth)
    ? { year: Number(ctx.referenceMonth.slice(0, 4)), month: Number(ctx.referenceMonth.slice(5, 7)) }
    : null;
  if (parsed && parsed.month >= 1 && parsed.month <= 12) return parsed;
  return yearMonthOfProjection(todayISO);
}

function ctxLens(ctx: ChatProjectionContext): ProjectionRouteLens | null {
  if (ctx.lensKind === 'uncategorized') {
    return { kind: 'uncategorized', label: PROJECTION_UNCATEGORIZED_LABEL };
  }
  if (ctx.lensKind === 'category' && ctx.lensPath) {
    return {
      kind: 'category',
      categoryPath: ctx.lensPath,
      label: ctx.lensLabel ?? leafLabelOfPath(ctx.lensPath),
    };
  }
  return null;
}

function monthRankOf(ym: YearMonth): number {
  return ym.year * 12 + (ym.month - 1);
}

function monthIsFuture(target: YearMonth, todayISO: string): boolean {
  return monthRankOf(target) > monthRankOf(yearMonthOfProjection(todayISO));
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

function monthTargetOf(norm: string, todayISO: string): YearMonth | null {
  if (PROJECTION_MONTHS_AGO_RE.test(norm)) {
    return addMonths(yearMonthOfProjection(todayISO), -1);
  }
  const monthNumber = firstMonthNumber(norm);
  if (!monthNumber) return null;
  const current = yearMonthOfProjection(todayISO);
  return { year: Number(yearOfToken(norm) ?? String(current.year)), month: monthNumber };
}

/** Encapsula o PATH canônico do segmento casado + rótulo de exibição da lente. */
function lensOfResolved(
  resolved: Extract<ResolvedCategory, { status: 'resolved' }>,
): ProjectionRouteLens {
  return { kind: 'category', categoryPath: resolved.matchTerm, label: leafLabelOfPath(resolved.matchTerm) };
}

/**
 * Resolve o termo de uma lente de categoria para a classificação CANÔNICA das
 * categorias do usuário (mesma regra de match dos agregadores/tendências).
 * Retorna null quando o termo não é uma categoria reconhecida (tratamento
 * 'unknown_lens' fica a cargo do chamador).
 */
async function resolveProjectionLens(
  supabase: SupabaseClient,
  term: string,
): Promise<ProjectionRouteLens | null> {
  const labels = await fetchExpenseCategories(supabase);
  const resolved = resolveCategory(labels, term);
  if (resolved?.status === 'resolved') return lensOfResolved(resolved);
  if (resolved?.status !== 'ambiguous') return null;
  // (PESSOAL-13C4A-E3.1A) Precedência do alias na LENTE: quando o termo é
  // EXATAMENTE o sinônimo canônico isolado ("mercado" → "supermercado") e há um
  // ÚNICO nó com o segmento canônico do alias entre os candidatos, ele vence —
  // inclusive sobre a categoria nomeada com o próprio termo ("Alimentação >
  // mercado"). Sem isso, "E só mercado?" ficaria ambíguo e viraria
  // 'unknown_lens'. Nunca substring: o segmento precisa ser inteiro.
  const aliasTarget = SEGMENT_ALIAS[normalizeCategoryTerm(term)];
  if (aliasTarget) {
    const seen = new Set<string>();
    const aliased: ResolvedCategoryMatch[] = [];
    for (const m of resolved.matches) {
      if (seen.has(m.matchTerm)) continue;
      seen.add(m.matchTerm);
      const pathSegs = normalizeCategoryTerm(m.matchTerm)
        .split('>')
        .map((s) => s.trim());
      if (pathSegs.includes(aliasTarget)) aliased.push(m);
    }
    if (aliased.length === 1) {
      return lensOfResolved({ status: 'resolved', label: aliased[0].label, matchTerm: aliased[0].matchTerm });
    }
  }
  return null;
}

/**
 * Extrai o termo de lente de um follow-up elíptico de projeção ("E só
 * supermercado?", "E com transporte?"). Dedica-se a este papel para nunca
 * capturar meses, períodos, comparativos nem termos genéricos (ex.: "E a
 * comparação?" → null; "E em maio?" → null). Quando mês e lente aparecem
 * combinados ("E em maio só supermercado?"), a LENTE prevalece (frase de mês é
 * descartada apenas do alto) — sem nunca engolir um mês sozinho.
 */
function extractProjectionLensTerm(norm: string): string | null {
  if (!CONTINUATION_RE.test(norm) && !/^(?:so\s+|somente\s+|apenas\s+)/.test(norm)) return null;
  if (PROJECTION_LENS_TERM_REJECT.test(norm)) return null;
  const stripMonthPhrase = (input: string): string => {
    const ago = /^(?:em|no|na|para)\s+(?:mes\s+passado|ultimo\s+mes|mes\s+anterior)\b/.exec(input)?.[0];
    if (ago) return input.slice(ago.length).trim();
    const prep = /^(?:em|no|na|para)\s+/.exec(input)?.[0];
    if (prep) {
      const after = input.slice(prep.length);
      const first = after.split(/\s+/)[0] ?? '';
      if (MONTH_BY_NORM[first] != null) {
        return after.split(/\s+/).slice(1).join(' ');
      }
    }
    // Mês NU no início restando do prefixo ("e em maio so supermercado?" →
    // 'maio so supermercado'): a LENTE vence — descarta o mês só se sobrar
    // outro conteúdo (mês puro segue para o guarda de mês e vira null).
    const tokens = input.split(/\s+/);
    const firstToken = tokens[0] ?? '';
    const remaining = tokens.slice(1).join(' ');
    if (firstToken && MONTH_BY_NORM[firstToken] != null && remaining.trim()) {
      return remaining;
    }
    return input;
  };
  let rest = stripMonthPhrase(norm);
  rest = rest
    .replace(PROJECTION_LENS_PREFIX_RE, (m) => (m ? ' ' : m))
    .trim();
  rest = stripMonthPhrase(rest);
  rest = rest.replace(PROJECTION_LENS_PREFIX_RE, (m) => (m ? ' ' : m)).trim();
  let term = rest.replace(/[?.!;].*$/, ' ').split(',')[0].split(/\s+e\s+/)[0].trim();
  if (!term) return null;
  const first = term.split(/\s+/)[0];
  if (first && MONTH_BY_NORM[first] != null) return null;
  term = collapseLensTerm(term);
  if (!term || PROJECTION_LENS_TERM_REJECT.test(term)) return null;
  // (PESSOAL-13C4A-E3.1) Ano puro restante ("e em agosto de 2026" → '2026')
  // NUNCA é lente: pertencia à frase de mês e deve voltar ao fluxo de mês.
  if (/^\d{4}$/.test(term)) return null;
  return term;
}

function collapseLensTerm(term: string): string {
  return term.replace(PROJECTION_GASTO_PREFIX_RE, '');
}

interface ProjectionFollowUpBuild {
  kind: 'build';
  intent: ProjectionPayloadIntent;
  referenceMonth: YearMonth;
  lens: ProjectionRouteLens | null;
}
interface ProjectionFollowUpClarify {
  kind: 'clarification';
  clarification: ProjectionClarificationKind;
}
type ProjectionFollowUp = ProjectionFollowUpBuild | ProjectionFollowUpClarify;

/**
 * Follow-up ELÍPTICO de projeção (PESSOAL-13C4A-E3): lente específica/limpa,
 * novo mês de referência ou troca de visão, sempre a partir do contexto. Sem
 * prefixo de continuidade (ou com sinais de valores financeiros) → null (a
 * pergunta segue para os intents tradicionais/Gemini). NUNCA consulta dados
 * financeiros — apenas categorias para resolver a lente.
 */
async function resolveProjectionFollowUp(
  supabase: SupabaseClient,
  norm: string,
  ctx: ChatProjectionContext,
  todayISO: string,
): Promise<ProjectionFollowUp | null> {
  if (!CONTINUATION_RE.test(norm) && !/^(?:so\s+|somente\s+|apenas\s+)/.test(norm)) return null;
  if (PROJECTION_FOLLOWUP_REJECT.test(norm)) return null;

  // 1) Limpar a lente e manter a projeção ativa.
  if (PROJECTION_CLEAR_LENS_RE.test(norm)) {
    return {
      kind: 'build',
      intent: ctx.intent,
      referenceMonth: projectCtxReference(ctx, todayISO),
      lens: null,
    };
  }

  // 2) Lente "sem categoria" (uncategorized) — ANTES de qualquer leitura de
  //    termo, para que "E sem categoria?" nunca caia na troca de visão.
  if (PROJECTION_UNCATEGORIZED_RE.test(norm)) {
    return {
      kind: 'build',
      intent: ctx.intent,
      referenceMonth: projectCtxReference(ctx, todayISO),
      lens: { kind: 'uncategorized', label: PROJECTION_UNCATEGORIZED_LABEL },
    };
  }

  // 3) Lente específica. No mês+lente combinado a lente vence nesta fase
  //    (1ª iteração do E3), sem inventar semântica.
  const lensTerm = extractProjectionLensTerm(norm);
  if (lensTerm) {
    const lens = await resolveProjectionLens(supabase, lensTerm);
    if (!lens) return { kind: 'clarification', clarification: 'unknown_lens' };
    return { kind: 'build', intent: ctx.intent, referenceMonth: projectCtxReference(ctx, todayISO), lens };
  }

  // 4) Novo mês de referência ("E em maio?", "E o mês passado?").
  if (isFutureProjectionMonth(norm, todayISO)) {
    return { kind: 'clarification', clarification: 'future_month' };
  }
  const target = monthTargetOf(norm, todayISO);
  if (target) {
    const current = yearMonthOfProjection(todayISO);
    if (sameMonth(target, current)) {
      return { kind: 'build', intent: ctx.intent, referenceMonth: target, lens: ctxLens(ctx) };
    }
    if (monthIsFuture(target, todayISO)) {
      return { kind: 'clarification', clarification: 'future_month' };
    }
    if (ctx.intent === 'projection_current_month') {
      // Fechamento estimado só existe para o mês atual → esclarecer. EXCEÇÃO
      // (PESSOAL-13C4A-E3.1A): mês PASSADO explícito COM ANO ("E em agosto de
      // 2026?") re-ancora uma comparação mensal com a MESMA lente — o
      // fechamento nunca se aplica, mas a comparação do mês passado sim. Mês
      // sem ano ("E em maio?") mantém o esclarecimento de sempre.
      if (yearOfToken(norm) != null) {
        return { kind: 'build', intent: 'projection_month_comparison', referenceMonth: target, lens: ctxLens(ctx) };
      }
      return { kind: 'clarification', clarification: 'reference_month' };
    }
    return { kind: 'build', intent: ctx.intent, referenceMonth: target, lens: ctxLens(ctx) };
  }

  // 4) Troca de visão elíptica ("E as categorias?", "E a comparação?").
  if (/\bcategorias?\b/.test(norm) || /\bpor\s+categoria\b/.test(norm)) {
    return { kind: 'build', intent: 'projection_categories', referenceMonth: projectCtxReference(ctx, todayISO), lens: ctxLens(ctx) };
  }
  if (/\b(?:comparar|comparaca?o|comparad[oa]|versus|vs|media)\b/.test(norm)) {
    return { kind: 'build', intent: 'projection_month_comparison', referenceMonth: projectCtxReference(ctx, todayISO), lens: ctxLens(ctx) };
  }
  if (/\b(?:proximos?\s+12\s+meses|12\s+meses|anual|anualizad|no\s+ano|por\s+mes)\b/.test(norm)) {
    return { kind: 'build', intent: 'projection_base', referenceMonth: yearMonthOfProjection(todayISO), lens: ctxLens(ctx) };
  }
  if (/\b(?:este|esse|neste|nesse)\s+mes\b|\bmes\s+atual\b|\bfech(?:o|amento)\b/.test(norm)) {
    return { kind: 'build', intent: 'projection_current_month', referenceMonth: yearMonthOfProjection(todayISO), lens: ctxLens(ctx) };
  }
  return null;
}

function isProjectionQuestion(norm: string): boolean {
  return (
    /\bprojec(?:ao|oes)\b/.test(norm) ||
    /\bprevis[a-z]*\b/.test(norm) ||
    /\bestimativ[a-z]*\b/.test(norm) ||
    /\bestimar\b/.test(norm) ||
    /\britmo\b/.test(norm) ||
    /\bquanto\s+(?:vou|voce\s+vai)\s+gastar\b/.test(norm) ||
    /\bfech(?:o|ar|amento|ando|a)\b[^.!?;]{0,40}\bmes\b/.test(norm) ||
    /\bfech(?:o|ar|amento|ando|a)\b[^.!?;]{0,40}\bano\b/.test(norm)
  );
}

/**
 * Categoria isolada em perguntas de projeção ("projeção de supermercado").
 * Termos genéricos/período/comparação NÃO contam como categoria (aí a pergunta
 * segue para os subtipos de projeção). Rejeita mês/ano/média/comparação.
 */
function projectionCategoryTerm(norm: string): string | null {
  const m =
    /\b(?:projec(?:ao|oes)|previs[a-z]*)\s+(?:de|em|para|por|d[ao]s?)\s+(.+)$/.exec(norm);
  if (!m) return null;
  const term = normalizeText(m[1].replace(/[?.!;]+.*$/, ' ').split(',')[0]);
  if (!term) return null;
  if (
    /\b(?:mes|meses|ano|anos|media|medias|comparar|comparaca?o|comparad|versus|vs|ritmo|proximos|ultimos|12)\b/.test(
      term,
    ) ||
    /\b(?:gastos?|despesas?|categorias?|tudo|todos|total|geral)\b/.test(term)
  ) {
    return null;
  }
  const first = term.split(/\s+/)[0];
  if (MONTH_BY_NORM[first]) return null;
  return term;
}

function yearMonthOfProjection(iso: string): YearMonth {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

function monthRankProjection(ym: YearMonth): number {
  return ym.year * 12 + (ym.month - 1);
}

/** Mês futuro explícito (ou "próximo mês") → não suportado nesta fase. */
function isFutureProjectionMonth(norm: string, todayISO: string): boolean {
  if (/\bproximo\s+mes\b|\bmes\s+que\s+vem\b|\bmes\s+seguinte\b/.test(norm)) return true;
  const current = yearMonthOfProjection(todayISO);
  const monthNumber = firstMonthNumber(norm);
  if (monthNumber) {
    const year = Number(yearOfToken(norm) ?? String(current.year));
    if (monthRankProjection({ year, month: monthNumber }) > monthRankProjection(current)) {
      return true;
    }
  }
  const yearToken = yearOfToken(norm);
  if (yearToken && monthNumber == null && Number(yearToken) > current.year) return true;
  return false;
}

/** Mês de referência da comparação: mês passado/último mês OU mês explícito (não futuro) OU atual. */
function projectionComparisonReference(norm: string, todayISO: string): YearMonth {
  const current = yearMonthOfProjection(todayISO);
  if (/\bmes\s+passado\b|\bultimo\s+mes\b|\bmes\s+anterior\b/.test(norm)) {
    return addMonths(current, -1);
  }
  const monthNumber = firstMonthNumber(norm);
  if (monthNumber) {
    return {
      year: Number(yearOfToken(norm) ?? String(current.year)),
      month: monthNumber,
    };
  }
  return current;
}

function detectProjection(norm: string, todayISO: string): ProjectionRoute | null {
  if (!isProjectionQuestion(norm)) return null;

  // 1) Fechamento do ANO → esclarecer (ano-calendário ≠ próximos 12 meses).
  if (/\bfech(?:o|ar|amento|ando|a)\b[^.!?;]{0,40}\bano\b/.test(norm)) {
    return { intent: 'projection_clarification', clarification: 'year_close' };
  }

  // 2) Categoria isolada → esclarecer na ausência de contexto (E2); com
  //    contexto de projeção, o E3 resolve a lente a partir do termo capturado.
  const categoryTerm = projectionCategoryTerm(norm);
  if (categoryTerm) {
    return { intent: 'projection_clarification', clarification: 'category', lensTerm: categoryTerm };
  }

  // 3) Mês futuro → explicação determinística, nunca cálculo inventado.
  if (isFutureProjectionMonth(norm, todayISO)) {
    return { intent: 'projection_clarification', clarification: 'future_month' };
  }

  // 4) Subtipos diretos.
  if (/\bcategorias?\b/.test(norm) || /\bpor\s+categoria\b/.test(norm)) {
    return { intent: 'projection_categories' };
  }
  // Comparação ANTES da marca de "12 meses" da base: "…comparado à média dos 12
  // meses anteriores" é comparação, não anualizado.
  if (
    /\b(?:comparar|comparaca?o|comparad[oa]|versus|vs|media|meses\s+anteriores)\b/.test(norm) ||
    /\bmes\s+(?:passado|anterior)\b|\bultimo\s+mes\b/.test(norm)
  ) {
    return {
      intent: 'projection_month_comparison',
      referenceMonth: projectionComparisonReference(norm, todayISO),
    };
  }
  if (/\b(?:proximos?\s+12\s+meses|12\s+meses|anual|anualizad|no\s+ano|por\s+mes)\b/.test(norm)) {
    return { intent: 'projection_base' };
  }
  if (
    /\b(?:este|esse|neste|nesse)\s+mes\b/.test(norm) ||
    /\bmes\s+atual\b/.test(norm) ||
    /\bfech(?:o|ar|amento|ando|a)\b[^.!?;]{0,40}\bmes\b/.test(norm) ||
    /\bquanto\s+(?:vou|voce\s+vai)\s+gastar\b/.test(norm)
  ) {
    return { intent: 'projection_current_month' };
  }

  // 5) Núcleo nu ("Projeção", "e a projeção?", "quero uma previsão") → 4 opções;
  //    com palavra de despesa ("previsão de gastos") → base.
  if (/\b(?:gastos?|despesas?)\b/.test(norm)) {
    return { intent: 'projection_base' };
  }
  if (/\b(?:projec(?:ao|oes)|previs[a-z]*|estimativ[a-z]*)\b/.test(norm)) {
    return { intent: 'projection_clarification', clarification: 'ambiguous' };
  }
  return { intent: 'projection_base' };
}

// ── Construção das respostas de projeção (texto mínimo e seguro) ─
// brlCents (reais → "R$ ..." a partir de centavos) já existe acima.

function monthLabelOf(ym: YearMonth): string {
  return `${MONTH_FULL[ym.month - 1] ?? ym.month} de ${ym.year}`;
}

function monthRangeOf(ym: YearMonth): { start: string; end: string } {
  return {
    start: `${ym.year}-${pad2(ym.month)}-01`,
    end: lastDayOf(String(ym.year), ym.month),
  };
}

const PROJECTION_DISCLAIMER = ' Cenário histórico, sem garantia nem recomendação.';

function monthKeyOfPayload(month: string): YearMonth {
  const [year, m] = month.split('-').map(Number);
  return { year, month: m };
}

function monthRangeOfKey(month: string): { start: string; end: string } {
  return monthRangeOf(monthKeyOfPayload(month));
}

function directionLabel(deviation: ProjectionPayloadDeviation): string {
  if (deviation === 'above') return 'acima da referência';
  if (deviation === 'below') return 'abaixo da referência';
  return 'igual à referência';
}

function coveragePhrase(quality: ProjectionPayloadQuality, coveredMonths: number): string {
  return quality === 'preliminary'
    ? `base preliminar em ${coveredMonths} dos 12 meses`
    : `${coveredMonths} meses cobertos`;
}

function makeProjectionAnswer(
  intent: DeterministicIntent,
  answer: string,
  period: { start: string; end: string },
): DeterministicAnswer {
  return {
    intent,
    response: {
      answer,
      period,
      toolsUsed: ['projection'],
      evidence: [],
      engine: 'deterministic',
      geminiCallCount: 0,
      periodAnalyzed: period,
    },
  };
}

function projectionClarificationAnswer(
  kind: ProjectionClarificationKind,
  todayISO: string,
): DeterministicAnswer {
  const text = {
    ambiguous: PROJECTION_AMBIGUOUS_TEXT,
    year_close: PROJECTION_YEAR_CLOSE_TEXT,
    category: PROJECTION_CATEGORY_TEXT,
    future_month: PROJECTION_FUTURE_TEXT,
    reference_month: PROJECTION_REFERENCE_MONTH_TEXT,
    unknown_lens: PROJECTION_UNKNOWN_LENS_TEXT,
  }[kind];
  const range = monthRangeOf(yearMonthOfProjection(todayISO));
  return {
    intent: 'projection_clarification',
    response: {
      answer: text,
      period: range,
      toolsUsed: ['projection_clarification'],
      evidence: [],
      engine: 'deterministic',
      geminiCallCount: 0,
      periodAnalyzed: range,
    },
  };
}

function projectionBaseText(p: ProjectionPayloadSuccessV1): string {
  return (
    `Com ${coveragePhrase(p.quality, p.coverage.coveredMonths)}, a média mensal é de ${brlCents(
      p.summary.monthlyMeanCents,
    )} e o cenário anualizado para os próximos 12 meses é de ${brlCents(
      p.summary.annualScenarioCents,
    )}.` + PROJECTION_DISCLAIMER
  );
}

function projectionCurrentMonthText(p: ProjectionPayloadSuccessV1): string {
  const c = p.comparison;
  if (c.referenceBasis !== 'expected_to_date') {
    throw new Error('Mês atual com comparação fora de expected_to_date.');
  }
  const closing =
    c.closingProjectionCents === null
      ? ' Ainda é cedo para estimar o fechamento: ele passa a ser calculado a partir do 7º dia do mês.'
      : ` Pelo ritmo atual, o fechamento estimado do mês é de ${brlCents(c.closingProjectionCents)}.`;
  return (
    `No mês atual, o realizado até hoje é de ${brlCents(c.realizedCents)}, contra um esperado ` +
    `proporcional de ${brlCents(c.expectedToDateCents)} (${directionLabel(c.deviation)}). ` +
    `Lançamentos futuros já registrados somam ${brlCents(c.futureRegisteredCents)} e o comprometido ` +
    `(realizado + futuros) fica em ${brlCents(c.committedCents)}.` +
    closing +
    PROJECTION_DISCLAIMER
  );
}

function projectionMonthComparisonText(p: ProjectionPayloadSuccessV1): string {
  const c = p.comparison;
  if (c.referenceBasis === 'monthly_mean') {
    return (
      `Em ${monthLabelOf(monthKeyOfPayload(p.reference.month))}, a despesa foi de ${brlCents(
        c.realizedCents,
      )}, contra a média mensal de ${brlCents(c.referenceCents)} dos 12 meses anteriores ` +
      `(${directionLabel(c.deviation)}).` + PROJECTION_DISCLAIMER
    );
  }
  return (
    `No mês atual, o realizado até hoje é de ${brlCents(c.realizedCents)}, contra o esperado ` +
    `proporcional de ${brlCents(c.referenceCents)} (${directionLabel(c.deviation)}).` +
    PROJECTION_DISCLAIMER
  );
}

function projectionCategoriesText(p: ProjectionPayloadSuccessV1): string {
  const top = p.categories.slice(0, 2);
  const names =
    top.length === 0
      ? 'ainda não há categorias representativas'
      : top.map((cat) => `${cat.label} (${brlCents(cat.monthlyMeanCents)}/mês)`).join(' e ');
  return (
    `Categorias de maior peso: ${names}. ` +
    `Com ${coveragePhrase(p.quality, p.coverage.coveredMonths)}; detalhes completos no resumo por categorias.` +
    PROJECTION_DISCLAIMER
  );
}

function projectionInsufficientTextOf(p: ProjectionPayloadInsufficientV1): string {
  return (
    `Ainda não há dados suficientes para projetar: foram encontrados ${p.reason.coveredMonths} de ` +
    `${p.coverage.windowMonths} meses com cobertura completa (mínimo de ${p.reason.minimumCoveredMonths}). ` +
    `Por isso não apresento média mensal, fechamento, comparação nem projeção por categorias.` +
    PROJECTION_DISCLAIMER
  );
}

/**
 * Texto da resposta de projeção derivado EXCLUSIVAMENTE do ProjectionPayloadV1 —
 * a mesma fonte que cards/persistência/cache usam. Nenhum valor é recalculado:
 * só os agregados já mapeados são formatados (pt-BR).
 */
function projectionAnswerText(payload: ProjectionPayloadV1): string {
  if (payload.status === 'insufficient') return projectionInsufficientTextOf(payload);
  switch (payload.intent) {
    case 'projection_base':
      return projectionBaseText(payload);
    case 'projection_current_month':
      return projectionCurrentMonthText(payload);
    case 'projection_month_comparison':
      return projectionMonthComparisonText(payload);
    case 'projection_categories':
      return projectionCategoriesText(payload);
  }
}

function projectionPeriodOf(payload: ProjectionPayloadV1): { start: string; end: string } {
  const window = {
    start: `${payload.coverage.windowStart}-01`,
    end: monthRangeOfKey(payload.coverage.windowEnd).end,
  };
  if (payload.status === 'insufficient') return window;
  if (
    payload.intent === 'projection_current_month' ||
    payload.intent === 'projection_month_comparison'
  ) {
    return monthRangeOfKey(payload.reference.month);
  }
  return window;
}

/** Restringe um DeterministicIntent aos QUATRO intents reais de projeção. */
function isProjectionPayloadIntent(
  intent: DeterministicIntent,
): intent is ProjectionPayloadIntent {
  return (PROJECTION_INTENTS as readonly string[]).includes(intent);
}

function toProjectionDeterministicAnswer(
  intent: DeterministicIntent,
  result: ProjectionEngineResult,
  lens?: ProjectionRouteLens | null,
  route: ProjectionRouteMode = 'direct',
): DeterministicAnswer {
  // PESSOAL-13C4A-E2: o payload versionado acompanha APENAS turnos de projeção
  // reais (full/preliminary/insufficient). Clarification e falha de
  // infraestrutura nunca chegam aqui — logo nenhuma resposta deles carrega
  // `projection`. A forma mapeada é validável e idempotente pelo sanitizador
  // na fronteira de persistência, garantindo fresh === cache === listMessages.
  if (!isProjectionPayloadIntent(intent)) {
    throw new Error('Rotear projeção com intent inválido.');
  }
  const projection = mapProjectionToPayloadV1(result, intent, lens?.label);
  const resolved = makeProjectionAnswer(
    intent,
    projectionAnswerText(projection),
    projectionPeriodOf(projection),
  );
  resolved.response.projection = projection;
  if (projection.status === 'success') {
    // PESSOAL-13C4A-E3: contexto de follow-up apenas com projeção REAL (status
    // success); './insufficient' e clarification nunca persistem contexto.
    resolved.projection = {
      version: 1,
      intent: projection.intent,
      referenceMonth: projection.reference.month,
      ...(lens
        ? {
            lensKind: lens.kind as ChatProjectionContext['lensKind'],
            ...(lens.kind === 'category'
              ? { lensPath: lens.categoryPath, lensLabel: lens.label }
              : { lensLabel: lens.label }),
          }
        : {}),
    };
    resolved.projectionRoute = route;
  }
  return resolved;
}

/**
 * Despacha um intent de projeção ao adapter. Falha de INFRAESTRUTURA do adapter
 * (ProjectionDataError ou erro inesperado de consulta) PROPAGA como erro
 * controlado do contrato do endpoint (AskError → HTTP ≠ 200, sanitizado, sem
 * Gemini, sem persistir resposta) — projection_clarification é reservado para
 * ambiguidade SEMÂNTICA da pergunta.
 */
async function buildProjectionAnswer(
  supabase: SupabaseClient,
  intent: DeterministicIntent,
  referenceMonth: YearMonth,
  todayISO: string,
  opts?: { lens?: ProjectionRouteLens | null; route?: ProjectionRouteMode },
): Promise<DeterministicAnswer> {
  const result = await fetchProjection(supabase, {
    todayISO,
    referenceMonth,
    lens: toLensInput(opts?.lens ?? null),
  });
  return toProjectionDeterministicAnswer(intent, result, opts?.lens ?? null, opts?.route ?? 'direct');
}

/**
 * Build a projeção a partir do CONTEXTO persistido (E3). Só deve ser chamado
 * quando existir contexto de projeção válido; nunca consulta valores no
 * contexto — re-consulta finanças e re-deriva o payload do zero.
 */
async function buildProjectionFromContext(
  supabase: SupabaseClient,
  ctx: ChatProjectionContext,
  todayISO: string,
  lens: ProjectionRouteLens | null,
  route: ProjectionRouteMode,
): Promise<DeterministicAnswer | null> {
  if (!supportsPaginableAsync(supabase)) return null;
  try {
    return await buildProjectionAnswer(
      supabase,
      ctx.intent,
      projectCtxReference(ctx, todayISO),
      todayISO,
      { lens, route },
    );
  } catch (err) {
    throw withProjectionIntent(err, ctx.intent);
  }
}

/**
 * Converte erro de infraestrutura da projeção em erro controlado do contrato
 * existente do endpoint, preservando o intent detectado para o diagnóstico
 * sanitizado — nunca expõe mensagem bruta do Supabase/stack/tabela/SQL/UUID.
 */
function withProjectionIntent(err: unknown, intent: string): unknown {
  const converted: unknown =
    err instanceof AskError
      ? err
      : err instanceof ProjectionDataError
        ? new AskError('supabase_query', {
            category: 'supabase_query_error',
            providerStatus: providerStatusOf(err),
            retryable: false,
          })
        : toAskSupabaseError(err);
  if (converted instanceof AskError) {
    (converted as AskError & { intent?: string }).intent = intent;
  }
  return converted;
}

// ── Follow-up elíptico de projeção SEM contexto (PESSOAL-13C4A-E3.1) ──

/**
 * Expressões de projeção que dispensam o contexto do turno anterior para
 * serem reconhecidas em modo elíptico ("E por categorias?", "E comparado ao
 * mês passado?", "E sem filtro?", "Só a média anual?", "Próximos 12 meses",
 * "E fechar o mês?", "E a visão geral?"). Nunca casa meses soltos sem ano
 * ("E em maio?"), categorias, nem "e em 2026?" — esses seguem os fluxos atuais.
 */
const ELLIPTICAL_PROJECTION_IDIOMS_RE =
  /\b(?:categorias?|por\s+categoria|comparar|comparaca?o|comparad[oa]?|versus|vs|media|medias|anual|anualizad|proximos?\s+(?:12\s+)?meses?|12\s+meses|mes\s+atual|este\s+mes|esse\s+mes|fech(?:o|ar|amento|ando|a)|sem\s+filtro|visao\s+geral)\b/i;

/**
 * Reconhece um follow-up de projeção sem contexto nenhum (nem projeção, nem
 * análise) — o turno NUNCA pode ceder ao Gemini em interpretação. Exige modo
 * elíptico (prefixo de continuidade ou escopo "só/somente/apenas") + expressão
 * de projeção. Devolve o kind de clarificação: 'future_month' para horizontes
 * de meses futuros, 'ambiguous' caso contrário.
 */
function noContextProjectionFollowUp(norm: string): ProjectionClarificationKind | null {
  if (!CONTINUATION_RE.test(norm) && !/^(?:so\s+|somente\s+|apenas\s+)/.test(norm)) return null;
  if (!ELLIPTICAL_PROJECTION_IDIOMS_RE.test(norm)) return null;
  if (/(?:proximo\s+mes|mes\s+que\s+vem|mes\s+seguinte)\b/i.test(norm)) return 'future_month';
  return 'ambiguous';
}

// ── Entrada pública ────────────────────────────────────────────

/**
 * Tenta responder deterministicamente. Retorna null quando a pergunta não tem
 * intenção de alta confiança OU quando o fast-path falha (cai no Gemini atual).
 * Nunca lança para o chamador: erros de interpretação seguem o fluxo Gemini.
 */
export async function runDeterministicAsk(
  deps: DeterministicRouterDeps,
): Promise<DeterministicAnswer | null> {
  const raw = deps.question.trim();
  if (!raw || raw.length > MAX_QUESTION_LENGTH) return null;

  // PESSOAL-13C1.1: interpreta apenas a pergunta principal (rótulos copiados,
  // instruções após '?'/quebra/verbos NUNCA participam da intenção/categoria).
  let q = extractMainQuestion(raw);
  if (!q || q.length > MAX_QUESTION_LENGTH) return null;

  // PESSOAL-13C3B-E2: tendências e oportunidades têm precedência sobre o
  // contexto e sobre o isAdviceQuestion. A detecção ocorre na pergunta crua —
  // "E se eu reduzisse 10%?" nunca é reescrita como follow-up de categoria.
  const trendIntent = detectTrendIntent(normalizeText(q));
  if (trendIntent) {
    if (!supportsPaginableAsync(deps.supabase)) return null;
    try {
      if (trendIntent.intent === 'growth_categories') {
        return await buildGrowthCategories(
          deps.supabase,
          trendIntent.trendWindow ?? 'six_complete',
          deps.nowISO,
        );
      }
      return await buildSavingsOpportunities(
        deps.supabase,
        trendIntent.trendWindow ?? 'six_complete',
        trendIntent.percent ?? 10,
        trendIntent.percentInvalid ?? false,
        deps.nowISO,
      );
    } catch (err) {
      if (err instanceof AskError) throw err;
      throw toAskSupabaseError(err);
    }
  }

  // PESSOAL-13C4A-E2/E3: projeção determinística. Sinais fortes; detecção na
  // pergunta principal CRUA (antes do contexto — "e a projeção?" nunca vira
  // follow-up de categoria). Clarificação/explicação NUNCA consulta banco,
  // exceto a resolução da lente contextual do E3 (apenas categorias).
  const projToday = deps.nowISO ?? saoPauloTodayISO();
  const normQuestion = normalizeText(q);
  const projection = detectProjection(normQuestion, projToday);
  const projCtx = deps.context?.projection ?? null;
  if (projection) {
    const isElliptical = CONTINUATION_RE.test(normQuestion);

    // Clarificação com contexto de projeção válido → tratamento contextual
    // (E3); sem contexto → comportamento E2 intacto.
    if (projection.clarification) {
      if (projCtx) {
        if (projection.clarification === 'ambiguous' && PROJECTION_CLEAR_LENS_RE.test(normQuestion)) {
          return await buildProjectionFromContext(deps.supabase, projCtx, projToday, null, 'follow_up');
        }
        if (projection.clarification === 'ambiguous') {
          return await buildProjectionFromContext(deps.supabase, projCtx, projToday, ctxLens(projCtx), 'follow_up');
        }
        if (projection.clarification === 'category' && projection.lensTerm) {
          if (PROJECTION_UNCATEGORIZED_RE.test(normQuestion)) {
            return await buildProjectionFromContext(
              deps.supabase,
              projCtx,
              projToday,
              { kind: 'uncategorized', label: PROJECTION_UNCATEGORIZED_LABEL },
              'follow_up',
            );
          }
          if (!supportsPaginableAsync(deps.supabase)) return null;
          let lens: ProjectionRouteLens | null = null;
          try {
            lens = await resolveProjectionLens(deps.supabase, projection.lensTerm);
          } catch (err) {
            if (err instanceof AskError) throw err;
            throw toAskSupabaseError(err);
          }
          if (lens) {
            return await buildProjectionFromContext(deps.supabase, projCtx, projToday, lens, 'follow_up');
          }
          return projectionClarificationAnswer('unknown_lens', projToday);
        }
        if (projection.clarification === 'category') {
          return projectionClarificationAnswer('unknown_lens', projToday);
        }
        // year_close / future_month / reference_month permanecem clarificação.
      }
      return projectionClarificationAnswer(projection.clarification, projToday);
    }

    // Follow-up ELÍPTICO com intent explícito ("E a comparação?", "E o
    // fechamento?") → usa o contexto: preserva a lente e aplica as regras de
    // mês de referência do E3. Sem contexto → direto como no E2.
    if (isElliptical && projCtx) {
      const hasOwnMonth = firstMonthNumber(normQuestion) != null;
      let reference = projection.referenceMonth ?? yearMonthOfProjection(projToday);
      // "E o fechamento no mês passado?" com contexto de current_month → o
      // fechamento estimado só existe para o mês atual, então o passado/futuro
      // cai em esclarecimento (antecede a precedência do detectProjection).
      if (
        projCtx.intent === 'projection_current_month' &&
        /\bfech(?:o|ar|amento|ando|a)\b/.test(normQuestion)
      ) {
        const current = yearMonthOfProjection(projToday);
        const target = monthTargetOf(normQuestion, projToday) ?? projection.referenceMonth ?? null;
        if (target) {
          if (monthIsFuture(target, projToday)) {
            return projectionClarificationAnswer('future_month', projToday);
          }
          if (!sameMonth(target, current)) {
            return projectionClarificationAnswer('reference_month', projToday);
          }
        }
      }
      if (projection.intent === 'projection_current_month' && hasOwnMonth) {
        if (monthIsFuture(reference, projToday)) {
          return projectionClarificationAnswer('future_month', projToday);
        }
        if (!sameMonth(reference, yearMonthOfProjection(projToday))) {
          return projectionClarificationAnswer('reference_month', projToday);
        }
      }
      if (
        (projection.intent === 'projection_categories' ||
          projection.intent === 'projection_month_comparison') &&
        !hasOwnMonth
      ) {
        // Mês de família ("E o fechamento no mês passado?") derivado pelo
        // detector prevalece sobre o contexto; comparação/categorias sem mês
        // re-ancoram na referência do próprio contexto.
        const current = yearMonthOfProjection(projToday);
        reference =
          projection.referenceMonth != null && !sameMonth(projection.referenceMonth, current)
            ? projection.referenceMonth
            : projectCtxReference(projCtx, projToday);
      } else if (
        projection.intent === 'projection_base' ||
        projection.intent === 'projection_current_month'
      ) {
        reference = yearMonthOfProjection(projToday);
      }
      if (!supportsPaginableAsync(deps.supabase)) return null;
      try {
        return await buildProjectionAnswer(
          deps.supabase,
          projection.intent,
          reference,
          projToday,
          { lens: ctxLens(projCtx), route: 'follow_up' },
        );
      } catch (err) {
        throw withProjectionIntent(err, projection.intent);
      }
    }

    // Direto (pergunta explícita não elíptica) — E2 sem contexto envolvido.
    if (!supportsPaginableAsync(deps.supabase)) return null;
    try {
      return await buildProjectionAnswer(
        deps.supabase,
        projection.intent,
        projection.referenceMonth ?? yearMonthOfProjection(projToday),
        projToday,
        { route: 'direct' },
      );
    } catch (err) {
      throw withProjectionIntent(err, projection.intent);
    }
  }

  const screen =
    deps.period && isValidScreenPeriod(deps.period) ? deps.period : null;

  // PESSOAL-13C2: continuidade da conversa. Follow-ups ("E em maio?") herdam
  // a lente de categoria e o período do contexto. Sem contexto = comportamento
  // atual (o campo é opcional no deps).
  let question = q;
  let contextPeriodFallback = false;
  if (deps.context) {
    const applied = applyContextToQuestion(q, deps.context);
    question = applied.question;
    contextPeriodFallback = applied.contextPeriodFallback;
  }

  let resolved = resolveQueryPeriod(question, screen);
  if (
    contextPeriodFallback &&
    deps.context?.period &&
    (resolved.source === 'screen' || resolved.source === 'current')
  ) {
    resolved = resolvedFromContextPeriod(deps.context.period);
  }
  const intent = detectIntent(question, resolved);

  if (!intent) {
    // PESSOAL-13C4A-E3: follow-up de projeção ELÍPTICO compatível com o
    // contexto ("E só supermercado?", "E o mês passado?", "E as categorias?",
    // "E sem filtro?"). Corresponde ANTES do follow-up analítico e só quando o
    // turno anterior foi de projeção real (context.projection presente). Sem
    // prefixo de continuidade ou com sinais de valores financeiros → null.
    if (deps.context?.projection) {
      let projectionFollowUp: ProjectionFollowUp | null;
      try {
        projectionFollowUp = await resolveProjectionFollowUp(
          deps.supabase,
          normalizeText(q),
          deps.context.projection,
          projToday,
        );
      } catch (err) {
        throw withProjectionIntent(err, deps.context.projection.intent);
      }
      if (projectionFollowUp) {
        if (projectionFollowUp.kind === 'clarification') {
          return projectionClarificationAnswer(projectionFollowUp.clarification, projToday);
        }
        try {
          return await buildProjectionAnswer(
            deps.supabase,
            projectionFollowUp.intent,
            projectionFollowUp.referenceMonth,
            projToday,
            { lens: projectionFollowUp.lens, route: 'follow_up' },
          );
        } catch (err) {
          throw withProjectionIntent(err, projectionFollowUp.intent);
        }
      }
    }
    // PESSOAL-13C3B-E3: follow-up analítico elíptico compatível com o
    // contexto (percentual/categoria/janela). Dispara SOMENTE quando o turno
    // anterior foi analítico (context.analysis presente) e NENHUM intent
    // determinístico tradicional explícito casou acima.
    if (deps.context?.analysis) {
      const followUp = await resolveAnalysisFollowUp(q, deps.context.analysis, deps.supabase);
      if (followUp) {
        if (!supportsPaginableAsync(deps.supabase)) return null;
        try {
          if (followUp.ambiguousNames) {
            const w = buildTrendWindow(
              followUp.anchorDate ?? deps.nowISO ?? todayISO(),
              followUp.style,
            );
            const tool = followUp.intent === 'growth_categories' ? 'trend_growth' : 'trend_savings';
            const response = makeResponse(
              `Achei mais de uma categoria possível: ${followUp.ambiguousNames.join(' e ')}. Informe só o nome de UMA delas para eu analisar.`,
              resolvidoAPartirDaJanela(w),
              [tool],
              [{ label: 'Período analisado', value: windowDisplay(w) }],
            );
            response.cards = [];
            // Preserva a análise anterior: não sobrescreve com contexto incorreto.
            return { intent: followUp.intent, response, analysis: deps.context.analysis };
          }
          if (followUp.unknownCategory) {
            const w = buildTrendWindow(
              followUp.anchorDate ?? deps.nowISO ?? todayISO(),
              followUp.style,
            );
            const tool = followUp.intent === 'growth_categories' ? 'trend_growth' : 'trend_savings';
            const response = makeResponse(
              CATEGORY_CLARIFICATION,
              resolvidoAPartirDaJanela(w),
              [tool],
              [{ label: 'Período analisado', value: windowDisplay(w) }],
            );
            response.cards = [];
            // Preserva a análise anterior: não sobrescreve com contexto incorreto.
            return { intent: followUp.intent, response, analysis: deps.context.analysis };
          }
          if (followUp.intent === 'growth_categories') {
            return await buildGrowthCategories(
              deps.supabase,
              followUp.style,
              deps.nowISO,
              { categoryPath: followUp.categoryPath },
              followUp.anchorDate,
            );
          }
          return await buildSavingsOpportunities(
            deps.supabase,
            followUp.style,
            followUp.percent ?? 10,
            followUp.percentInvalid ?? false,
            deps.nowISO,
            { categoryPath: followUp.categoryPath },
            followUp.anchorDate,
          );
        } catch (err) {
          if (err instanceof AskError) throw err;
          throw toAskSupabaseError(err);
        }
      }
    }
    // PESSOAL-13C4A-E3.1: follow-up de projeção SEM contexto nenhum (nem
    // projeção, nem análise). Responde com sinalização/esclarecimento sem custo
    // (nunca consulta dados financeiros, nunca cai no Gemini). Deve estar na
    // ÚLTIMA posição: só captura o que nenhum intent/turno anterior resolveu.
    const noCtxKind =
      deps.context?.projection == null &&
      deps.context?.analysis == null &&
      noContextProjectionFollowUp(normQuestion);
    if (noCtxKind) {
      return projectionClarificationAnswer(noCtxKind, projToday);
    }
    return null;
  }

  // Capabilidade: paginação (`range`) é pré-requisito do fast-path. Sem ela,
  // devolve null e o endpoint mantém o fluxo Gemini (degradação segura).
  if (!supportsPaginableAsync(deps.supabase)) return null;

  try {
    if (intent.intent === 'month_most_spent' && intent.category) {
      return await buildMonthMost(deps.supabase, resolved, intent.category);
    }
    if (intent.intent === 'category_total' && intent.category) {
      return await buildCategoryTotal(deps.supabase, resolved, intent.category);
    }
    if (intent.intent === 'monthly_comparison') {
      return await buildMonthlyComparison(deps.supabase, question);
    }
    if (
      intent.intent === 'total_expenses' ||
      intent.intent === 'total_income' ||
      intent.intent === 'period_balance' ||
      intent.intent === 'expense_count'
    ) {
      return await buildPeriodSummary(deps.supabase, resolved, intent.intent);
    }
    return null;
  } catch (err) {
    if (err instanceof AskError) throw err;
    throw toAskSupabaseError(err);
  }
}