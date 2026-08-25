import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { Search, Landmark, AlertCircle, RefreshCw, Layers, ArrowUpDown, ArrowUp, ArrowDown, FilterX, SlidersHorizontal, Pencil, Trash2 } from 'lucide-react';
import { buildAccountQuery, mapAccountPeriods, type AccountPeriodRow } from '../lib/accountQuery';
import { displayPaymentStatus } from '../lib/status';
import { StatusBadge } from './StatusBadge';
import {
  TX_PAGE_SIZE,
  buildPendingTxOptions,
  buildTxListOptions,
  clearTxFilters,
  createTxPageFetcher,
  fetchAllTxPages,
  hasActiveTxFilters,
  type PendingFilter,
  type TxListFilters,
} from '../lib/txList';

interface Account {
  id: string;
  display_name: string;
  source_name: string;
}

export interface Transaction {
  id: string;
  profile_id: string;
  account_id: string;
  category_id: string | null;
  transaction_kind: 'income' | 'expense' | 'transfer';
  amount: string;
  occurred_on: string;
  raw_description: string;
  normalized_description: string;
  category_raw: string | null;
  status: 'posted' | 'pending' | 'review' | 'scheduled' | 'ignored';
  categories: { display_name: string } | null;
  accounts: { display_name: string } | null;
}

export type SortField = 'occurred_on' | 'amount' | 'raw_description' | 'created_at';
export type SortDir = 'asc' | 'desc';

interface TransactionListProps {
  profileId: string;
  selectedTransactionId: string | null;
  onSelectTransaction: (transaction: Transaction) => void;
  refreshTrigger: number;
  search: string;
  onSearchChange: (v: string) => void;
  selectedAccount: string;
  onAccountChange: (v: string) => void;
  startDate: string;
  onStartDateChange: (v: string) => void;
  endDate: string;
  onEndDateChange: (v: string) => void;
  filterNoCategory: boolean;
  onFilterNoCategoryChange: (v: boolean) => void;
  filterUnpaidOnly: boolean;
  onFilterUnpaidOnlyChange: (v: boolean) => void;
  mode?: 'period' | 'pending';
  pendingFilter?: PendingFilter;
  onPendingCountChange?: (count: number) => void;
  onEditTransaction?: (transaction: Transaction) => void;
  onDeleteTransaction?: (transaction: Transaction) => void;
}

// Lote do modo Pendências: adequado à interface, carregado progressivamente.
const PENDING_PAGE_SIZE = 30;

// Erros técnicos não vão para a interface; detalhes somente no console DEV.
function friendlyListError(err: unknown): string {
  if (import.meta.env.DEV) console.error('[Erro técnico da lista]', err);
  return 'Não foi possível carregar as transações. Tente novamente em instantes.';
}

