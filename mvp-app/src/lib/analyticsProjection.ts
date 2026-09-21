// analyticsProjection.ts — Motor puro de cobertura e projeção (PESSOAL-13C4A-E1).
//
// Lógica 100% determinística e testável; nenhum write; nenhum Supabase/Gemini;
// nenhum profile_id; nenhum comportamento específico do perfil Negócio. O
// relógio é SEMPRE injetado via todayISO (YYYY-MM-DD local, America/Sao_Paulo
// no adaptador futuro) — este módulo nunca usa `new Date()` para saber "hoje".
//
// Regras canônicas deste motor (fonte única, sem duplicar analytics/trends):
//   - a despesa é transaction_kind 'expense'; transferências NUNCA entram;
//     receitas NUNCA entram na projeção de despesas.
//   - soft-delete (deletedAt != null) exclui a transação.
//   - status NÃO filtra totais (mesmo contrato do resumo/analytics).
//   - categoria null cai no bucket "Sem categoria".
//   - compromissos fixos, dívidas, saúde e investimentos entram na projeção
//     (projeção NÃO é recomendação de economia).
//   - o MODO de card de cada categoria reusa a classificação conservadora
//     classifySavingsCategory (PESSOAL-13C4A-E3.3): compromissos fixos e
//     dívidas viram monthly_commitment; alocação patrimonial vira
//     investment_allocation; todo o resto vira variable_pace. O modo NÃO
//     altera os totais — apenas escolhe a base de comparação POR CATEGORIA:
//       variable_pace       mês atual → referência proporcional até hoje;
//       monthly_commitment  mês atual → média mensal completa (contas pagas
//                            em uma ou poucas datas não se distribuem por dia);
//       investment_allocation mês atual → média mensal de aportes;
//       mês passado         qualquer modo → média mensal completa.
//   - uma transação só participa quando o período da própria accountId cobre a
//     data de ocorrência (a validade nunca é "da conta mais antiga").
//
// Cobertura:
//   - quando existem períodos persistidos válidos, eles são usados;
//   - com NENHUM período válido, há fallback em memória por conta: início =
//     primeira transação ativa da conta, fim aberto;
//   - a cobertura mensal é do PERFIL: basta que, para cada dia do mês, exista
//     ao menos um período de alguma conta cobrindo aquele dia (não exige que
//     todas as contas cubram o mês);
//   - mês completamente coberto sem transação conta como ZERO;
//   - mês parcialmente coberto não entra; o mês atual não entra na base;
//   - lacunas entre períodos NUNCA são preenchidas.
//
// Janela: exatamente os 12 meses-calendário anteriores ao mês de referência.
// Nunca se busca o 13º mês. Qualidade: 12 cobertos = full; 6..11 =
// preliminary; 0..5 = insufficient.
//
// Cálculos (sempre centavos inteiros; Math.round determinístico):
//   monthlyMeanCents       = round(totalBaseCents / coveredMonths)
//   annualScenarioCents    = monthlyMeanCents * 12
//   expectedToDateCents    = round(monthlyMeanCents * elapsedDays / daysInMonth)
//   closingProjectionCents = round(realizedToDateCents * daysInMonth / elapsedDays)
//     — fechamento pelo ritmo SOMENTE a partir do 7º dia;
//   committedCents         = realizedToDateCents + futureRegisteredCents;
//   shareBps               = round(categoryBaseCents * 10000 / totalBaseCents)
//     (0 quando totalBaseCents = 0, para nunca dividir por zero).
//
// Lançamentos futuros (occurredOn > todayISO) NUNCA se misturam ao realizado.

import { addMonths, daysInMonth, toLocalISODate } from './period.js';
import { classifySavingsCategory } from './analyticsTrends.js';

// ============ Constantes da política ============

export const PROJECTION_WINDOW_MONTHS = 12;
export const REQUIRED_FULL_COVERAGE_MONTHS = 12;
export const MINIMUM_COVERAGE_MONTHS = 6;
export const PACE_CLOSING_START_DAY = 7;
export const TOP_CATEGORIES_LIMIT = 8;
export const UNCATEGORIZED_LABEL = 'Sem categoria';

