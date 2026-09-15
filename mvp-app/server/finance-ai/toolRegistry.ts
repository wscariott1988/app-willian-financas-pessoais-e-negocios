// toolRegistry.ts — Tool registry explícito e fechado das ferramentas
// financeiras (PESSOAL-13B1). Todas read-only; nenhuma aceita SQL; nenhuma de
// escrita/mutação. Os executores compartilham EXATAMENTE o motor determinístico
// do PESSOAL-12 (analyticsInsights / analytics / status): UI e ferramentas do
// Gemini produzem os mesmos números (uma única fonte de regra, nunca duplicada).
//
// Todas as consultas são executadas com o Supabase client anônimo + JWT do
// usuário autenticado (Authorization: Bearer) — a RLS e app.jwt_profile_id()
// continuam responsáveis pelo isolamento Pessoal/Negócio. Nada aqui usa a role
// administrativa do Supabase. O modelo nunca recebe UUIDs, emails, tokens ou
// metadados.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FinanceTool, ToolArgSchema, ToolResultExpenseMonthlyAggregate } from './types.js';
import {
  summaryByPeriod,
  expensesByCategory,
  buildEvolutionWindow,
  monthlyEvolution,
  paidVsForecast,
  installmentSummary,
  recurringSummary,
  topExpenses,
  expenseMonthlyAggregate,
  toSeriesOccurrenceRows,
  type EvolutionMonth,
  type ExpenseMonthlyAggregateOptions,
} from '../../src/lib/analyticsInsights.js';
import type { AnalyticsTxRow } from '../../src/lib/analytics.js';
import { isPaidStatus, isStatusOperationalVisible } from '../../src/lib/status.js';
import { formatShortDate } from '../../src/lib/period.js';

export const FINANCE_TOOL_NAMES: ReadonlyArray<string> = [
  'financial_summary',
  'expenses_by_category',
  'monthly_evolution',
  'paid_vs_forecast',
  'installment_summary',
  'recurring_summary',
  'top_expenses',
  'search_transactions',
  'expense_monthly_aggregate',
];

export const MAX_SEARCH_RESULTS = 20;

const PERIOD_FIELDS: ToolArgSchema = {
  start: {
    type: 'string',
    description:
      'Data inicial no formato YYYY-MM-DD. Sempre passe datas completas e válidas; nunca invente.',
    required: false,
  },
  end: {
    type: 'string',
    description:
      'Data final no formato YYYY-MM-DD (inclusiva). Sempre passe datas completas e válidas; nunca invente.',
    required: false,
  },
};

export function isValidISODate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parts = v.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return (
    d.getFullYear() === parts[0] &&
    d.getMonth() === parts[1] - 1 &&
    d.getDate() === parts[2]
  );
}

const TRANSACTIONS_SELECT =
  'id, transaction_kind, amount, account_id, category_id, occurred_on, status, raw_description, accounts(display_name), categories(display_name, canonical_path)';

function periodRange(args: Record<string, unknown>): { start?: string; end?: string } {
  const start = typeof args.start === 'string' && isValidISODate(args.start) ? args.start : undefined;
  const end = typeof args.end === 'string' && isValidISODate(args.end) ? args.end : undefined;
  return { start, end };
}

function applyPeriodFilters(
  q: any,
  start: string | undefined,
  end: string | undefined,
  rangeColumn = 'occurred_on',
): any {
  let builder = q;
  if (start) builder = builder.gte(rangeColumn, start);
  if (end) builder = builder.lte(rangeColumn, end);
  return builder;
}