export const TransactionList: React.FC<TransactionListProps> = ({
  profileId,
  selectedTransactionId,
  onSelectTransaction,
  refreshTrigger,
  search,
  onSearchChange,
  selectedAccount,
  onAccountChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  filterNoCategory,
  onFilterNoCategoryChange,
  filterUnpaidOnly,
  onFilterUnpaidOnlyChange,
  mode = 'period',
  pendingFilter = 'all',
  onPendingCountChange,
  onEditTransaction,
  onDeleteTransaction,
}) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalLoaded, setTotalLoaded] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Modo Pendências: paginação progressiva por lotes (nunca todo o histórico).
  const [pendingTxns, setPendingTxns] = useState<Transaction[]>([]);
  const [pendingOffset, setPendingOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const isPending = mode === 'pending';

  // Sorting
  const [sortField, setSortField] = useState<SortField>('occurred_on');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const { data, error: accError } = await buildAccountQuery(supabase as any, profileId);
        if (accError) throw accError;
        setAccounts(mapAccountPeriods((data ?? []) as AccountPeriodRow[]));
      } catch (err: any) {
        console.error('Erro ao buscar contas:', err);
      }
    };
    fetchAccounts();
  }, [profileId]);

  // Lista contínua do período: busca todas as páginas do recorte (perfil via RLS,
  // período, busca, conta e filtros atuais), sem paginação visível.
  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    const opts = buildTxListOptions(
      { unpaidOnly: filterUnpaidOnly, noCategory: filterNoCategory } satisfies TxListFilters,
      { search, accountId: selectedAccount, start: startDate, end: endDate },
    );
    const fetcher = createTxPageFetcher(supabase as any, opts);
    try {
      const { rows, totalCount } = await fetchAllTxPages(fetcher, TX_PAGE_SIZE);
      setTransactions(rows as unknown as Transaction[]);
      setTotalLoaded(totalCount);
    } catch (err: any) {
      // Lote falhou: nunca apresentar parcial como completo.
      setError(friendlyListError(err));
      setTransactions([]);
      setTotalLoaded(0);
    } finally {
      setLoading(false);
    }
  }, [search, selectedAccount, startDate, endDate, filterNoCategory, filterUnpaidOnly, profileId, refreshTrigger]);

  // Modo Pendências: carrega um lote por vez (offset), substituindo ou anexando.
  const loadPendingPage = useCallback(async (offset: number, replace: boolean) => {
    if (!replace) setLoadingMore(true);
    try {
      const opts = buildPendingTxOptions({ search, accountId: selectedAccount, pendingFilter });
      const fetcher = createTxPageFetcher(supabase as any, opts);
      const page = await fetcher(offset, offset + PENDING_PAGE_SIZE - 1);
      if (page.error) throw page.error;
      const rows = (page.rows ?? []) as Transaction[];
      setPendingTxns((prev) => (replace ? rows : [...prev, ...rows]));
      setPendingOffset(offset + rows.length);
      setHasMore(rows.length === PENDING_PAGE_SIZE);
      if (page.totalCount !== null) {
        setTotalLoaded(page.totalCount);
        onPendingCountChange?.(page.totalCount);
      }
    } catch (err) {
      setError(friendlyListError(err));
    } finally {
      if (!replace) setLoadingMore(false);
      setLoading(false);
    }
  }, [search, selectedAccount, pendingFilter, profileId, onPendingCountChange, refreshTrigger]);

  useEffect(() => {
    if (isPending) {
      setError(null);
      setLoading(true);
      setPendingTxns([]);
      loadPendingPage(0, true);
    } else {
      fetchTransactions();
    }
  }, [isPending, loadPendingPage, fetchTransactions, refreshTrigger]);

  // Próximo lote progressivo quando o sentinel entra na área visível.
  useEffect(() => {
    if (!isPending || !hasMore || loading || loadingMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          loadPendingPage(pendingOffset, false);
        }
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isPending, hasMore, loading, loadingMore, pendingOffset, loadPendingPage]);

  const filters: TxListFilters = { unpaidOnly: filterUnpaidOnly, noCategory: filterNoCategory };
  const filtersActive = hasActiveTxFilters(filters);
  const activeFilterCount = (filterUnpaidOnly ? 1 : 0) + (filterNoCategory ? 1 : 0);

  const handleClearFilters = () => {
    const cleared = clearTxFilters();
    onFilterUnpaidOnlyChange(cleared.unpaidOnly);
    onFilterNoCategoryChange(cleared.noCategory);
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'raw_description' ? 'asc' : 'desc');
    }
  };

  const SortHeader: React.FC<{ field: SortField; children: React.ReactNode }> = ({ field, children }) => (
    <th
      onClick={() => toggleSort(field)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      title="Clique para ordenar"
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        {children}
        {sortField === field ? (
          sortDir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />
        ) : (
          <ArrowUpDown size={13} style={{ opacity: 0.35 }} />
        )}
      </span>
    </th>
  );

  const formatCurrency = (val: string, kind: string) => {
    const num = parseFloat(val);
    const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
    const color = kind === 'expense' ? 'var(--color-danger)' : kind === 'income' ? 'var(--color-success)' : 'white';

    return (
      <span style={{ color, fontWeight: 700 }}>
        {prefix} R$ {num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const parts = dateStr.split('T')[0].split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  };

  // Formato curto dd/mm — usado somente em larguras com espaço restrito
  const formatDateShort = (dateStr: string) => {
    const full = formatDate(dateStr);
    return full.length >= 5 ? full.slice(0, 5) : full;
  };

  return (
    <div className={`tx-list ${isPending ? 'tx-list-pending' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%' }}>
      <div className="glass tx-toolbar">
        <div className="tx-toolbar-row">
          <div className="tx-search" style={{ position: 'relative' }}>
            <Search size={18} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              placeholder="Buscar descrição..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              style={{ width: '100%', paddingLeft: '38px' }}
            />
          </div>

          <div className="tx-account-select" style={{ flex: '1 1 170px', position: 'relative' }}>
            <Landmark size={18} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
            <select
              value={selectedAccount}
              onChange={(e) => onAccountChange(e.target.value)}
              style={{ width: '100%', paddingLeft: '38px', appearance: 'none' }}
            >
              <option value="">Todas as contas</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.display_name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="tx-filters-btn"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
            title="Filtros de status e categoria"
          >
            <SlidersHorizontal size={16} />
            Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
        </div>

        {!isPending && (
          <div className="tx-count-line">
            <strong style={{ color: 'var(--color-text)' }}>{totalLoaded.toLocaleString('pt-BR')}</strong>
            &nbsp;transações no período
          </div>
        )}

        <div className={`tx-filters-panel ${filtersOpen ? 'open' : ''}`}>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px', fontWeight: 600 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filterUnpaidOnly}
                onChange={(e) => onFilterUnpaidOnlyChange(e.target.checked)}
                style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              />
              <span>Não pagos</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filterNoCategory}
                onChange={(e) => onFilterNoCategoryChange(e.target.checked)}
                style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              />
              <span>Sem categoria</span>
            </label>

            {filtersActive && (
              <button
                className="btn-secondary"
                onClick={handleClearFilters}
                style={{ padding: '6px 12px', fontSize: '12px' }}
                title="Remove os filtros de status e categoria (mantém mês, período, busca e conta)"
              >
                <FilterX size={14} />
                Limpar filtros
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="glass" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: '400px' }}>
        <div style={{ overflowX: 'auto', flex: 1 }}>
          <table className="tx-table">
            <thead>
              <tr>
                <SortHeader field="occurred_on">Data</SortHeader>
                <SortHeader field="raw_description">Descrição Original</SortHeader>
                <SortHeader field="amount">Valor</SortHeader>
                <th>Conta</th>
                <th>Categoria</th>
                <th>Status</th>
                <th style={{ width: '96px', textAlign: 'center' }} aria-label="Ações">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-text-muted)' }}>
                    <RefreshCw size={24} className="spin-animation" style={{ marginBottom: '8px' }} />
                    <div>Buscando transações do período...</div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-danger)' }}>
                    <AlertCircle size={24} style={{ marginBottom: '8px' }} />
                    <div>{error}</div>
                    <div style={{ fontSize: '12px', marginTop: '6px' }}>
                      A lista não foi exibida para evitar resultado parcial.
                    </div>
                  </td>
                </tr>
              ) : (isPending ? pendingTxns : transactions).length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-text-muted)' }}>
                    <Layers size={24} style={{ marginBottom: '8px', opacity: 0.5 }} />
                    <div>{isPending ? 'Nenhuma pendência encontrada para os filtros selecionados.' : 'Nenhuma transação encontrada para os filtros selecionados.'}</div>
                  </td>
                </tr>
              ) : (
                (isPending ? pendingTxns : transactions).map((tx) => {
                  const stLabel = displayPaymentStatus(tx.status, tx.occurred_on);
                  const catDisplay = (tx as any).categories?.display_name || tx.category_raw || 'Não informada';
                  const txLabel = [
                    tx.raw_description,
                    `Data: ${formatDate(tx.occurred_on)}`,
                    `Categoria: ${catDisplay}`,
                    `Conta: ${tx.accounts?.display_name || tx.account_id.slice(0, 8)}`,
                    ...(stLabel ? [`Status: ${stLabel}`] : []),
                  ].join(' · ');
                  return (
                    <tr
                      key={tx.id}
                      className={`tx-row ${selectedTransactionId === tx.id ? 'selected' : ''}`}
                      onClick={() => onSelectTransaction(tx)}
                      title={txLabel}
                      aria-label={txLabel}
                    >
                      <td data-label="Data" className="tx-date">
                        <span className="tx-date-full">{formatDate(tx.occurred_on)}</span>
                        <span className="tx-date-short" aria-hidden="true">{formatDateShort(tx.occurred_on)}</span>
                      </td>
                      <td data-label="Descrição" className="tx-desc">
                        {tx.raw_description}
                      </td>
                      <td data-label="Valor" className="tx-value">{formatCurrency(tx.amount, tx.transaction_kind)}</td>
                      <td data-label="Conta" className="tx-account">{tx.accounts?.display_name || tx.account_id.slice(0, 8)}</td>
                      <td data-label="Categoria" className="tx-cat">
                        {catDisplay}
                      </td>
                      <td data-label="Status" className="tx-status">
                        <StatusBadge status={tx.status} occurredOn={tx.occurred_on} />
                      </td>
                      <td data-label="Ações" className="tx-edit-cell" style={{ display: 'flex', gap: '2px', justifyContent: 'center', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="tx-edit-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditTransaction?.(tx);
                          }}
                          aria-label={`Editar ${tx.raw_description}`}
                          title={`Editar ${tx.raw_description}`}
                          style={{ minWidth: '44px', minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="tx-edit-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteTransaction?.(tx);
                          }}
                          aria-label={`Excluir ${tx.raw_description}`}
                          title={`Excluir ${tx.raw_description}`}
                          style={{ minWidth: '44px', minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-danger)' }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Modo Pendências: sentinel de próximo lote + estados de fim/carregando */}
        {isPending && !loading && !error && (isPending ? pendingTxns : transactions).length > 0 && (
          <div
            ref={sentinelRef}
            style={{
              padding: '10px 20px',
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              textAlign: 'center',
              borderTop: '1px solid var(--border-card)',
            }}
          >
            {loadingMore ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <RefreshCw size={13} className="spin-animation" /> Carregando mais...
              </span>
            ) : !hasMore ? (
              <span>Fim da lista</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};
