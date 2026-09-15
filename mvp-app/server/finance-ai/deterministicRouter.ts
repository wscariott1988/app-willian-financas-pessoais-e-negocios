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
import type { AskResponse, EvidenceItem } from './types.js';
import {
  summaryByPeriod,
  expenseMonthlyAggregate,
  matchesCategoryTerm,
  normalizeCategoryTerm,
  MONTH_FULL,
} from '../../src/lib/analyticsInsights.js';
import type { AnalyticsTxRow } from '../../src/lib/analytics.js';
import { formatShortDate } from '../../src/lib/period.js';
import { MAX_QUESTION_LENGTH } from './orchestrator.js';
import { AskError, isSupabaseQueryError, providerStatusOf } from './observability.js';

export type DeterministicIntent =
  | 'total_expenses'
  | 'total_income'
  | 'period_balance'
  | 'expense_count'
  | 'category_total'
  | 'month_most_spent'
  | 'monthly_comparison';

export interface DeterministicIntentResult {
  intent: DeterministicIntent;
  category?: string;
}

export interface DeterministicAnswer {
  intent: DeterministicIntent;
  response: AskResponse;
}

export interface DeterministicRouterDeps {
  supabase: SupabaseClient;
  question: string;
  period?: { start: string; end: string };
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

export type DetectedPeriodSource = 'month' | 'year' | 'screen' | 'current';

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

function periodPhraseOf(p: ResolvedQueryPeriod): string {
  if (p.source === 'month') return `em ${p.monthLower ?? ''}`.trim();
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
  'transaction_kind, amount, occurred_on, categories(display_name, canonical_path)';
const DETERMINISTIC_PAGE_SIZE = 1000;

interface LeanTx {
  transaction_kind?: string | null;
  amount?: number | string | null;
  occurred_on?: string | null;
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
    category_id: null,
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

interface ResolvedCategory {
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

function depthOfPath(path: string | null): number {
  return path ? path.split('>').length : 1;
}

/**
 * Resolve a categoria extraída para a classificação CANÔNICA do usuário
 * (display_name/canonical_path da tabela categories). Nunca devolve a string
 * bruta da pergunta. Entre múltiplas correspondências hierárquicas prefere o nó
 * ancestral (menor profundidade) e, para segmento casado, devolve o path BASE do
 * nó (prefixo até o segmento). Retorna null quando a categoria não é reconhecida.
 */
function resolveCategory(labels: CategoryLabel[], term: string): ResolvedCategory | null {
  const target = normalizeCategoryTerm(term);
  if (!target) return null;
  const exact: ResolvedCategory[] = [];
  const hierarchic: ResolvedCategory[] = [];
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
      const idx = normSegs.indexOf(target);
      if (idx >= 0) {
        hierarchic.push({
          label: l,
          matchTerm: rawSegs.slice(0, idx + 1).join(' > '),
        });
        continue;
      }
      if (target.length >= 3 && cp.includes(target)) {
        const normIdx = normSegs.findIndex((s) => s.includes(target));
        if (normIdx >= 0) {
          hierarchic.push({
            label: l,
            matchTerm: rawSegs.slice(0, normIdx + 1).join(' > '),
          });
        }
      }
    }
  }
  if (exact.length > 0) {
    exact.sort((a, b) => depthOfPath(a.label.canonical_path) - depthOfPath(b.label.canonical_path));
    return exact[0];
  }
  if (hierarchic.length > 0) {
    hierarchic.sort((a, b) => depthOfPath(a.label.canonical_path) - depthOfPath(b.label.canonical_path));
    return hierarchic[0];
  }
  return null;
}

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
  };
}

async function buildMonthMost(
  supabase: SupabaseClient,
  resolved: ResolvedQueryPeriod,
  category: string,
): Promise<DeterministicAnswer> {
  const cats = await fetchExpenseCategories(supabase);
  const resolvedCat = resolveCategory(cats, category);
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
  const q = extractMainQuestion(raw);
  if (!q || q.length > MAX_QUESTION_LENGTH) return null;

  const screen =
    deps.period && isValidScreenPeriod(deps.period) ? deps.period : null;
  const resolved = resolveQueryPeriod(q, screen);
  const intent = detectIntent(q, resolved);
  if (!intent) return null;

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
      return await buildMonthlyComparison(deps.supabase, q);
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