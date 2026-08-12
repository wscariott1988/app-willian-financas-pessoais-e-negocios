// summary.ts — Resumo do período consultado no Supabase.
// Regras confirmadas no schema (002_schema.sql):
//   - transações.transaction_kind IN ('income','expense','transfer')
//   - transações.amount numeric(18,2) CHECK (amount > 0)  -> sempre positivo;
//     a direção é dada por transaction_kind
//   - transações.occurred_on date  -> filtro de período por ocorrência
//   - isolamento por perfil: feito pelo RLS (transactions_select_own), que usa
//     o profile_id do JWT (app_metadata no Cloud / claims no gateway local).
// O gateway local (DEV) não suporta agregados do PostgREST, então o resumo
// busca apenas as colunas 'amount, transaction_kind' do período, paginando com
// .range(from, to) até esgotar o total (count=exact). A soma só é apresentada
// depois que todas as páginas foram buscadas com sucesso; qualquer erro de
// página aborta o resumo inteiro (nunca soma parcial).

import { supabase } from '../supabaseClient';
import type { PeriodRange } from './period';

export interface PeriodSummary {
  income: number;
  expense: number;
  transfer: number;
  balance: number;
  totalCount: number;
}

export interface SummaryRow {
  amount: number | string;
  transaction_kind: 'income' | 'expense' | 'transfer';
}

export interface PeriodPage {
  rows: SummaryRow[] | null;
  totalCount: number | null;
  error: Error | null;
}

export type PeriodPageFetcher = (from: number, to: number) => Promise<PeriodPage>;

export const PERIOD_PAGE_SIZE = 1000;

// Busca todas as páginas da projeção mínima. Termina quando o total acumulado
// atinge o total informado (count=exact) ou, na ausência de total, quando a
// página vem incompleta/vazia. Nunca entra em loop infinito: a cada iteração
// ou avança o offset ou encerra; página vazia antes do total esperado é erro.
export async function fetchAllPeriodRows(
  fetcher: PeriodPageFetcher,
  pageSize: number = PERIOD_PAGE_SIZE,
): Promise<{ rows: SummaryRow[]; totalCount: number }> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('pageSize deve ser um inteiro maior que zero');
  }

  const rows: SummaryRow[] = [];
  let totalCount: number | null = null;
  let from = 0;

  for (;;) {
    const page = await fetcher(from, from + pageSize - 1);
    if (page.error) throw page.error;

    const pageRows = page.rows ?? [];
    totalCount = page.totalCount ?? totalCount;
    rows.push(...pageRows);

    if (totalCount !== null) {
      if (rows.length >= totalCount) break;
      if (pageRows.length === 0) {
        throw new Error(
          `página vazia antes do total esperado (${rows.length}/${totalCount}) — soma abortada`,
        );
      }
    } else if (pageRows.length < pageSize || pageRows.length === 0) {
      break;
    }

    from += pageSize;
  }

  return { rows, totalCount: totalCount ?? rows.length };
}

// Soma as linhas do intervalo. Transferências ficam em campo próprio e NÃO
// entram como receita nem despesa (regra confirmada no schema).
export function sumPeriodRows(rows: SummaryRow[]): {
  income: number;
  expense: number;
  transfer: number;
} {
  let income = 0;
  let expense = 0;
  let transfer = 0;
  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    if (row.transaction_kind === 'income') income += amount;
    else if (row.transaction_kind === 'expense') expense += amount;
    else if (row.transaction_kind === 'transfer') transfer += amount;
  }
  return { income, expense, transfer };
}

// Pipeline completo (páginas + soma), testável sem o cliente Supabase.
export async function buildPeriodSummary(
  fetcher: PeriodPageFetcher,
  pageSize: number = PERIOD_PAGE_SIZE,
): Promise<PeriodSummary> {
  const { rows, totalCount } = await fetchAllPeriodRows(fetcher, pageSize);
  const { income, expense, transfer } = sumPeriodRows(rows);
  return { income, expense, transfer, balance: income - expense, totalCount };
}

// Consulta real no Supabase com filtro de data, contagem exata e paginação.
export async function fetchPeriodSummary(range: PeriodRange): Promise<PeriodSummary> {
  return buildPeriodSummary((from, to) => fetchPeriodPage(range, from, to));
}

async function fetchPeriodPage(
  range: PeriodRange,
  from: number,
  to: number,
): Promise<PeriodPage> {
  const { data, error, count } = await supabase
    .from('transactions')
    .select('amount, transaction_kind', { count: 'exact' })
    .gte('occurred_on', range.start)
    .lte('occurred_on', range.end)
    .range(from, to);

  return { rows: (data ?? []) as SummaryRow[], totalCount: count, error };
}
