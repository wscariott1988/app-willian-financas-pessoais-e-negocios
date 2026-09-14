// analyticsInsights.ts — Blocos determinísticos das Análises (PESSOAL-12).
// Lógica pura e testável; nenhum write, nenhum acesso ao Supabase.
// Regras financeiras canônicas concentradas AQUI para reuso pela UI e pelas
// futuras ferramentas do Gemini (uma única fonte de regra, nunca duplicada):
//   1. Receitas/despesas por transaction_kind; transferências NUNCA contam como
//      receita nem despesa (ficam de fora dos totais e de todos os rankings).
//   2. Resultado = receitas − despesas (nunca "saldo da conta bancária").
//   3. Categorias usam SOMENTE o category_id vinculado/canonical_path do banco
//      (nunca inferência por descrição).
//   4. Pago = posted; Não pago = demais status ativos do CHECK do schema.
//      Status só é operacional a partir do cutoff (lib/status) — mesma regra
//      do restante do app; legados nunca são normalizados.
//   5. Séries/parcelamentos usam SOMENTE as ocorrências materializadas
//      (transaction_series_occurrences.amount); jamais amount_total contado às
//      cegas nem "/99" ou total artificial. Identidade estrutural (via
//      transaction_series), nunca por descrição.

import {
  summarizePeriod,
  breakdownByCategory,
  categoryLabel,
  type AnalyticsTxRow,
  type CategoryBreakdownRow,
} from './analytics';
import { isStatusOperationalVisible, isPaidStatus } from './status';

function number(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const pad2 = (v: number) => String(v).padStart(2, '0');

// ============ Resumo do período ============

export interface PeriodSummaryInsight {
  income: number;
  expense: number;
  balance: number;
  totalCount: number;
  /** despesas / receitas (0..1); null quando não há receitas (divisão inválida). */
  expenseShare: number | null;
}

/** Resumo do período (mesma regra financeira do Dashboard/summary.ts). */
export function summaryByPeriod(rows: AnalyticsTxRow[]): PeriodSummaryInsight {
  const t = summarizePeriod(rows);
  return {
    income: t.income,
    expense: t.expense,
    balance: t.balance,
    totalCount: t.totalCount,
    expenseShare: t.income > 0 ? t.expense / t.income : null,
  };
}

// ============ Gastos por categoria ============

/**
 * Ranking de despesas por categoria (Top N quando limit > 0). A participação é
 * calculada sobre o total de DESPESAS do período. Receitas/transferências nunca
 * entram. Categoria sempre vem do category_id (nunca por descrição).
 */
export function expensesByCategory(
  rows: AnalyticsTxRow[],
  limit?: number,
): CategoryBreakdownRow[] {
  const total = summarizePeriod(rows).expense;
  const ranked = breakdownByCategory(rows, 'expense', total);
  return limit && limit > 0 ? ranked.slice(0, limit) : ranked;
}

// ============ Evolução mensal ============

export const EVOLUTION_MONTHS = 6;

export const MONTH_SHORT: ReadonlyArray<string> = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez',
];

export interface EvolutionMonth {
  year: number;
  month: number; // 1..12
}

export interface MonthlyPoint {
  key: string; // 'YYYY-MM'
  label: string; // 'abr'
  income: number;
  expense: number;
  balance: number;
}

/**
 * Janela de evolução: os últimos `count` meses terminando no mês selecionado,
 * sempre com mês CHEIO (sem corte do dia), para comparar meses comparáveis.
 * Devolve o range [start, end] do primeiro ao último dia da janela.
 */
export function buildEvolutionWindow(
  sel: EvolutionMonth,
  count: number = EVOLUTION_MONTHS,
): { months: EvolutionMonth[]; start: string; end: string } {
  const n = Math.max(1, Math.min(count, 24));
  const months: EvolutionMonth[] = [];
  for (let i = 0; i < n; i++) {
    const total = sel.year * 12 + (sel.month - 1) - (n - 1 - i);
    const year = Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12 + 1;
    months.push({ year, month });
  }
  const first = months[0];
  const last = months[months.length - 1];
  const lastDay = new Date(last.year, last.month, 0).getDate();
  return {
    months,
    start: `${first.year}-${pad2(first.month)}-01`,
    end: `${last.year}-${pad2(last.month)}-${pad2(lastDay)}`,
  };
}

