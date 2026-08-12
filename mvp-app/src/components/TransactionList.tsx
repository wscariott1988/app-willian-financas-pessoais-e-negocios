import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { Search, Calendar, Landmark, AlertCircle, RefreshCw, Layers, ArrowUpDown, ArrowUp, ArrowDown, FilterX } from 'lucide-react';
import { formatShortDate } from '../lib/period';
import {
  TX_PAGE_SIZE,
  buildTxListOptions,
  clearTxFilters,
  createTxPageFetcher,
  fetchAllTxPages,
  hasActiveTxFilters,
  statusLabel,
  type TxListFilters,
} from '../lib/txList';

interface Account {
  id: string;
  display_name: string;
  source_name: string;
}

interface Transaction {
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
  filterReviewOnly: boolean;
  onFilterReviewOnlyChange: (v: boolean) => void;
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
  filterReviewOnly,
  onFilterReviewOnlyChange,
}) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalLoaded, setTotalLoaded] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Sorting
  const [sortField, setSortField] = useState<SortField>('occurred_on');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const { data, error: accError } = await supabase
          .from('accounts')
          .select('id, display_name, source_name');
        if (accError) throw accError;
        setAccounts(data || []);
      } catch (err: any) {
        console.error('Erro ao buscar contas:', err);
      }
    };
    fetchAccounts();
  }, [profileId]);

  // Lista contínua: busca TODAS as páginas do recorte (perfil via RLS, período,
  // busca, conta e filtros atuais), sem paginação visível.
  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    const opts = buildTxListOptions(
      { reviewOnly: filterReviewOnly, noCategory: filterNoCategory } satisfies TxListFilters,
      { search, accountId: selectedAccount, start: startDate, end: endDate },
    );
    const fetcher = createTxPageFetcher(supabase as any, opts);
    try {
      const { rows, totalCount } = await fetchAllTxPages(fetcher, TX_PAGE_SIZE);
      setTransactions(rows as unknown as Transaction[]);
      setTotalLoaded(totalCount);
    } catch (err: any) {
      // Lote falhou: nunca apresentar parcial como completo.
      setError(err.message || 'Erro ao carregar transações');
      setTransactions([]);
      setTotalLoaded(0);
    } finally {
      setLoading(false);
    }
  }, [search, selectedAccount, startDate, endDate, filterNoCategory, filterReviewOnly, profileId, refreshTrigger]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const filters: TxListFilters = { reviewOnly: filterReviewOnly, noCategory: filterNoCategory };
  const filtersActive = hasActiveTxFilters(filters);

  const handleClearFilters = () => {
    const cleared = clearTxFilters();
    onFilterReviewOnlyChange(cleared.reviewOnly);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
      <div className="glass" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ flex: '1 1 250px', position: 'relative' }}>
            <Search size={18} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              placeholder="Buscar descrição original..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              style={{ width: '100%', paddingLeft: '38px' }}
            />
          </div>

          <div style={{ flex: '1 1 180px', position: 'relative' }}>
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

          <div className="range-badge" title="Intervalo de datas aplicado pelo seletor global de período">
            <Calendar size={18} style={{ color: 'var(--color-primary)' }} />
            <span>
              {startDate && endDate
                ? `${formatShortDate(startDate)} → ${formatShortDate(endDate)}`
                : 'Período completo'}
            </span>
          </div>
        </div>

        {/* Filtros avançados: recolhíveis no mobile, sempre visíveis no desktop */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            type="button"
            className="tx-filters-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? 'Ocultar' : 'Mostrar'} filtros avançados
            <span aria-hidden="true">{advancedOpen ? '▲' : '▼'}</span>
          </button>

          <div className={`tx-filters-extra ${advancedOpen ? 'open' : ''}`}>
            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px', fontWeight: 600 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={filterReviewOnly}
                  onChange={(e) => onFilterReviewOnlyChange(e.target.checked)}
                  style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                />
                <span>Somente em revisão (status = review)</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={filterNoCategory}
                  onChange={(e) => onFilterNoCategoryChange(e.target.checked)}
                  style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                />
                <span>Sem categoria (category_id = null)</span>
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
                <th>Categ. Original</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-text-muted)' }}>
                    <RefreshCw size={24} className="spin-animation" style={{ marginBottom: '8px' }} />
                    <div>Buscando transações do período...</div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-danger)' }}>
                    <AlertCircle size={24} style={{ marginBottom: '8px' }} />
                    <div>{error}</div>
                    <div style={{ fontSize: '12px', marginTop: '6px' }}>
                      A lista não foi exibida para evitar resultado parcial.
                    </div>
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-text-muted)' }}>
                    <Layers size={24} style={{ marginBottom: '8px', opacity: 0.5 }} />
                    <div>Nenhuma transação encontrada para os filtros selecionados.</div>
                  </td>
                </tr>
              ) : (
                transactions.map((tx) => {
                  const st = statusLabel(tx.status);
                  return (
                    <tr
                      key={tx.id}
                      className={`tx-row ${selectedTransactionId === tx.id ? 'selected' : ''}`}
                      onClick={() => onSelectTransaction(tx)}
                    >
                      <td data-label="Data">{formatDate(tx.occurred_on)}</td>
                      <td data-label="Descrição" className="tx-desc">
                        {tx.raw_description}
                      </td>
                      <td data-label="Valor" className="tx-value">{formatCurrency(tx.amount, tx.transaction_kind)}</td>
                      <td data-label="Conta">{tx.accounts?.display_name || tx.account_id.slice(0, 8)}</td>
                      <td data-label="Categoria" className="tx-cat">
                        {tx.category_raw || 'Não informada'}
                      </td>
                      <td data-label="Status">
                        <span className={`badge badge-${tx.status}`} title={st.hint}>
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && !error && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '14px 20px',
            borderTop: '1px solid var(--border-card)',
            fontSize: '13px',
            color: 'var(--color-text-muted)'
          }}>
            <strong style={{ color: '#f8fafc' }}>{totalLoaded.toLocaleString('pt-BR')}</strong>
            <span>&nbsp;transações no período</span>
          </div>
        )}
      </div>
    </div>
  );
};