async function fetchTransactions(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<AnalyticsTxRow[]> {
  const { start, end } = periodRange(args);
  let q = supabase
    .from('transactions')
    .select(TRANSACTIONS_SELECT)
    .is('deleted_at', null);
  q = applyPeriodFilters(q, start, end);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AnalyticsTxRow[];
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatPct(share: number): string {
  const pct = share * 100;
  return `${pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

// ── Executors determinísticos (mesmo motor do PESSOAL-12) ──────

async function execFinancialSummary(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rows = await fetchTransactions(supabase, args);
  const s = summaryByPeriod(rows);
  return {
    income: s.income,
    expense: s.expense,
    balance: s.balance,
    totalCount: s.totalCount,
    expenseShare: s.expenseShare,
  };
}

async function execExpensesByCategory(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rows = await fetchTransactions(supabase, args);
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  const rowsOut = expensesByCategory(rows, limit);
  return rowsOut.map((r) => ({
    label: r.label,
    amount: r.amount,
    share: r.share,
  }));
}

async function execMonthlyEvolution(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rawCount = typeof args.months === 'number' ? Math.floor(args.months) : 6;
  const count = Math.max(1, Math.min(24, rawCount));
  const today = new Date();
  const sel: EvolutionMonth = { year: today.getFullYear(), month: today.getMonth() + 1 };
  const window = buildEvolutionWindow(sel, count);

  let q = supabase
    .from('transactions')
    .select('amount, transaction_kind, occurred_on')
    .is('deleted_at', null)
    .gte('occurred_on', window.start)
    .lte('occurred_on', window.end);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data ?? [];
  const pts = monthlyEvolution(rows as unknown as AnalyticsTxRow[], window.months);
  return pts.map((p) => ({ key: p.key, label: p.label, income: p.income, expense: p.expense, balance: p.balance }));
}

async function execPaidVsForecast(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rows = await fetchTransactions(supabase, args);
  const pv = paidVsForecast(rows);
  return {
    paid: pv.paid,
    unpaid: pv.unpaid,
    total: pv.total,
    outsideStatusWindow: pv.outsideStatusWindow,
  };
}

async function execInstallmentSummary(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const today = typeof args.today === 'string' && isValidISODate(args.today) ? args.today : undefined;
  const todayRef = today ?? currentISODate();

  let q = supabase
    .from('transaction_series_occurrences')
    .select(
      'occurrence_index, occurred_on, amount, transaction_series(id, kind, frequency, display_name, amount_total, total_occurrences, starts_on, direction, state), transactions(status, deleted_at)',
    )
    .order('occurred_on', { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  const rows = toSeriesOccurrenceRows((data ?? []) as unknown[]);
  const ins = installmentSummary(rows, todayRef);
  return {
    count: ins.count,
    committed: ins.committed,
    items: ins.items.map((i) => ({
      displayName: i.displayName,
      remaining: i.remaining,
      nextDate: i.nextDate,
      amount: i.amount,
    })),
    finishingSoon: ins.finishingSoon.map((i) => ({
      displayName: i.displayName,
      remaining: i.remaining,
      nextDate: i.nextDate,
      amount: i.amount,
    })),
  };
}

async function execRecurringSummary(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const today = typeof args.today === 'string' && isValidISODate(args.today) ? args.today : undefined;
  const todayRef = today ?? currentISODate();

  let q = supabase
    .from('transaction_series_occurrences')
    .select(
      'occurrence_index, occurred_on, amount, transaction_series(id, kind, frequency, display_name, amount_total, total_occurrences, starts_on, direction, state), transactions(status, deleted_at)',
    )
    .order('occurred_on', { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  const rows = toSeriesOccurrenceRows((data ?? []) as unknown[]);
  const rec = recurringSummary(rows, todayRef);
  return {
    count: rec.count,
    items: rec.items.map((i) => ({
      displayName: i.displayName,
      frequencyLabel: i.frequencyLabel,
      nextDate: i.nextDate,
      amount: i.amount,
    })),
  };
}

async function execTopExpenses(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rows = await fetchTransactions(supabase, args);
  const limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : 5;
  const top = topExpenses(rows, limit);
  return top.map((t) => ({
    description: t.description,
    category: t.category,
    amount: t.amount,
    occurredOn: t.occurred_on,
  }));
}

async function execSearchTransactions(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { start, end } = periodRange(args);
  const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : '';
  let q = supabase
    .from('transactions')
    .select(TRANSACTIONS_SELECT)
    .is('deleted_at', null);
  q = applyPeriodFilters(q, start, end);
  if (search) q = q.ilike('raw_description', `%${search}%`);
  q = q.order('occurred_on', { ascending: false }).limit(MAX_SEARCH_RESULTS);
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as unknown as AnalyticsTxRow[];
  const out = rows.map((r) => ({
    date: formatShortDate(r.occurred_on ?? ''),
    description: r.raw_description ?? '',
    category: categoryLabelOrNone(r),
    account: accountLabelOrNone(r),
    type: typeLabel(r.transaction_kind),
    amount: num(r.amount),
    status: paymentStatusLabel(r),
  }));
  return { count: out.length, rows: out };
}

/** Período efetivo da agregação: usa o intervalo informado ou o ano corrente. */
function resolveAggregatePeriod(
  args: Record<string, unknown>,
  todayISO: string,
): { start: string; end: string } {
  if (args.start && args.end && isValidISODate(args.start) && isValidISODate(args.end)) {
    return { start: args.start, end: args.end };
  }
  const year = todayISO.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

async function execExpenseMonthlyAggregate(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
  todayISO: string,
): Promise<unknown> {
  const category =
    typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined;
  const subcategory =
    typeof args.subcategory === 'string' && args.subcategory.trim() ? args.subcategory.trim() : undefined;
  const period = resolveAggregatePeriod(args, todayISO);
  const rows = await fetchTransactions(supabase, { ...args, start: period.start, end: period.end });
  const options: ExpenseMonthlyAggregateOptions = {
    start: period.start,
    end: period.end,
    category,
    subcategory,
    kind: typeof args.kind === 'string' ? args.kind : 'expense',
  };
  return expenseMonthlyAggregate(rows, options, todayISO);
}

function embeddedName(
  value:
    | { display_name: string }
    | Array<{ display_name: string }>
    | null
    | undefined,
): string {
  if (!value) return '';
  if (Array.isArray(value)) return value[0]?.display_name ?? '';
  return value.display_name ?? '';
}

function accountLabelOrNone(r: AnalyticsTxRow): string {
  return embeddedName(r.accounts) || 'Sem conta';
}

function categoryLabelOrNone(r: AnalyticsTxRow): string {
  const cats = r.categories as
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null
    | undefined;
  if (!cats) return 'Sem categoria';
  const cat = Array.isArray(cats) ? cats[0] : cats;
  if (!cat) return 'Sem categoria';
  return cat.canonical_path || cat.display_name || 'Sem categoria';
}

function typeLabel(kind: string | undefined): string {
  if (kind === 'income') return 'Receita';
  if (kind === 'expense') return 'Despesa';
  return 'Transferência';
}

function paymentStatusLabel(r: AnalyticsTxRow): string {
  const occurredOn = r.occurred_on ?? '';
  if (!isStatusOperationalVisible(occurredOn)) return 'Histórico';
  return isPaidStatus(r.status) ? 'Pago' : 'Não pago';
}

// ── Registry ───────────────────────────────────────────────────

export const FINANCE_TOOLS: ReadonlyArray<FinanceTool> = [
  {
    name: 'financial_summary',
    description:
      'Resumo do período: receitas, despesas, resultado (receitas − despesas), total de transações e a participação das despesas sobre as receitas. Transferências nunca entram.',
    argSchema: PERIOD_FIELDS,
    execute: execFinancialSummary,
  },
  {
    name: 'expenses_by_category',
    description:
      'Ranking das despesas por categoria (com o percentual sobre o total de despesas). Limitado por "limit" quando informado.',
    argSchema: {
      ...PERIOD_FIELDS,
      limit: {
        type: 'number',
        description: 'Quantidade máxima de categorias no ranking (ex.: 10).',
        required: false,
      },
    },
    execute: execExpensesByCategory,
  },
  {
    name: 'monthly_evolution',
    description:
      'Evolução mensal de receitas, despesas e resultado (receitas − despesas) para os últimos N meses cheios terminando no mês atual.',
    argSchema: {
      months: {
        type: 'number',
        description: 'Quantos meses completos considerar (3, 6 ou 12).',
        required: false,
      },
    },
    execute: execMonthlyEvolution,
  },
  {
    name: 'paid_vs_forecast',
    description:
      'Comparação Pago x Não pago no período: valores pagos (posted), não pagos (previstos) e total geral, incluindo a parcela anterior ao controle de status.',
    argSchema: PERIOD_FIELDS,
    execute: execPaidVsForecast,
  },
  {
    name: 'installment_summary',
    description:
      'Parcelamentos ativos: quantidade, valor futuro comprometido (soma das parcelas não pagas — nunca valor total fabricado) e quais estão próximos de terminar.',
    argSchema: {
      today: {
        type: 'string',
        description: 'Data de referência YYYY-MM-DD (padrão: hoje servidor).',
        required: false,
      },
    },
    execute: execInstallmentSummary,
  },
  {
    name: 'recurring_summary',
    description:
      'Recorrências ativas: quantidade, nome, frequência, próxima data e valor da próxima ocorrência.',
    argSchema: {
      today: {
        type: 'string',
        description: 'Data de referência YYYY-MM-DD (padrão: hoje servidor).',
        required: false,
      },
    },
    execute: execRecurringSummary,
  },
  {
    name: 'top_expenses',
    description:
      'Maiores despesas do período: descrição, categoria, valor e data, ordenadas do maior para o menor.',
    argSchema: {
      ...PERIOD_FIELDS,
      limit: {
        type: 'number',
        description: 'Quantidade máxima de despesas (padrão 5).',
        required: false,
      },
    },
    execute: execTopExpenses,
  },
  {
    name: 'search_transactions',
    description:
      'Busca transações individuais do período (opcional por descrição). Devolve até 20 registros com data, descrição, categoria, conta, tipo, valor e status. Use somente quando a pergunta exigir o detalhamento individual.',
    argSchema: {
      ...PERIOD_FIELDS,
      search: {
        type: 'string',
        description: 'Termo de busca na descrição (opcional).',
        required: false,
      },
    },
    execute: execSearchTransactions,
  },
  {
    name: 'expense_monthly_aggregate',
    description:
      'Agregação MENSAL de despesas em UM único resultado: soma e quantidade por mês, mês(es) com maior gasto, vencedor empatado quando houver, total do período e período efetivamente analisado. Use SEMPRE que a pergunta comparar gastos por mês ou pedir o mês com maior gasto em uma categoria/subcategoria (ex.: "qual mês gastei mais em supermercado este ano?"). Informe o intervalo completo (start/end) do ano/mês desejado e, se houver, a categoria ou subcategoria. Receitas e transferências são sempre excluídas; NUNCA liste meses separadamente nem use search_transactions para calcular totais.',
    argSchema: {
      ...PERIOD_FIELDS,
      kind: {
        type: 'string',
        description:
          'Tipo de movimentação. Somente "expense" (despesa) é suportado; receitas e transferências são sempre excluídas.',
        required: false,
      },
      category: {
        type: 'string',
        description:
          'Categoria (ex.: "Supermercado"). O match ignora maiúsculas, acentos e espaços extras; casa com o display_name ou o caminho canônico da categoria.',
        required: false,
      },
      subcategory: {
        type: 'string',
        description:
          'Subcategoria (ex.: "Alimentação > Supermercado"). O match ignora maiúsculas, acentos e espaços extras.',
        required: false,
      },
    },
    execute: execExpenseMonthlyAggregate,
  },
];

export function getFinanceTool(name: string): FinanceTool | null {
  const tool = FINANCE_TOOLS.find((t) => t.name === name);
  return tool ?? null;
}

const DATE_KEYS = ['start', 'end', 'today'];

export function validateToolArgs(name: string, args: unknown): Record<string, unknown> {
  const tool = getFinanceTool(name);
  if (!tool) return {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const rec = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(tool.argSchema)) {
    const value = rec[key];
    if (value === undefined || value === null) {
      if (def.required) throw new Error(`Argumento obrigatório ausente: ${key}`);
      continue;
    }
    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`Argumento inválido para ${key}: esperado número`);
      out[key] = n;
      continue;
    }
    if (def.type === 'string') {
      if (typeof value !== 'string') throw new Error(`Argumento inválido para ${key}: esperado texto`);
      if (DATE_KEYS.includes(key) && !isValidISODate(value)) {
        throw new Error(`Argumento inválido para ${key}: data esperada no formato AAAA-MM-DD`);
      }
      out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ── Helpers de evidência (amigáveis, sem UUID/sem detalhes técnicos) ──

export function toolResultToEvidence(
  name: string,
  result: unknown,
): Array<{ label: string; value: string }> {
  if (name === 'financial_summary') {
    const r = result as Record<string, unknown>;
    return [
      { label: 'Receitas', value: formatBRL(num(r.income)) },
      { label: 'Despesas', value: formatBRL(num(r.expense)) },
      { label: 'Resultado', value: formatBRL(num(r.balance)) },
    ];
  }
  if (name === 'expenses_by_category') {
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    return rows.slice(0, 5).map((r) => ({
      label: String(r.label ?? 'Sem categoria'),
      value: formatBRL(num(r.amount)),
    }));
  }
  if (name === 'monthly_evolution') {
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    return rows.slice(-3).map((r) => ({
      label: String(r.label ?? r.key ?? ''),
      value: formatBRL(num(r.balance)),
    }));
  }
  if (name === 'paid_vs_forecast') {
    const r = result as Record<string, unknown>;
    return [
      { label: 'Pago', value: formatBRL(num(r.paid)) },
      { label: 'Não pago (previsto)', value: formatBRL(num(r.unpaid)) },
    ];
  }
  if (name === 'installment_summary') {
    const r = result as Record<string, unknown>;
    return [
      { label: 'Parcelamentos ativos', value: String(num(r.count)) },
      { label: 'Futuro comprometido', value: formatBRL(num(r.committed)) },
    ];
  }
  if (name === 'recurring_summary') {
    const r = result as Record<string, unknown>;
    return [{ label: 'Recorrências ativas', value: String(num(r.count)) }];
  }
  if (name === 'top_expenses') {
    const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
    return rows.slice(0, 3).map((r) => ({
      label: String(r.description || r.category || 'Despesa'),
      value: formatBRL(num(r.amount)),
    }));
  }
  if (name === 'search_transactions') {
    const r = result as Record<string, unknown>;
    const rows = Array.isArray(r.rows) ? r.rows : [];
    // Nunca expõe "Total das buscas": rows é uma amostra limitada (até 20),
    // e somá-la como se fosse o total agregado seria enganoso.
    return [{ label: 'Registros encontrados', value: String(rows.length) }];
  }
  if (name === 'expense_monthly_aggregate') {
    const r = result as ToolResultExpenseMonthlyAggregate;
    const ev: Array<{ label: string; value: string }> = [];
    if (!r.hasData) {
      ev.push({ label: 'Despesas no período', value: 'Nenhuma encontrada' });
    } else {
      for (const w of r.winnerMonths ?? []) {
        ev.push({
          label: `${w.monthLabel} com maior gasto`,
          value: formatBRL(num(r.winnerAmount)),
        });
      }
      ev.push({ label: 'Despesas consideradas', value: String(num(r.winnerCount)) });
    }
    if (r.periodAnalyzed && r.periodAnalyzed.start && r.periodAnalyzed.end) {
      ev.push({
        label: 'Período analisado',
        value: `${formatShortDate(r.periodAnalyzed.start)} a ${formatShortDate(r.periodAnalyzed.end)}`,
      });
    }
    return ev;
  }
  return [];
}

function currentISODate(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export { formatBRL, formatPct };