const PAD2 = (v: number) => String(v).padStart(2, '0');

// ============ Tipos de entrada ============

export type TransactionKind = 'income' | 'expense' | 'transfer';
export type ProjectionDeviation = 'above' | 'below' | 'equal';
export type ProjectionQuality = 'full' | 'preliminary';

export interface YearMonth {
  year: number;
  month: number; // 1..12
}

export interface ProjectionTransaction {
  accountId: string;
  occurredOn: string; // YYYY-MM-DD local
  amountCents: number; // inteiro
  transactionKind: TransactionKind;
  categoryId: string | null;
  categoryLabel: string | null;
  deletedAt?: string | null;
  status?: string | null; // apenas dado; NUNCA é usado para filtrar
}

export interface ProjectionPeriod {
  accountId: string;
  startsOn: string; // YYYY-MM-DD local
  endsOn?: string | null; // null = aberto
}

/** Lente de categoria que restringe TODOS os agregados da projeção (PESSOAL-13C4A-E3). */
export type ProjectionLensInput =
  | { kind: 'category'; categoryPath: string }
  | { kind: 'uncategorized' };

/**
 * Casa uma transação com a lente ativa. Sem lente → todas as despesas entram.
 * Lente de categoria casa o rótulo canônico exato OU descendentes do segmento
 * ("Alimentação > Supermercado > X" pertence à lente "Alimentação > Supermercado").
 * Lente 'uncategorized' casa apenas despesas com categoryId nulo.
 */
function lensMatches(
  lens: ProjectionLensInput | null | undefined,
  categoryId: string | null,
  label: string,
): boolean {
  if (!lens) return true;
  if (lens.kind === 'uncategorized') return categoryId === null;
  return label === lens.categoryPath || label.startsWith(`${lens.categoryPath} > `);
}

export interface ProjectionEngineInput {
  todayISO: string; // obrigatório; controla todo o relógio
  referenceMonth?: YearMonth | null;
  transactions: ReadonlyArray<ProjectionTransaction>;
  periods: ReadonlyArray<ProjectionPeriod>;
  /** Lente de categoria opcional: restringe TODOS os agregados à categoria/segmento (PESSOAL-13C4A-E3). */
  lens?: ProjectionLensInput | null;
}

// ============ Basis (fatos da janela, sem projeção) ============

export interface ProjectionBasisMonth {
  key: string; // 'YYYY-MM'
  year: number;
  month: number; // 1..12
  start: string;
  end: string;
  covered: boolean;
  cents: number; // despesas realizadas daquele mês (zeros quando coberto sem gasto)
}

export interface ProjectionBasis {
  referenceMonth: YearMonth;
  currentMonth: YearMonth; // mês de todayISO
  windowStart: string;
  windowEnd: string;
  windowMonths: number; // sempre 12
  coveredMonths: number;
  totalBaseCents: number;
  months: ProjectionBasisMonth[]; // sempre os 12 meses da janela, em ordem
}

// ============ Resultado Success ============

export interface ProjectionSummary {
  monthlyMeanCents: number;
  annualScenarioCents: number;
  totalBaseCents: number;
  coveredMonths: number;
}

export interface ProjectionComparisonCurrent {
  kind: 'current';
  referenceMonth: YearMonth;
  realizedCents: number; // realizado até hoje (occurredOn <= todayISO)
  futureCents: number; // lançamentos futuros registrados (occurredOn > todayISO)
  committedCents: number; // realizado + futuros
  expectedToDateCents: number; // esperado linear até hoje
  closingProjectionCents: number | null; // a partir do 7º dia; null antes
  referenceCents: number; // a referência = esperado linear até hoje
  deviationCents: number; // realizado − referência
  deviation: ProjectionDeviation;
}

