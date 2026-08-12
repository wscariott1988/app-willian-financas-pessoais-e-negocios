import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { Search, Calendar, Landmark, AlertCircle, RefreshCw, Layers, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { formatShortDate } from '../lib/period';

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

  // Sorting
  const [sortField, setSortField] = useState<SortField>('occurred_on');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Pagination
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 10;

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

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('transactions')
        .select('*, categories(display_name), accounts(display_name)', { count: 'exact' });

      if (search.trim()) {
        query = query.ilike('raw_description', `%${search}%`);
      }
      if (selectedAccount) {
        query = query.eq('account_id', selectedAccount);
      }
      if (startDate) {
        query = query.gte('occurred_on', startDate);
      }
      if (endDate) {
        query = query.lte('occurred_on', endDate);
      }
      if (filterNoCategory) {
        query = query.is('category_id', null);
      }
      if (filterReviewOnly) {
        query = query.eq('status', 'review');
      }

      const from = (page - 1) * limit;
      const to = from + limit - 1;

      const { data, error: txError, count } = await query
        .order(sortField, { ascending: sortDir === 'asc' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (txError) throw txError;

      setTransactions(data || []);
      setTotalCount(count || 0);
    } catch (err: any) {
      setError(err.message || 'Erro ao carregar transações');
    } finally {
      setLoading(false);
    }
  }, [search, selectedAccount, startDate, endDate, filterNoCategory, filterReviewOnly, profileId, refreshTrigger, page, sortField, sortDir]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  useEffect(() => {
    setPage(1);
  }, [search, selectedAccount, startDate, endDate, filterNoCategory, filterReviewOnly, sortField, sortDir, profileId]);

  const totalPages = Math.ceil(totalCount / limit) || 1;

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

        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', fontSize: '13px', fontWeight: 600 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filterReviewOnly}
              onChange={(e) => onFilterReviewOnlyChange(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span>Somente fila de revisão (status = review)</span>
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
                    <div>Buscando transações do banco...</div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '60px', color: 'var(--color-danger)' }}>
                    <AlertCircle size={24} style={{ marginBottom: '8px' }} />
                    <div>{error}</div>
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
                transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className={`tx-row ${selectedTransactionId === tx.id ? 'selected' : ''}`}
                    onClick={() => onSelectTransaction(tx)}
                  >
                    <td>{formatDate(tx.occurred_on)}</td>
                    <td style={{ fontWeight: 600 }}>
                      {tx.raw_description}
                    </td>
                    <td>{formatCurrency(tx.amount, tx.transaction_kind)}</td>
                    <td>{tx.accounts?.display_name || tx.account_id.slice(0, 8)}</td>
                    <td style={{ fontStyle: 'italic', color: 'var(--color-text-muted)' }}>
                      {tx.category_raw || 'Não informada'}
                    </td>
                    <td>
                      <span className={`badge badge-${tx.status}`}>
                        {tx.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && !error && transactions.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderTop: '1px solid var(--border-card)',
            fontSize: '13px',
            color: 'var(--color-text-muted)'
          }}>
            <div>
              Exibindo <strong>{transactions.length}</strong> de <strong>{totalCount.toLocaleString('pt-BR')}</strong> transações
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                className="btn-secondary"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                Anterior
              </button>

              <span style={{ padding: '0 8px' }}>
                Página <strong>{page}</strong> de {totalPages}
              </span>

              <button
                className="btn-secondary"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                Próxima
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
