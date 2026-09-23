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
//     altera os totais — apenas a LINGUAGEM exibida por categoria. A BASE de
//     comparação é SEMPRE a média mensal completa (monthly_mean), no mês atual
//     e no passado (PESSOAL-13C4A-E3.7): o mês atual é comparado pelo MÊS
//     INTEIRO, nunca por fração proporcional do dia — um lançamento agendado
//     para o fim do mês participa do realizado do mês.
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
//   shareBps               = round(categoryBaseCents * 10000 / totalBaseCents)
//     (0 quando totalBaseCents = 0, para nunca dividir por zero).
//
// A referência da comparação (geral e por categoria) é a MÉDIA MENSAL da base
// (12 meses-calendário anteriores), tanto para o mês atual quanto para o mês
// passado — jamais uma fração proporcional até o dia de hoje. No mês atual, o
// realizado é o MÊS CALENDÁRIO INTEIRO: transações com occurredOn dentro do mês
// de referência entram, mesmo ocorridas depois de todayISO. PESSOAL-13C4A-E3.7.

import { addMonths, daysInMonth, toLocalISODate } from './period.js';
import { classifySavingsCategory } from './analyticsTrends.js';

// ============ Constantes da política ============

export const PROJECTION_WINDOW_MONTHS = 12;
export const REQUIRED_FULL_COVERAGE_MONTHS = 12;
export const MINIMUM_COVERAGE_MONTHS = 6;
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
  /** Realizado no MÊS corrente completo (ocorrido em qualquer dia do mês, inclusive após todayISO). */
  realizedCents: number;
  /** Média mensal da base (12 meses-calendário anteriores). */
  referenceCents: number;
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
 * totais, apenas a LINGUAGEM exibida por categoria.
 */
export type ProjectionCategoryMode =
  | 'variable_pace' // gastos variáveis/sem contrato
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
   * Base de comparação DA CATEGORIA (PESSOAL-13C4A-E3.7): SEMPRE
   * 'monthly_mean' (média mensal completa da base), no mês atual e no passado.
   * O valor 'expected_to_date' fica reservado apenas para LEITURA de payloads
   * legados (pré-E3.7) na fronteira de persistência.
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
  /**
   * Projeção dos PRÓXIMOS 12 MESES a partir do MÊS ATUAL de todayISO
   * (PESSOAL-13C4A-E6). Calculada para QUALQUER success; o mapeador decide em
   * quais intents ela é exposta no payload (somente projection_base com
   * referência do mês atual).
   */
  forecast: ProjectionForecast;
}

// ============ Projeção dos próximos 12 meses (PESSOAL-13C4A-E6) ============

/**
 * Um mês do horizonte da projeção de 12 meses (PESSOAL-13C4A-E6).
 * Unidade: centavos inteiros. Relação canônica por mês:
 *   projectedCents = registeredCents + estimatedRemainingCents
 * onde `registeredCents` vem das despesas ELEGÍVEIS já registradas no mês do
 * horizonte e `estimatedRemainingCents` é a soma, por categoria, de
 * max(média mensal da base − registrado no mês, 0). `historicalReferenceCents`
 * é a soma das médias mensais da base das categorias daquele mês — a referência
 * histórica, sem somar estimativas.
 */
export interface ProjectionForecastMonth {
  month: string; // 'YYYY-MM'
  registeredCents: number;
  estimatedRemainingCents: number;
  projectedCents: number;
  historicalReferenceCents: number;
}

export interface ProjectionForecastSummary {
  historicalReferenceCents: number;
  registeredCents: number;
  estimatedRemainingCents: number;
  projectedCents: number;
}

/**
 * Horizonte fixo de exatamente 12 meses consecutivos:
 * addMonths(currentMonth, 1) até addMonths(currentMonth, 12). O summary é a
 * soma BYTE-EXATA dos 12 meses (sem novo arredondamento), logo
 * projected = registered + estimated também nos totais.
 */