function monthKey(m: EvolutionMonth): string {
  return `${m.year}-${pad2(m.month)}`;
}

/**
 * Agrupa receitas/despesas por mês (transferências fora), zerando os meses da
 * janela sem movimento. Linhas fora da janela são ignoradas.
 */
export function monthlyEvolution(
  rows: AnalyticsTxRow[],
  months: ReadonlyArray<EvolutionMonth>,
): MonthlyPoint[] {
  const points = new Map<string, MonthlyPoint>();
  for (const m of months) {
    points.set(monthKey(m), {
      key: monthKey(m),
      label: MONTH_SHORT[m.month - 1] ?? '',
      income: 0,
      expense: 0,
      balance: 0,
    });
  }
  for (const r of rows) {
    const date = r.occurred_on ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const p = points.get(date.slice(0, 7));
    if (!p) continue;
    const amount = number(r.amount);
    if (r.transaction_kind === 'income') p.income += amount;
    else if (r.transaction_kind === 'expense') p.expense += amount;
  }
  return [...points.values()].map((p) => ({ ...p, balance: p.income - p.expense }));
}

// ============ Pago x previsto ============

export interface PaidVsForecast {
  /** Receitas+despesas do período com status visível e posted. */
  paid: number;
  /** Receitas+despesas do período com status visível e não-posted. */
  unpaid: number;
  /** Receitas+despesas TOTAIS do período (inclui fora da janela de status). */
  total: number;
  /** Porção de `total` fora da janela operacional de status (>= 0). */
  outsideStatusWindow: number;
}

/**
 * Pago x previsto no período selecionado. Regra do app (lib/status): posted =
 * Pago; pending/review/scheduled/ignored = Não pago; status só é operacional a
 * partir do cutoff — antes disso a transação entra no total geral, mas não é
 * classificada como Pago/Não pago (legados preservados, sem normalização).
 * Transferências são sempre excluídas.
 */
export function paidVsForecast(rows: AnalyticsTxRow[]): PaidVsForecast {
  let paid = 0;
  let unpaid = 0;
  let total = 0;
  for (const r of rows) {
    if (r.transaction_kind !== 'income' && r.transaction_kind !== 'expense') continue;
    const amount = number(r.amount);
    total += amount;
    if (!isStatusOperationalVisible(r.occurred_on ?? '')) continue;
    if (isPaidStatus(r.status)) paid += amount;
    else unpaid += amount;
  }
  return { paid, unpaid, total, outsideStatusWindow: total - paid - unpaid };
}

// ============ Maiores despesas ============

export interface TopExpenseRow {
  description: string;
  category: string;
  amount: number;
  occurred_on: string;
}

/** Maiores despesas do período (Top `limit`, default 5). Transferências fora. */
export function topExpenses(rows: AnalyticsTxRow[], limit: number = 5): TopExpenseRow[] {
  return rows
    .filter((r) => r.transaction_kind === 'expense')
    .map((r) => ({
      description: r.raw_description ?? '',
      category: categoryLabel(r),
      amount: number(r.amount),
      occurred_on: r.occurred_on ?? '',
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, Math.max(1, limit));
}

// ============ Séries / parcelamentos ============

/**
 * Linha de ocorrência de série NORMALIZADA a partir do embed do PostgREST
 * (transaction_series_occurrences + transaction_series + transactions).
 */
export interface SeriesOccurrenceRow {
  series_id: string | null;
  state: string | null;
  kind: string | null;
  frequency: string | null;
  direction: string | null;
  display_name: string | null;
  amount_total: number | string | null;
  total_occurrences: number | null;
  starts_on: string | null;
  occurrence_index: number;
  occurred_on: string;
  amount: number | string;
  tx_status: string | null;
  tx_deleted_at: string | null;
}

interface RawEmbed {
  id?: string | null;
  kind?: string | null;
  frequency?: string | null;
  display_name?: string | null;
  amount_total?: number | string | null;
  total_occurrences?: number | null;
  starts_on?: string | null;
  direction?: string | null;
  state?: string | null;
}

interface RawSeriesOccurrence {
  occurrence_index?: number | null;
  occurred_on?: string | null;
  amount?: number | string | null;
  transaction_series?: RawEmbed | RawEmbed[] | null;
  transactions?:
    | { status?: string | null; deleted_at?: string | null }
    | Array<{ status?: string | null; deleted_at?: string | null }>
    | null;
}

function firstOf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  if (v == null) return null;
  return v;
}

/** Normaliza o resultado bruto do Supabase para a estrutura pura usada abaixo. */
export function toSeriesOccurrenceRows(raw: unknown[]): SeriesOccurrenceRow[] {
  const out: SeriesOccurrenceRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as RawSeriesOccurrence;
    const ser = firstOf<RawEmbed>(o.transaction_series);
    const tx = firstOf<{ status?: string | null; deleted_at?: string | null }>(o.transactions);
    if (typeof o.occurrence_index !== 'number' || typeof o.occurred_on !== 'string') continue;
    out.push({
      series_id: ser?.id ?? null,
      state: ser?.state ?? null,
      kind: ser?.kind ?? null,
      frequency: ser?.frequency ?? null,
      direction: ser?.direction ?? null,
      display_name: ser?.display_name ?? null,
      amount_total: ser?.amount_total ?? null,
      total_occurrences: ser?.total_occurrences ?? null,
      starts_on: ser?.starts_on ?? null,
      occurrence_index: o.occurrence_index,
      occurred_on: o.occurred_on,
      amount: o.amount ?? 0,
      tx_status: tx?.status ?? null,
      tx_deleted_at: tx?.deleted_at ?? null,
    });
  }
  return out;
}