export interface ProjectionComparisonPast {
  kind: 'past';
  referenceMonth: YearMonth;
  realizedCents: number; // mês selecionado completo (nunca usa dados posteriores)
  referenceCents: number; // a referência = média mensal da base
  deviationCents: number; // realizado − referência
  deviation: ProjectionDeviation;
}

export type ProjectionComparison = ProjectionComparisonCurrent | ProjectionComparisonPast;

/**
 * MODO DE CARD de uma categoria de projeção (PESSOAL-13C4A-E3.3). Deriva da
 * classificação conservadora de economia (classifySavingsCategory), mas é
 * definido aqui como lista FECHADA própria do motor — o modo nunca altera
 * totais, apenas a base de comparação exibida por categoria.
 */
export type ProjectionCategoryMode =
  | 'variable_pace' // gastos variáveis/sem contrato: ritmo proporcional até hoje
  | 'monthly_commitment' // compromissos fixos e dívidas: média mensal completa
  | 'investment_allocation'; // aportes/investimentos: média mensal de aportes

/** Base de comparação POR CATEGORIA (independente da comparação geral). */
export type ProjectionCategoryBasis = 'expected_to_date' | 'monthly_mean';

/**
 * Modo de card de uma categoria a partir do rótulo canônico. Reaproveita
 * classifySavingsCategory (NUNCA duplica a lista de termos): fixed_contract e
 * debt_commitment → monthly_commitment; asset_allocation →
 * investment_allocation; todo o resto (variável, saúde sem contrato, etc.) →
 * variable_pace.
 */
export function projectionCategoryMode(label: string): ProjectionCategoryMode {
  const c = classifySavingsCategory(label);
  if (c === 'fixed_contract' || c === 'debt_commitment') return 'monthly_commitment';
  if (c === 'asset_allocation') return 'investment_allocation';
  return 'variable_pace';
}

export interface ProjectionCategory {
  label: string;
  monthlyMeanCents: number;
  annualScenarioCents: number;
  shareBps: number;
  actualCents: number;
  /**
   * Base de comparação DA CATEGORIA (PESSOAL-13C4A-E3.3): 'expected_to_date'
   * somente para rodadas variáveis do mês atual (referência proporcional);
   * 'monthly_mean' para mês passado e para compromissos fixos/investimentos no
   * mês atual (referência = média mensal completa).
   */
  referenceBasis: ProjectionCategoryBasis;
  /** Modo de card da categoria (lista fechada acima). */
  mode: ProjectionCategoryMode;
  referenceCents: number;
  deviationCents: number;
  deviation: ProjectionDeviation;
}

export interface RemainingProjectionCategories {
  remainingCategoriesCount: number;
  remainingMonthlyMeanCents: number;
  remainingAnnualScenarioCents: number;
  remainingShareBps: number;
}

export interface ProjectionSuccess {
  status: 'success';
  quality: ProjectionQuality; // 'full' | 'preliminary'
  basis: ProjectionBasis;
  summary: ProjectionSummary;
  comparison: ProjectionComparison;
  categories: ProjectionCategory[];
  remainingCategories: RemainingProjectionCategories;
}

// ============ Resultado Insufficient ============

export interface InsufficientReason {
  code: 'covered_months_below_minimum';
  coveredMonths: number;
  minimumCoveredMonths: number;
}

export interface ProjectionInsufficient {
  status: 'insufficient';
  quality: 'insufficient';
  basis: ProjectionBasis;
  realizedCents: number; // único valor de referência permitido: realizado observado
  reason: InsufficientReason;
}

export type ProjectionEngineResult = ProjectionSuccess | ProjectionInsufficient;

