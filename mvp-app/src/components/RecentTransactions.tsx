import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { RefreshCw, AlertCircle, Pencil, Trash2, ArrowRight, Layers } from 'lucide-react';
import { type TxClientLike } from '../lib/txList';
import { displayPaymentStatus } from '../lib/status';
import type { PeriodRange } from '../lib/period';

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

const MAX_RECENT = 5;

interface RecentTransactionsProps {
  profileId: string;
  range: PeriodRange;
  refreshTrigger: number;
  onEditTransaction: (tx: Transaction) => void;
  onDeleteTransaction: (tx: Transaction) => void;
  onNavigateToTransactions: () => void;
}

export const RecentTransactions: React.FC<RecentTransactionsProps> = ({
  profileId,
  range,
  refreshTrigger,
  onEditTransaction,
  onDeleteTransaction,
  onNavigateToTransactions,
}) => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await (supabase as TxClientLike)
        .from('transactions')
        .select('*, categories(display_name), accounts(display_name)', { count: 'exact' })
        .is('deleted_at', null)
        .gte('occurred_on', range.start)
        .lte('occurred_on', range.end)
        .order('occurred_on', { ascending: false })
        .order('created_at', { ascending: false })
        .range(0, MAX_RECENT - 1);

      if (fetchError) throw fetchError;
      setTransactions((data ?? []) as Transaction[]);
    } catch (err: unknown) {
      if (import.meta.env.DEV) console.error('[Erro técnico transações recentes]', err);
      setError('Não foi possível carregar as transações recentes.');
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }, [range.start, range.end, profileId, refreshTrigger]);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);

  const formatCurrency = (val: string, kind: string) => {
    const num = parseFloat(val);
    const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
    const color = kind === 'expense' ? 'var(--color-danger)' : kind === 'income' ? 'var(--color-success)' : 'var(--color-text)';
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
    <div className="recent-tx-section">
      <div className="recent-tx-header">
        <h2 className="recent-tx-title">Transações recentes</h2>
        <button
          type="button"
          className="recent-tx-view-all"
          onClick={onNavigateToTransactions}
          title="Ver todas as transações do período"
        >
          Ver todas
          <ArrowRight size={14} />
        </button>
      </div>

      {loading ? (
        <div className="recent-tx-empty">
          <RefreshCw size={18} className="spin-animation" />
          <span>Carregando...</span>
        </div>
      ) : error ? (
        <div className="recent-tx-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      ) : transactions.length === 0 ? (
        <div className="recent-tx-empty">
          <Layers size={18} style={{ opacity: 0.5 }} />
          <span>Nenhuma transação encontrada para o período selecionado.</span>
        </div>
      ) : (
        <div className="recent-tx-list">
          {transactions.map((tx) => {
            const catDisplay = (tx as any).categories?.display_name || tx.category_raw || 'Sem categoria';
            const stLabel = displayPaymentStatus(tx.status, tx.occurred_on);
            const txLabel = [
              tx.raw_description,
              `Data: ${formatDate(tx.occurred_on)}`,
              catDisplay,
              ...(stLabel ? [`Status: ${stLabel}`] : []),
            ].join(' · ');
            return (
              <div
                key={tx.id}
                className="recent-tx-row"
                title={txLabel}
                aria-label={txLabel}
              >
                <div className="recent-tx-info">
                  <span className="recent-tx-desc">{tx.raw_description}</span>
                  <span className="recent-tx-meta">
                    {formatDate(tx.occurred_on)} · {tx.accounts?.display_name || tx.account_id.slice(0, 8)} · {catDisplay}
                  </span>
                </div>
                <span className="recent-tx-value">
                  {formatCurrency(tx.amount, tx.transaction_kind)}
                </span>
                <div className="recent-tx-actions">
                  <button
                    type="button"
                    className="tx-edit-btn"
                    onClick={(e) => { e.stopPropagation(); onEditTransaction(tx); }}
                    aria-label={`Editar ${tx.raw_description}`}
                    title={`Editar ${tx.raw_description}`}
                    style={{ minWidth: '44px', minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="tx-edit-btn"
                    onClick={(e) => { e.stopPropagation(); onDeleteTransaction(tx); }}
                    aria-label={`Excluir ${tx.raw_description}`}
                    title={`Excluir ${tx.raw_description}`}
                    style={{ minWidth: '44px', minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-danger)' }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