function isAlive(o: SeriesOccurrenceRow): boolean {
  return o.tx_deleted_at == null;
}

/** Ocorrência ainda comprometida: não excluída E (futura OU paga com status não-posted visível). */
export function isOutstanding(o: SeriesOccurrenceRow, todayISO: string): boolean {
  if (!isAlive(o)) return false;
  if (o.occurred_on > todayISO) return true;
  if (!isStatusOperationalVisible(o.occurred_on)) return false;
  return !isPaidStatus(o.tx_status);
}

export interface SeriesCommitment {
  seriesId: string;
  displayName: string;
  remaining: number;
  nextDate: string | null;
  amount: number;
}

export interface InstallmentInsight {
  count: number;
  /** Valor futuro comprometido com parcelas (soma das ocorrências NÃO pagas). */
  committed: number;
  items: SeriesCommitment[];
  /** Parcelamentos com até 2 parcelas restantes (próximos de terminar). */
  finishingSoon: SeriesCommitment[];
}

/**
 * Parcelamentos ativos e valor futuro comprometido. Valores SEMPRE das
 * ocorrências materializadas (nunca amount_total × restantes; nunca "/99").
 */
export function installmentSummary(rows: SeriesOccurrenceRow[], todayISO: string): InstallmentInsight {
  const bySeries = new Map<string, SeriesOccurrenceRow[]>();
  for (const o of rows) {
    if (o.kind !== 'installment' || !isAlive(o) || !o.series_id) continue;
    const arr = bySeries.get(o.series_id) ?? [];
    arr.push(o);
    bySeries.set(o.series_id, arr);
  }
  const items: SeriesCommitment[] = [];
  let committed = 0;
  for (const [seriesId, occs] of bySeries) {
    const outstanding = occs.filter((o) => isOutstanding(o, todayISO));
    if (outstanding.length === 0) continue;
    const displayName = occs[0]?.display_name || 'Parcelamento';
    const nextDate = outstanding.map((o) => o.occurred_on).sort()[0] ?? null;
    const amount = outstanding.reduce((acc, o) => acc + number(o.amount), 0);
    committed += amount;
    items.push({ seriesId, displayName, remaining: outstanding.length, nextDate, amount });
  }
  items.sort((a, b) => (a.nextDate ?? '9999-99-99').localeCompare(b.nextDate ?? '9999-99-99'));
  const finishingSoon = items.filter((i) => i.remaining <= 2).slice(0, 5);
  return { count: items.length, committed, items, finishingSoon };
}

export interface RecurringCommitment {
  seriesId: string;
  displayName: string;
  frequencyLabel: string | null;
  nextDate: string | null;
  amount: number;
}

export interface RecurringInsight {
  count: number;
  items: RecurringCommitment[];
}

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Semanal',
  monthly: 'Mensal',
  yearly: 'Anual',
};