// ============ Helpers de data (locais, sem UTC implícito) ============

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidLocalDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function parseLocalISO(iso: string): YearMonth & { day: number } {
  if (!isValidLocalDate(iso)) {
    throw new RangeError(`todayISO inválido: "${iso}" (esperado YYYY-MM-DD local válido)`);
  }
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function monthKey(ym: YearMonth): string {
  return `${ym.year}-${PAD2(ym.month)}`;
}

function toYearMonth(ref: YearMonth): YearMonth {
  return { year: ref.year, month: ref.month };
}

function monthRank(ym: YearMonth): number {
  return ym.year * 12 + (ym.month - 1);
}

function resolveReferenceMonth(
  reference: YearMonth | null | undefined,
  currentMonth: YearMonth,
): YearMonth {
  const ym =
    reference == null
      ? toYearMonth(currentMonth)
      : (() => {
          if (!Number.isInteger(reference.year) || !Number.isInteger(reference.month)) {
            throw new RangeError(
              `referenceMonth inválido: year/month precisam ser inteiros (${JSON.stringify(reference)})`,
            );
          }
          if (reference.month < 1 || reference.month > 12) {
            throw new RangeError(
              `referenceMonth inválido: month fora de 1..12 (${reference.month})`,
            );
          }
          return toYearMonth(reference);
        })();
  if (monthRank(ym) > monthRank(currentMonth)) {
    throw new RangeError(
      `referenceMonth no futuro (${monthKey(ym)} > ${monthKey(currentMonth)}): não há realizado para projetar`,
    );
  }
  return ym;
}

// ============ Períodos ============

interface NormalizedPeriod {
  accountId: string;
  startsOn: string;
  endsOn: string | null; // null = aberto
}

function normalizePeriod(p: ProjectionPeriod): NormalizedPeriod | null {
  if (!isValidLocalDate(p.startsOn)) return null;
  if (p.endsOn == null || p.endsOn === '') {
    return { accountId: p.accountId, startsOn: p.startsOn, endsOn: null };
  }
  if (!isValidLocalDate(p.endsOn)) return null;
  if (p.endsOn < p.startsOn) return null;
  return { accountId: p.accountId, startsOn: p.startsOn, endsOn: p.endsOn };
}

function fallbackPeriods(transactions: ReadonlyArray<ProjectionTransaction>): NormalizedPeriod[] {
  const startByAccount = new Map<string, string>();
  for (const t of transactions) {
    if (t.deletedAt != null) continue;
    if (!isValidLocalDate(t.occurredOn)) continue;
    const current = startByAccount.get(t.accountId);
    if (current == null || t.occurredOn < current) {
      startByAccount.set(t.accountId, t.occurredOn);
    }
  }
  return [...startByAccount.entries()]
    .map(([accountId, startsOn]) => ({ accountId, startsOn, endsOn: null }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/** Períodos efetivos: persistidos válidos; fallback em memória só se NÃO houver nenhum. */
function resolvePeriods(input: ProjectionEngineInput): NormalizedPeriod[] {
  const persisted: NormalizedPeriod[] = [];
  for (const p of input.periods) {
    const n = normalizePeriod(p);
    if (n) persisted.push(n);
  }
  if (persisted.length > 0) return persisted;
  return fallbackPeriods(input.transactions);
}

function periodCoversDay(period: NormalizedPeriod, dayISO: string): boolean {
  if (dayISO < period.startsOn) return false;
  if (period.endsOn != null && dayISO > period.endsOn) return false;
  return true;
}

function anyPeriodCoversDay(periods: ReadonlyArray<NormalizedPeriod>, dayISO: string): boolean {
  return periods.some((p) => periodCoversDay(p, dayISO));
}

function accountPeriodCoversDay(
  accountId: string,
  periods: ReadonlyArray<NormalizedPeriod>,
  dayISO: string,
): boolean {
  return periods.some((p) => p.accountId === accountId && periodCoversDay(p, dayISO));
}

function expenseAmount(t: ProjectionTransaction): number {
  return Number.isFinite(t.amountCents) ? Math.round(t.amountCents) : 0;
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}

// ============ Janela ============

function buildWindow(reference: YearMonth): ProjectionBasisMonth[] {
  const months: ProjectionBasisMonth[] = [];
  for (let back = PROJECTION_WINDOW_MONTHS; back >= 1; back--) {
    const ym = addMonths(reference, -back);
    const last = daysInMonth(ym.year, ym.month);
    months.push({
      key: monthKey(ym),
      year: ym.year,
      month: ym.month,
      start: toLocalISODate(ym.year, ym.month, 1),
      end: toLocalISODate(ym.year, ym.month, last),
      covered: false,
      cents: 0,
    });
  }
  return months;
}

function isMonthFullyCovered(
  month: ProjectionBasisMonth,
  periods: ReadonlyArray<NormalizedPeriod>,
): boolean {
  const last = Number(month.end.slice(8, 10));
  for (let day = 1; day <= last; day++) {
    if (!anyPeriodCoversDay(periods, toLocalISODate(month.year, month.month, day))) {
      return false;
    }
  }
  return true;
}

// ============ Agregação da base ============

interface CategoryBucket {
  categoryId: string | null;
  label: string;
  cents: number;
}

interface BaseAggregation {
  coveredMonths: number;
  totalBaseCents: number;
  categories: Map<string, CategoryBucket>; // chave: categoryId ?? '__none__'
}

const NO_CATEGORY_KEY = '__none__';

function categoryKey(categoryId: string | null): string {
  return categoryId ?? NO_CATEGORY_KEY;
}

function bucketLabel(categoryId: string | null, categoryLabel: string | null): string {
  if (categoryLabel != null && categoryLabel.trim() !== '') return categoryLabel;
  return UNCATEGORIZED_LABEL;
}

/**
 * Conta uma despesa no intervalo [start, end] (opcionalmente limitada por
 * `upTo`) se ela for elegível (viva, kind expense, data válida e período da
 * própria conta cobrindo a data). Retorna o valor em centavos adicionado; 0
 * quando a transação não participa.
 */
function addReferencedExpense(
  t: ProjectionTransaction,
  start: string,
  end: string,
  upTo: string | null,
  periods: ReadonlyArray<NormalizedPeriod>,
  target: Map<string, CategoryBucket>,
  lens: ProjectionLensInput | null,
): number {
  if (t.deletedAt != null) return 0;
  if (t.transactionKind !== 'expense') return 0;
  if (!isValidLocalDate(t.occurredOn)) return 0;
  if (t.occurredOn < start || t.occurredOn > end) return 0;
  if (upTo != null && t.occurredOn > upTo) return 0;
  if (!accountPeriodCoversDay(t.accountId, periods, t.occurredOn)) return 0;
  const key = categoryKey(t.categoryId);
  const label = bucketLabel(t.categoryId, t.categoryLabel);
  if (!lensMatches(lens, t.categoryId, label)) return 0;
  const amount = expenseAmount(t);
  const cur = target.get(key) ?? {
    categoryId: t.categoryId,
    label,
    cents: 0,
  };
  cur.cents += amount;
  target.set(key, cur);
  return amount;
}

function aggregateBase(
  input: ProjectionEngineInput,
  window: ProjectionBasisMonth[],
  periods: ReadonlyArray<NormalizedPeriod>,
): BaseAggregation {
  const categories = new Map<string, CategoryBucket>();
  const lens = input.lens ?? null;
  for (const month of window) {
    month.covered = isMonthFullyCovered(month, periods);
    if (!month.covered) continue;
    for (const t of input.transactions) {
      month.cents += addReferencedExpense(t, month.start, month.end, null, periods, categories, lens);
    }
  }
  let totalBaseCents = 0;
  let coveredMonths = 0;
  for (const month of window) {
    if (!month.covered) continue;
    coveredMonths += 1;
    totalBaseCents += month.cents;
  }
  return { coveredMonths, totalBaseCents, categories };
}

// ============ Valores de referência (mês comparado) ============

function referenceMonthTotals(
  input: ProjectionEngineInput,
  reference: YearMonth,
  periods: ReadonlyArray<NormalizedPeriod>,
  asCurrent: boolean,
  todayISO: string,
): { realizedCents: number; futureCents: number; realizedCategories: Map<string, CategoryBucket> } {
  const start = toLocalISODate(reference.year, reference.month, 1);
  const last = daysInMonth(reference.year, reference.month);
  const end = toLocalISODate(reference.year, reference.month, last);
  const realizedCategories = new Map<string, CategoryBucket>();
  const lens = input.lens ?? null;

  let realizedCents = 0;
  for (const t of input.transactions) {
    realizedCents += addReferencedExpense(
      t,
      start,
      end,
      asCurrent ? todayISO : null,
      periods,
      realizedCategories,
      lens,
    );
  }

  let futureCents = 0;
  if (asCurrent) {
    for (const t of input.transactions) {
      if (t.deletedAt != null) continue;
      if (t.transactionKind !== 'expense') continue;
      if (!isValidLocalDate(t.occurredOn)) continue;
      if (t.occurredOn <= todayISO || t.occurredOn > end) continue;
      if (!accountPeriodCoversDay(t.accountId, periods, t.occurredOn)) continue;
      if (!lensMatches(lens, t.categoryId, bucketLabel(t.categoryId, t.categoryLabel))) continue;
      futureCents += expenseAmount(t);
    }
  }

  return { realizedCents, futureCents, realizedCategories };
}

// ============ Categorias ============

function deviationLabel(deltaCents: number): ProjectionDeviation {
  if (deltaCents > 0) return 'above';
  if (deltaCents < 0) return 'below';
  return 'equal';
}

function shareBps(partCents: number, totalCents: number): number {
  if (totalCents <= 0) return 0;
  return Math.round((partCents * 10000) / totalCents);
}

function buildCategories(
  base: BaseAggregation,
  coveredMonths: number,
  comparison: ProjectionComparison,
  realizedCategories: Map<string, CategoryBucket>,
  elapsedDays: number,
  currentMonth: YearMonth,
): { categories: ProjectionCategory[]; remainingCategories: RemainingProjectionCategories } {
  const isCurrent = comparison.kind === 'current';
  const currentDays = daysInMonth(currentMonth.year, currentMonth.month);

  const rows: Array<{ bucket: CategoryBucket; row: ProjectionCategory }> = [];
  for (const bucket of base.categories.values()) {
    const mean = Math.round(bucket.cents / coveredMonths);
    const actual = realizedCategories.get(categoryKey(bucket.categoryId))?.cents ?? 0;
    // PESSOAL-13C4A-E3.3: a base de comparação é POR CATEGORIA, derivada do
    // modo. Somente rodadas variáveis do mês atual usam a referência
    // proporcional até hoje; compromissos fixos, dívidas e investimentos usam
    // a média mensal completa; mês passado sempre usa a média mensal completa.
    const mode = projectionCategoryMode(bucket.label);
    const proportional = isCurrent && mode === 'variable_pace';
    const reference = proportional
      ? Math.round((mean * elapsedDays) / currentDays)
      : mean;
    rows.push({
      bucket,
      row: {
        label: bucket.label,
        monthlyMeanCents: mean,
        annualScenarioCents: mean * 12,
        shareBps: shareBps(bucket.cents, base.totalBaseCents),
        actualCents: actual,
        referenceBasis: proportional ? 'expected_to_date' : 'monthly_mean',
        mode,
        referenceCents: reference,
        deviationCents: actual - reference,
        deviation: deviationLabel(actual - reference),
      },
    });
  }

  rows.sort(
    (a, b) =>
      b.row.monthlyMeanCents - a.row.monthlyMeanCents ||
      a.row.label.localeCompare(b.row.label),
  );

  const kept = rows.slice(0, TOP_CATEGORIES_LIMIT).map((r) => r.row);
  const remaining = rows.slice(TOP_CATEGORIES_LIMIT);

  // As "restantes" NUNCA somam médias já arredondadas: partem do agregado.
  let remainingCents = 0;
  for (const r of remaining) {
    remainingCents += r.bucket.cents;
  }

  return {
    categories: kept,
    remainingCategories: {
      remainingCategoriesCount: remaining.length,
      remainingMonthlyMeanCents:
        remaining.length > 0 ? Math.round(remainingCents / coveredMonths) : 0,
      remainingAnnualScenarioCents:
        remaining.length > 0 ? Math.round(remainingCents / coveredMonths) * 12 : 0,
      remainingShareBps: shareBps(remainingCents, base.totalBaseCents),
    },
  };
}

// ============ Entrada principal ============

export function buildProjection(input: ProjectionEngineInput): ProjectionEngineResult {
  const today = parseLocalISO(input.todayISO);
  const currentMonth: YearMonth = { year: today.year, month: today.month };
  const reference = resolveReferenceMonth(input.referenceMonth, currentMonth);
  const asCurrent = sameMonth(reference, currentMonth);

  const periods = resolvePeriods(input);
  const window = buildWindow(reference);
  const base = aggregateBase(input, window, periods);

  const basis: ProjectionBasis = {
    referenceMonth: toYearMonth(reference),
    currentMonth,
    windowStart: window[0]?.start ?? '',
    windowEnd: window[window.length - 1]?.end ?? '',
    windowMonths: window.length,
    coveredMonths: base.coveredMonths,
    totalBaseCents: base.totalBaseCents,
    months: window,
  };

  const { realizedCents, futureCents, realizedCategories } = referenceMonthTotals(
    input,
    reference,
    periods,
    asCurrent,
    input.todayISO,
  );

  if (base.coveredMonths < MINIMUM_COVERAGE_MONTHS) {
    return {
      status: 'insufficient',
      quality: 'insufficient',
      basis,
      realizedCents,
      reason: {
        code: 'covered_months_below_minimum',
        coveredMonths: base.coveredMonths,
        minimumCoveredMonths: MINIMUM_COVERAGE_MONTHS,
      },
    };
  }

  const quality: ProjectionQuality =
    base.coveredMonths === REQUIRED_FULL_COVERAGE_MONTHS ? 'full' : 'preliminary';

  const monthlyMeanCents = Math.round(base.totalBaseCents / base.coveredMonths);

  const summary: ProjectionSummary = {
    monthlyMeanCents,
    annualScenarioCents: monthlyMeanCents * 12,
    totalBaseCents: base.totalBaseCents,
    coveredMonths: base.coveredMonths,
  };

  let comparison: ProjectionComparison;
  if (asCurrent) {
    const elapsedDays = today.day;
    const currentDays = daysInMonth(currentMonth.year, currentMonth.month);
    const expectedToDateCents = Math.round((monthlyMeanCents * elapsedDays) / currentDays);
    const closingProjectionCents =
      elapsedDays >= PACE_CLOSING_START_DAY
        ? Math.round((realizedCents * currentDays) / elapsedDays)
        : null;
    const committedCents = realizedCents + futureCents;
    const deviationCents = realizedCents - expectedToDateCents;
    comparison = {
      kind: 'current',
      referenceMonth: toYearMonth(reference),
      realizedCents,
      futureCents,
      committedCents,
      expectedToDateCents,
      closingProjectionCents,
      referenceCents: expectedToDateCents,
      deviationCents,
      deviation: deviationLabel(deviationCents),
    };
  } else {
    const deviationCents = realizedCents - monthlyMeanCents;
    comparison = {
      kind: 'past',
      referenceMonth: toYearMonth(reference),
      realizedCents,
      referenceCents: monthlyMeanCents,
      deviationCents,
      deviation: deviationLabel(deviationCents),
    };
  }

  const { categories, remainingCategories } = buildCategories(
    base,
    base.coveredMonths,
    comparison,
    realizedCategories,
    asCurrent ? today.day : 1,
    currentMonth,
  );

  return {
    status: 'success',
    quality,
    basis,
    summary,
    comparison,
    categories,
    remainingCategories,
  };
}