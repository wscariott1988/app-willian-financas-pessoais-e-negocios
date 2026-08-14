// txList.ts — Lógica da lista de transações (Etapa 1.1).
// Filtros de status/categoria como estado puro, construção da consulta com
// período sempre presente, paginação em lotes e status legíveis em português
// (sem alterar os valores gravados).

import { fetchAllPages, type PageFetcher } from './pagination';

export const TX_PAGE_SIZE = 1000;

export type TxRow = Record<string, unknown>;
export type TxPageFetcher = PageFetcher;

// ---------- Filtros (estado puro) ----------

export interface TxListFilters {
  reviewOnly: boolean;
  noCategory: boolean;
}

export function txFilterInitial(): TxListFilters {
  return { reviewOnly: false, noCategory: false };
}

export function toggleReviewFilter(f: TxListFilters): TxListFilters {
  return { ...f, reviewOnly: !f.reviewOnly };
}

export function toggleNoCategoryFilter(f: TxListFilters): TxListFilters {
  return { ...f, noCategory: !f.noCategory };
}

export function clearTxFilters(): TxListFilters {
  return txFilterInitial();
}

export function hasActiveTxFilters(f: TxListFilters): boolean {
  return f.reviewOnly || f.noCategory;
}

// ---------- Opções da consulta ----------

export interface TxQueryOptions {
  start?: string; // período global — opcional (modo Pendências não envia)
  end?: string;
  search?: string;
  accountId?: string;
  statusFilter?: 'review' | null;
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
    statusFilter: filters.reviewOnly ? 'review' : null,
    noCategory: filters.noCategory || undefined,
  };
}

// ---------- Fila global de pendências (todo o histórico, sem intervalo) ----------

export type PendingFilter = 'all' | 'review' | 'noCategory';

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
      .select('*, categories(display_name), accounts(display_name)', { count: 'exact' });

    if (opts.search) q = q.ilike('raw_description', `%${opts.search}%`);
    if (opts.accountId) q = q.eq('account_id', opts.accountId);

    // Fila global de pendências: OR no servidor (cada transação uma única vez).
    if (opts.pendingFilter === 'all') {
      q = q.or('status.eq.review,category_id.is.null');
    } else if (opts.pendingFilter === 'review') {
      q = q.eq('status', 'review');
    } else if (opts.pendingFilter === 'noCategory') {
      q = q.is('category_id', null);
    } else {
      if (opts.statusFilter) q = q.eq('status', opts.statusFilter);
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

// ---------- Status legíveis (sem alterar valores gravados) ----------

export interface StatusLabel {
  label: string;
  hint: string;
}

export const STATUS_LABELS: Readonly<Record<string, StatusLabel>> = {
  posted: { label: 'Confirmada', hint: 'Confirmada: lançada e registrada.' },
  pending: { label: 'Pendente', hint: 'Pendente: aguardando confirmação.' },
  review: { label: 'Em revisão', hint: 'Em revisão: aguardando categoria.' },
  scheduled: {
    label: 'Agendada',
    hint: 'Agendada: transação prevista, ainda não confirmada como lançada.',
  },
  ignored: { label: 'Ignorada', hint: 'Ignorada: desconsiderada.' },
};

export function statusLabel(status: string | null | undefined): StatusLabel {
  if (status && STATUS_LABELS[status]) return STATUS_LABELS[status];
  return { label: status ?? '', hint: '' };
}