/**
 * Recorrências ativas = série recorrente não encerrada (state != stopped) com
 * recorrência aberta (state active) OU com alguma ocorrência futura viva.
 */
export function recurringSummary(rows: SeriesOccurrenceRow[], todayISO: string): RecurringInsight {
  const bySeries = new Map<string, SeriesOccurrenceRow[]>();
  for (const o of rows) {
    if (o.kind !== 'recurring' || !isAlive(o) || !o.series_id) continue;
    const arr = bySeries.get(o.series_id) ?? [];
    arr.push(o);
    bySeries.set(o.series_id, arr);
  }
  const items: RecurringCommitment[] = [];
  for (const [seriesId, occs] of bySeries) {
    const first = occs[0];
    if (first.state === 'stopped') continue;
    const future = occs.filter((o) => o.occurred_on >= todayISO).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    const ongoing = first.state === 'active' || future.length > 0;
    if (!ongoing) continue;
    const next = future[0] ?? null;
    items.push({
      seriesId,
      displayName: first.display_name || 'Recorrência',
      frequencyLabel: FREQUENCY_LABELS[first.frequency ?? ''] ?? null,
      nextDate: next?.occurred_on ?? null,
      amount: next ? number(next.amount) : 0,
    });
  }
  items.sort((a, b) => {
    if (a.nextDate === null && b.nextDate === null) return 0;
    if (a.nextDate === null) return 1;
    if (b.nextDate === null) return -1;
    return a.nextDate.localeCompare(b.nextDate);
  });
  return { count: items.length, items };
}

export interface UpcomingCommitment {
  key: string;
  occurredOn: string;
  amount: number;
  displayName: string;
  kindLabel: string;
}

/** Próximos compromissos (parcelas + recorrentes futuras), ordenados por data. */
export function upcomingCommitments(rows: SeriesOccurrenceRow[], todayISO: string, limit: number = 3): UpcomingCommitment[] {
  const future = rows
    .filter((o) => (o.kind === 'installment' || o.kind === 'recurring') && isAlive(o) && o.occurred_on >= todayISO)
    .sort(
      (a, b) =>
        a.occurred_on.localeCompare(b.occurred_on) ||
        (a.display_name ?? '').localeCompare(b.display_name ?? ''),
    );
  return future.slice(0, Math.max(1, limit)).map((o) => ({
    key: `${o.occurred_on}-${o.series_id}-${o.occurrence_index}`,
    occurredOn: o.occurred_on,
    amount: number(o.amount),
    displayName: o.display_name || 'Compromisso',
    kindLabel: o.kind === 'installment' ? 'Parcela' : 'Recorrente',
  }));
}

// ============ Payload único (fonte da UI e do Gemini) ============

export interface AnalyticsInsights {
  summary: PeriodSummaryInsight;
  expensesByCategory: CategoryBreakdownRow[];
  monthlyEvolution: MonthlyPoint[];
  paidVsForecast: PaidVsForecast;
  installment: InstallmentInsight;
  recurring: RecurringInsight;
  upcoming: UpcomingCommitment[];
  topExpenses: TopExpenseRow[];
}

export interface BuildInsightsInput {
  periodRows: AnalyticsTxRow[];
  evolutionRows: AnalyticsTxRow[];
  seriesOccurrences: SeriesOccurrenceRow[];
  months: ReadonlyArray<EvolutionMonth>;
  todayISO: string;
}

/**
 * Pipeline completo dos blocos determinísticos. Com as mesmas entradas a UI e as
 * futuras ferramentas do Gemini produzem EXATAMENTE os mesmos números.
 */
export function buildInsights(input: BuildInsightsInput): AnalyticsInsights {
  return {
    summary: summaryByPeriod(input.periodRows),
    expensesByCategory: expensesByCategory(input.periodRows),
    monthlyEvolution: monthlyEvolution(input.evolutionRows, input.months),
    paidVsForecast: paidVsForecast(input.periodRows),
    installment: installmentSummary(input.seriesOccurrences, input.todayISO),
    recurring: recurringSummary(input.seriesOccurrences, input.todayISO),
    upcoming: upcomingCommitments(input.seriesOccurrences, input.todayISO),
    topExpenses: topExpenses(input.periodRows, 5),
  };
}