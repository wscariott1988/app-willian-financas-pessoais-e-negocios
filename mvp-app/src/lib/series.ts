// series.ts - Recorrências e parcelamentos (CFG-P5A, Package 015).
// Lógica pura/testável; nenhum write direto. RPCs atômicos no backend (021).
// Contrato fechado: valor digitado = TOTAL; último dia do mês para datas
// inexistentes; frequências weekly/monthly/yearly; recorrência pode ser aberta;
// "série inteira" altera passado com confirmação; futuras nascem 'scheduled'.

export type SeriesKind = 'installment' | 'recurring';
export type SeriesFrequency = 'weekly' | 'monthly' | 'yearly';
export type SeriesScope = 'this' | 'this_and_next' | 'whole';

export const SERIES_KIND_LABELS: Record<SeriesKind, string> = {
  installment: 'Parcelada',
  recurring: 'Recorrente',
};

export const SERIES_FREQUENCY_LABELS: Record<SeriesFrequency, string> = {
  weekly: 'Semanal',
  monthly: 'Mensal',
  yearly: 'Anual',
};

export const SERIES_SCOPE_LABELS: Record<SeriesScope, string> = {
  this: 'Somente esta ocorrência',
  this_and_next: 'Esta e as próximas',
  whole: 'Série inteira',
};

export const RECURRING_HORIZON = 24;
export const MAX_INSTALLMENTS = 120;

/** Próxima data da enésima ocorrência (1-based); mês sem o dia -> último dia. */
export function seriesOccurrenceDate(base: string, freq: SeriesFrequency, index: number): string {
  if (index < 1) return base;
  const b = new Date(base + 'T12:00:00');
  if (freq === 'weekly') {
    const d = new Date(b);
    d.setDate(d.getDate() + (index - 1) * 7);
    return toISODate(d);
  }
  const day = b.getDate();
  const baseMonth = b.getMonth();
  const baseYear = b.getFullYear();
  if (freq === 'monthly') {
    const total = baseMonth + (index - 1);
    const year = baseYear + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    return lastDayOfMonth(year, month, day);
  }
  // yearly
  return lastDayOfMonth(baseYear + (index - 1), baseMonth, day);
}

function lastDayOfMonth(year: number, monthIndex: number, day: number): string {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  return toISODate(new Date(year, monthIndex, Math.min(day, last)));
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Valor da parcela i (1..N) para total T (contrato A): primeiras N-1 =
 * floor(T*100/N)/100 (centavos truncados); última = T - soma das anteriores.
 * Soma SEMPRE igual ao total digitado; arredondamento determinístico.
 */
export function installmentAmount(total: number, index: number, n: number): number {
  if (n <= 0) return 0;
  const base = Math.floor((total * 100) / n) / 100;
  if (index >= n) {
    const somaAnteriores = base * (n - 1);
    return Math.round((total - somaAnteriores) * 100) / 100;
  }
  return base;
}

/** Status inicial: ocorrência futura (depois de hoje) = scheduled; senão o escolhido. */
export function seriesOccurrenceStatus(occurredOn: string, chosen: 'posted' | 'pending'): 'posted' | 'pending' | 'scheduled' {
  if (occurredOn > todayISO()) return 'scheduled';
  return chosen;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export interface PreviewRow {
  index: number;
  occurred_on: string;
  amount: number;
  status: string;
  account_valid: boolean;
  category_valid: boolean;
}

/** Total de ocorrências de uma série (horizonte para recorrência aberta). */
export function seriesTotalOccurrences(kind: SeriesKind, total: number | null): number {
  if (kind === 'installment') {
    if (!total || total < 1) return 0;
    return Math.min(total, MAX_INSTALLMENTS);
  }
  if (!total) return RECURRING_HORIZON;
  return Math.min(Math.max(1, total), MAX_INSTALLMENTS);
}

/** Gera o preview local (sem write) — mesmas regras do RPC app.transaction_series_preview. */
export function buildSeriesPreview(
  direction: 'income' | 'expense',
  kind: SeriesKind,
  freq: SeriesFrequency,
  amountTotal: number,
  totalOccurrences: number | null,
  startsOn: string,
  accountValidForDate: (date: string) => boolean,
  categoryValid: boolean,
): { rows: PreviewRow[]; total: number } {
  const n = seriesTotalOccurrences(kind, totalOccurrences);
  const rows: PreviewRow[] = [];
  for (let i = 1; i <= n; i++) {
    const date = seriesOccurrenceDate(startsOn, freq, i);
    const amount = kind === 'installment' ? installmentAmount(amountTotal, i, n) : amountTotal;
    rows.push({
      index: i,
      occurred_on: date,
      amount,
      status: seriesOccurrenceStatus(date, 'posted'),
      account_valid: accountValidForDate(date),
      category_valid: categoryValid,
    });
  }
  return { rows, total: n };
}

/** Mensagens amigáveis do preview (sem UUID/JSON/técnica). */
export function previewSummary(rows: PreviewRow[]): string {
  return `${rows.length} ${rows.length === 1 ? 'ocorrência' : 'ocorrências'}`;
}

export function previewLine(row: PreviewRow): string {
  const d = row.occurred_on.split('-');
  const date = `${d[2]}/${d[1]}/${d[0]}`;
  const amt = row.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${row.index} — ${date} — R$ ${amt}`;
}

/**
 * Meta mínima de série extraída da ocorrência embutida na transação
 * (transaction_series_occurrences(occurrence_index, transaction_series(...))).
 */
export interface SeriesDisplayMeta {
  kind: SeriesKind;
  occurrence_index: number;
  total_occurrences: number | null;
}

/**
 * Normaliza a ocorrência embutida via PostgREST para exibição (badge nas listas).
 * Transação sem série, embed nulo/array ou kind desconhecido -> null (sem badge).
 */
export function extractSeriesMeta(occurrence: unknown): SeriesDisplayMeta | null {
  if (!occurrence || typeof occurrence !== 'object') return null;
  const occ = occurrence as {
    occurrence_index?: number | null;
    transaction_series?:
      | { kind?: string | null; total_occurrences?: number | null }
      | Array<{ kind?: string | null; total_occurrences?: number | null }>
      | null;
  };
  if (occ.occurrence_index == null) return null;
  const ser = Array.isArray(occ.transaction_series) ? occ.transaction_series[0] : occ.transaction_series;
  if (!ser || typeof ser !== 'object') return null;
  const kind = ser.kind;
  if (kind !== 'installment' && kind !== 'recurring') return null;
  return {
    kind,
    occurrence_index: occ.occurrence_index,
    total_occurrences: ser.total_occurrences ?? null,
  };
}

/** Rótulo amigável do badge sem termos técnicos: "Parcela N de T" ou "Recorrente". */
export function seriesDisplayLabel(meta: SeriesDisplayMeta | null): string | null {
  if (!meta) return null;
  if (meta.kind === 'installment') {
    const total = meta.total_occurrences != null && meta.total_occurrences >= 1 ? meta.total_occurrences : null;
    return total != null ? `Parcela ${meta.occurrence_index} de ${total}` : `Parcela ${meta.occurrence_index}`;
  }
  return 'Recorrente';
}