export interface ProjectionForecast {
  horizonStart: string; // 'YYYY-MM'
  horizonEnd: string; // 'YYYY-MM'
  summary: ProjectionForecastSummary;
  months: ProjectionForecastMonth[];
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

/**
 * Agrega o realizado do mês de referência INTEIRO (inclusive transações
 * ocorridas depois de todayISO, mas dentro do mês — PESSOAL-13C4A-E3.7), por
 * total e por categoria. Mês passado nunca usa dados posteriores ao próprio
 * mês (o intervalo já é o mês calendário; nada é limitado por today).
 */
function referenceMonthTotals(
  input: ProjectionEngineInput,
  reference: YearMonth,
  periods: ReadonlyArray<NormalizedPeriod>,
): {
  realizedCents: number;
  realizedCategories: Map<string, CategoryBucket>;
} {
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
      null,
      periods,
      realizedCategories,
      lens,
    );
  }

  return { realizedCents, realizedCategories };
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
  realizedCategories: Map<string, CategoryBucket>,
): { categories: ProjectionCategory[]; remainingCategories: RemainingProjectionCategories } {
  const rows: Array<{ bucket: CategoryBucket; row: ProjectionCategory }> = [];
  for (const bucket of base.categories.values()) {
    const mean = Math.round(bucket.cents / coveredMonths);
    const actual = realizedCategories.get(categoryKey(bucket.categoryId))?.cents ?? 0;
    // PESSOAL-13C4A-E3.7: TODAS as categorias (mês atual e passado, qualquer
    // modo) usam a MÉDIA MENSAL completa como referência; o modo apenas define
    // a linguagem do card. Nunca há referência proporcional por dia.
    const mode = projectionCategoryMode(bucket.label);
    rows.push({
      bucket,
      row: {
        label: bucket.label,
        monthlyMeanCents: mean,
        annualScenarioCents: mean * 12,
        shareBps: shareBps(bucket.cents, base.totalBaseCents),
        actualCents: actual,
        referenceBasis: 'monthly_mean',
        mode,
        referenceCents: mean,
        deviationCents: actual - mean,
        deviation: deviationLabel(actual - mean),
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

// ============ Projeção dos próximos 12 meses (PESSOAL-13C4A-E6) ============

const FORECAST_HORIZON_MONTHS = 12;

/**
 * Constrói a projeção mês a mês dos próximos 12 meses — do mês SEGUINTE ao mês
 * atual de todayISO (addMonths(currentMonth, 1)..addMonths(currentMonth, 12)) —
 * a partir da agregação da base. Cada mês do horizonte agrega somente as
 * despesas ELEGÍVEIS daquele mês-calendário (vivas, kind expense, data válida,
 * período da própria conta cobrindo o dia e lente quando ativa). Por categoria:
 * média mensal = round(bucket.cents / coveredMonths); estimativa do mês =
 * max(média − registrado no mês, 0). Nada é arredondado além da média: as somas
 * do summary saem byte-exatas dos 12 meses.
 */
function buildForecast(
  input: ProjectionEngineInput,
  currentMonth: YearMonth,
  base: BaseAggregation,
  periods: ReadonlyArray<NormalizedPeriod>,
): ProjectionForecast {
  const lens = input.lens ?? null;
  const horizon: YearMonth[] = [];
  for (let i = 1; i <= FORECAST_HORIZON_MONTHS; i++) {
    horizon.push(addMonths(currentMonth, i));
  }

  const meanByKey = new Map<string, number>();
  for (const bucket of base.categories.values()) {
    meanByKey.set(categoryKey(bucket.categoryId), Math.round(bucket.cents / base.coveredMonths));
  }

  const months: ProjectionForecastMonth[] = horizon.map((ym) => {
    const start = toLocalISODate(ym.year, ym.month, 1);
    const end = toLocalISODate(ym.year, ym.month, daysInMonth(ym.year, ym.month));
    const registered = new Map<string, CategoryBucket>();
    for (const t of input.transactions) {
      addReferencedExpense(t, start, end, null, periods, registered, lens);
    }
    const keys = new Set<string>([...meanByKey.keys(), ...registered.keys()]);
    let registeredCents = 0;
    let historicalReferenceCents = 0;
    let estimatedRemainingCents = 0;
    for (const key of keys) {
      const mean = meanByKey.get(key) ?? 0;
      const regCents = registered.get(key)?.cents ?? 0;
      registeredCents += regCents;
      historicalReferenceCents += mean;
      estimatedRemainingCents += Math.max(mean - regCents, 0);
    }
    return {
      month: monthKey(ym),
      registeredCents,
      estimatedRemainingCents,
      projectedCents: registeredCents + estimatedRemainingCents,
      historicalReferenceCents,
    };
  });

  let historicalReferenceCents = 0;
  let registeredCents = 0;
  let estimatedRemainingCents = 0;
  for (const m of months) {
    historicalReferenceCents += m.historicalReferenceCents;
    registeredCents += m.registeredCents;
    estimatedRemainingCents += m.estimatedRemainingCents;
  }

  return {
    horizonStart: monthKey(horizon[0] ?? currentMonth),
    horizonEnd: monthKey(horizon[horizon.length - 1] ?? currentMonth),
    summary: {
      historicalReferenceCents,
      registeredCents,
      estimatedRemainingCents,
      projectedCents: registeredCents + estimatedRemainingCents,
    },
    months,
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

  const { realizedCents, realizedCategories } = referenceMonthTotals(
    input,
    reference,
    periods,
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

  // PESSOAL-13C4A-E3.7: a comparação do mês atual usa a MESMA base do mês
  // passado — média mensal dos 12 meses-calendário anteriores × realizado do
  // MÊS INTEIRO. Sem ritmo, fechamento, futuros ou comprometido.
  const deviationCents = realizedCents - monthlyMeanCents;
  const comparison: ProjectionComparison =
    asCurrent
      ? {
          kind: 'current',
          referenceMonth: toYearMonth(reference),
          realizedCents,
          referenceCents: monthlyMeanCents,
          deviationCents,
          deviation: deviationLabel(deviationCents),
        }
      : {
          kind: 'past',
          referenceMonth: toYearMonth(reference),
          realizedCents,
          referenceCents: monthlyMeanCents,
          deviationCents,
          deviation: deviationLabel(deviationCents),
        };

  const { categories, remainingCategories } = buildCategories(
    base,
    base.coveredMonths,
    realizedCategories,
  );

  return {
    status: 'success',
    quality,
    basis,
    summary,
    comparison,
    categories,
    remainingCategories,
    forecast: buildForecast(input, currentMonth, base, periods),
  };
}