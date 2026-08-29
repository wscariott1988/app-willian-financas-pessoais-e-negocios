// analytics.ts — Análises MVP (CFG-P6B). Lógica pura/testável; nenhum write.
// Reutiliza EXATAMENTE a semântica financeira canônica do Dashboard/summary.ts:
//   - receitas  = transaction_kind = 'income'
//   - despesas  = transaction_kind = 'expense'
//   - resultado = receitas − despesas (NUNCA chamado de saldo bancário)
//   - transferências NÃO entram como receita nem despesa nos totais globais
//     (ficam em campo próprio; pernas apenas na seção "Movimentação por conta")
//   - deleted_at IS NULL é pré-requisito da query (soft-delete excluído)
//   - perfil isolado por RLS (profile_id do JWT)
//   - período inclusivo [start, end]
//   - status NÃO filtra totais (mesma regra do resumo atual: todas as transações
//     do período entram; scheduled/legados preservados sem normalização)
// Séries/parcelamentos: trabalha SOMENTE sobre transactions materializadas;
// nunca soma transaction_series.amount_total por cima.

export interface AnalyticsTxRow {
  id: string;
  transaction_kind: 'income' | 'expense' | 'transfer';
  amount: number | string;
  account_id: string;
  category_id: string | null;
  accounts: { display_name: string } | Array<{ display_name: string }> | null;
  categories: { display_name: string; canonical_path: string | null } | Array<{ display_name: string; canonical_path: string | null }> | null;
}

export interface PeriodTotals {
  income: number;
  expense: number;
  transfer: number;
  balance: number;
  totalCount: number;
}

export interface CategoryBreakdownRow {
  category_id: string | null;
  label: string;
  amount: number;
  share: number; // 0..1; 0 quando total = 0
}

export interface AccountBreakdownRow {
  account_id: string;
  label: string;
  income: number;
  expense: number;
  transfer: number;
  net: number;
  activity: number; // |income| + |expense| + |transfer| — ordenação
}

export interface AnalyticsResult {
  totals: PeriodTotals;
  expensesByCategory: CategoryBreakdownRow[];
  incomesByCategory: CategoryBreakdownRow[];
  accounts: AccountBreakdownRow[];
}

function number(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function embeddedName(value: { display_name: string } | Array<{ display_name: string }> | null | undefined): string {
  if (!value) return '';
  if (Array.isArray(value)) return value[0]?.display_name ?? '';
  return value.display_name ?? '';
}

function embeddedCat(
  value:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null
    | undefined,
): { display_name: string; canonical_path: string | null } | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/** Totais globais do período (mesma regra do summary.ts). */
export function summarizePeriod(rows: AnalyticsTxRow[]): PeriodTotals {
  let income = 0;
  let expense = 0;
  let transfer = 0;
  for (const r of rows) {
    const amount = number(r.amount);
    if (r.transaction_kind === 'income') income += amount;
    else if (r.transaction_kind === 'expense') expense += amount;
    else if (r.transaction_kind === 'transfer') transfer += amount;
  }
  return { income, expense, transfer, balance: income - expense, totalCount: rows.length };
}

/** Rótulo amigável da categoria (path canônico quando disponível; nunca UUID). */
export function categoryLabel(row: AnalyticsTxRow): string {
  const cat = embeddedCat(row.categories);
  if (!cat) return 'Sem categoria';
  return cat.canonical_path || cat.display_name || 'Sem categoria';
}

/**
 * Ranking por categoria (separado por direção — nunca mistura receita/despesa).
 * A participação é calculada sobre o total daquela direção; "Sem categoria"
 * aparece de forma amigável quando houver valor.
 */
export function breakdownByCategory(
  rows: AnalyticsTxRow[],
  direction: 'income' | 'expense',
  total: number,
): CategoryBreakdownRow[] {
  const byCat = new Map<string, { id: string | null; label: string; amount: number }>();
  for (const r of rows) {
    if (r.transaction_kind !== direction) continue;
    const label = categoryLabel(r);
    const key = r.category_id ?? '__none__';
    const cur = byCat.get(key) ?? { id: r.category_id, label, amount: 0 };
    cur.amount += number(r.amount);
    byCat.set(key, cur);
  }
  const list = [...byCat.values()].map((c) => ({
    category_id: c.id,
    label: c.label,
    amount: c.amount,
    share: total > 0 ? c.amount / total : 0,
  }));
  return list.sort((a, b) => b.amount - a.amount);
}

/**
 * Movimentação por conta (NUNCA "saldo da conta" — não há conciliação inicial).
 * Líquido = receitas − despesas da conta no período; "activity" soma o valor
 * absoluto de receitas/despesas/pernas de transferência para ordenação por
 * maior movimentação. Contas sem movimento no período são omitidas.
 */
export function breakdownByAccount(rows: AnalyticsTxRow[]): AccountBreakdownRow[] {
  const byAcc = new Map<string, { income: number; expense: number; transfer: number; label: string }>();
  for (const r of rows) {
    const amount = number(r.amount);
    const cur = byAcc.get(r.account_id) ?? { income: 0, expense: 0, transfer: 0, label: embeddedName(r.accounts) || 'Conta' };
    if (r.transaction_kind === 'income') cur.income += amount;
    else if (r.transaction_kind === 'expense') cur.expense += amount;
    else if (r.transaction_kind === 'transfer') cur.transfer += amount;
    byAcc.set(r.account_id, cur);
  }
  const list = [...byAcc.entries()].map(([id, v]) => ({
    account_id: id,
    label: v.label,
    income: v.income,
    expense: v.expense,
    transfer: v.transfer,
    net: v.income - v.expense,
    activity: Math.abs(v.income) + Math.abs(v.expense) + Math.abs(v.transfer),
  }));
  return list.sort((a, b) => b.activity - a.activity);
}

/** Pipeline completo (testável). */
export function buildAnalytics(rows: AnalyticsTxRow[]): AnalyticsResult {
  const totals = summarizePeriod(rows);
  return {
    totals,
    expensesByCategory: breakdownByCategory(rows, 'expense', totals.expense),
    incomesByCategory: breakdownByCategory(rows, 'income', totals.income),
    accounts: breakdownByAccount(rows),
  };
}