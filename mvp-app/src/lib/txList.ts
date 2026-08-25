// txList.ts — Lógica da lista de transações (Etapa 1.1).
// Filtros de status/categoria como estado puro, construção da consulta com
// período sempre presente, paginação em lotes. A apresentação dos status é
// centralizada em lib/status.ts (Pago/Não pago a partir do cutoff — STATUS-P0b).

import { fetchAllPages, type PageFetcher } from './pagination';
import { NON_PAID_STATUSES, STATUS_EDITABLE_FROM } from './status';

export const TX_PAGE_SIZE = 1000;

export type TxRow = Record<string, unknown>;
export type TxPageFetcher = PageFetcher;

// ---------- Filtros (estado puro) ----------

export interface TxListFilters {
  unpaidOnly: boolean;
  noCategory: boolean;
}

export function txFilterInitial(): TxListFilters {
  return { unpaidOnly: false, noCategory: false };
}

export function toggleUnpaidFilter(f: TxListFilters): TxListFilters {
  return { ...f, unpaidOnly: !f.unpaidOnly };
}

export function toggleNoCategoryFilter(f: TxListFilters): TxListFilters {
  return { ...f, noCategory: !f.noCategory };
}

export function clearTxFilters(): TxListFilters {
  return txFilterInitial();
}

export function hasActiveTxFilters(f: TxListFilters): boolean {
  return f.unpaidOnly || f.noCategory;
}

// ---------- Opções da consulta ----------

export interface TxQueryOptions {
  start?: string; // período global — opcional (modo Pendências não envia)
  end?: string;
  search?: string;
  accountId?: string;
  statusFilter?: 'unpaid' | null;
  noCategory?: boolean;
  pendingFilter?: PendingFilter | null;
}

export function buildTxListOptions(
  filters: TxListFilters,
  base: { search: string; accountId: string; start: string; end: string },
): TxQueryOptions {
  return {
    start: base.start,
    end: base.end,
    search: base.search.trim() ? base.search.trim() : undefined,
    accountId: base.accountId || undefined,
    statusFilter: filters.unpaidOnly ? 'unpaid' : null,
    noCategory: filters.noCategory || undefined,
  };
}

// ---------- Fila global de pendências (a partir do cutoff) ----------

export type PendingFilter = 'all' | 'unpaid' | 'noCategory';

export interface PendingTxBase {
  search: string;
  accountId: string;
  pendingFilter: PendingFilter;
}

export function buildPendingTxOptions(base: PendingTxBase): TxQueryOptions {
  return {
    search: base.search.trim() ? base.search.trim() : undefined,
    accountId: base.accountId || undefined,
    pendingFilter: base.pendingFilter,
  };
}

// ---------- Fetcher da página (client injetável, testável) ----------

// Interface mínima compatível com o cliente Supabase (supabase.from(...)).
export interface TxClientLike {
  from(table: string): any;
}

export function createTxPageFetcher(client: TxClientLike, opts: TxQueryOptions): TxPageFetcher {
  return (from, to) => {
    let q = client
      .from('transactions')
      .select('*, categories(display_name), accounts(display_name)', { count: 'exact' })
      .is('deleted_at', null);

    if (opts.search) q = q.ilike('raw_description', `%${opts.search}%`);
    if (opts.accountId) q = q.eq('account_id', opts.accountId);

    // Fila global de pendências: OR no servidor (cada transação uma única vez).
    // "Não pagos" = status ativos não-posted a partir do cutoff (STATUS-P0b);
    // "Sem categoria" permanece sobre todo o histórico.
    if (opts.pendingFilter === 'all') {
      q = q.or(`and(status.in.(${NON_PAID_STATUSES.join(',')}),occurred_on.gte.${STATUS_EDITABLE_FROM}),category_id.is.null`);
    } else if (opts.pendingFilter === 'unpaid') {
      q = q.in('status', NON_PAID_STATUSES).gte('occurred_on', STATUS_EDITABLE_FROM);
    } else if (opts.pendingFilter === 'noCategory') {
      q = q.is('category_id', null);
    } else {
      if (opts.statusFilter === 'unpaid') q = q.in('status', NON_PAID_STATUSES);
      if (opts.noCategory) q = q.is('category_id', null);
    }

    // Período: enviado somente no modo Do período (Pendências não tem intervalo).
    if (opts.start) q = q.gte('occurred_on', opts.start);
    if (opts.end) q = q.lte('occurred_on', opts.end);

    // Ordenação estável: ocorrência desc, depois criação desc.
    q = q.order('occurred_on', { ascending: false }).order('created_at', { ascending: false });

    return q.range(from, to).then((r: any) => ({
      rows: (r.data ?? []) as unknown[],
      totalCount: r.count,
      error: r.error,
    }));
  };
}

export async function fetchAllTxPages(
  fetcher: TxPageFetcher,
  pageSize: number = TX_PAGE_SIZE,
): Promise<{ rows: TxRow[]; totalCount: number }> {
  return fetchAllPages<TxRow>(fetcher, pageSize);
}
