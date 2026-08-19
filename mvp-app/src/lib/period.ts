// period.ts — Cálculo do período global (mês + modo).
// Todas as datas são LOCAIS: construídas com new Date(y, m, d) e serializadas
// manualmente (nunca toISOString/toJSON, que deslocariam para UTC).

export type PeriodMode = 'up_to_today' | 'today_to_end' | 'full_month' | 'custom';

export interface PeriodSelection {
  year: number;
  month: number; // 1..12
}

export interface PeriodRange {
  start: string; // YYYY-MM-DD (data local)
  end: string; // YYYY-MM-DD (data local)
}

export const PERIOD_MODES: ReadonlyArray<{ id: PeriodMode; label: string; hint: string }> = [
  { id: 'up_to_today', label: 'Até hoje', hint: 'Do dia 1 ao dia do corte' },
  { id: 'today_to_end', label: 'Hoje ao fim do mês', hint: 'Do dia do corte ao último dia' },
  { id: 'full_month', label: 'Mês todo', hint: 'Do primeiro ao último dia' },
];

export function toLocalISODate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${mm}-${dd}`;
}

export function daysInMonth(year: number, month: number): number {
  // month é 1..12; new Date(y, m, 0) é o último dia do mês m (índice Date é 0-based).
  return new Date(year, month, 0).getDate();
}

export function addMonths(sel: PeriodSelection, delta: number): PeriodSelection {
  const total = sel.year * 12 + (sel.month - 1) + delta;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12 + 1;
  return { year, month };
}

export function selectionFromDate(d: Date): PeriodSelection {
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function isSameMonth(a: PeriodSelection, b: PeriodSelection): boolean {
  return a.year === b.year && a.month === b.month;
}

// Para o mês atual: cortes usam a data real de hoje.
// Para outro mês: corte = mesmo número do dia atual, limitado ao último dia do mês.
export function computePeriodRange(
  sel: PeriodSelection,
  mode: PeriodMode,
  today: Date,
): PeriodRange {
  const first = 1;
  const last = daysInMonth(sel.year, sel.month);
  const inCurrentMonth = isSameMonth(sel, selectionFromDate(today));
  const cutDay = Math.min(today.getDate(), last);

  const startOfMonth = toLocalISODate(sel.year, sel.month, first);
  const endOfMonth = toLocalISODate(sel.year, sel.month, last);
  const dayOfToday = toLocalISODate(sel.year, sel.month, today.getDate());
  const dayOfCut = toLocalISODate(sel.year, sel.month, cutDay);

  switch (mode) {
    case 'up_to_today':
      return { start: startOfMonth, end: inCurrentMonth ? dayOfToday : dayOfCut };
    case 'today_to_end':
      return { start: inCurrentMonth ? dayOfToday : dayOfCut, end: endOfMonth };
    case 'full_month':
      return { start: startOfMonth, end: endOfMonth };
  }
}

export function formatMonthLabel(sel: PeriodSelection): string {
  return new Date(sel.year, sel.month - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  });
}

export function formatShortDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export interface CustomRangeValidation {
  valid: boolean;
  error?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateCustomRange(start: string, end: string): CustomRangeValidation {
  if (!start || !end) {
    return { valid: false, error: 'Informe a data inicial e a data final.' };
  }
  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
    return { valid: false, error: 'Formato de data inválido. Use AAAA-MM-DD.' };
  }
  if (start > end) {
    return { valid: false, error: 'A data inicial não pode ser posterior à data final.' };
  }
  return { valid: true };
}
