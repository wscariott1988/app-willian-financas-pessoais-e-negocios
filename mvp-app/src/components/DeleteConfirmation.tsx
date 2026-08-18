import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { Trash2, AlertCircle, RefreshCw, ArrowLeftRight } from 'lucide-react';
import { formatAmountForInput } from './TransactionEditor';

export interface DeleteTarget {
  id: string;
  raw_description: string;
  occurred_on: string;
  amount: string;
  transaction_kind: string;
  accounts?: { display_name: string } | null;
  account_id: string;
}

interface DeleteConfirmationProps {
  transaction: DeleteTarget;
  onClose: () => void;
  onSuccess: () => void;
}

export function formatTxDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('T')[0].split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatTxCurrency(val: string, kind: string): string {
  const num = parseFloat(val);
  const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
  return `${prefix} R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const DeleteConfirmation: React.FC<DeleteConfirmationProps> = ({
  transaction: tx,
  onClose,
  onSuccess,
}) => {
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);
  const [isTransfer, setIsTransfer] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error: rpcError } = await supabase.rpc('transaction_get_detail', {
          transaction_id: tx.id,
        });
        if (rpcError) throw rpcError;
        if (cancelled || !data?.transaction) return;
        setExpectedUpdatedAt(data.transaction.updated_at || null);
        setIsTransfer(data.transaction.transaction_kind === 'transfer' && !!data.transfer);
      } catch (err: any) {
        console.error('Erro ao carregar detalhe para exclusao:', err);
        if (!cancelled) setError(err.message || 'Falha ao carregar detalhes da transacao.');
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [tx.id]);

  const handleConfirm = async () => {
    if (!expectedUpdatedAt) return;
    setDeleting(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('transaction_delete', {
        p_transaction_id: tx.id,
        p_expected_updated_at: expectedUpdatedAt,
      });
      if (rpcError) {
        const msg = String(rpcError.message || rpcError);
        if (msg.includes('CONFLITO')) {
          setError('Conflito: a transacao foi modificada por outra operacao. Recarregue a lista e tente novamente.');
        } else {
          setError(msg || 'Erro ao excluir a transacao.');
        }
        if (mounted.current) setDeleting(false);
        return;
      }
      if (mounted.current) onSuccess();
    } catch (err: any) {
      console.error('Erro ao excluir transacao:', err);
      if (mounted.current) {
        setError(String(err.message || 'Erro ao excluir a transacao.'));
        setDeleting(false);
      }
    }
  };

  const accountName = tx.accounts?.display_name || tx.account_id.slice(0, 8);

  return (
    <div className="glass" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '480px', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: 'rgba(239, 68, 68, 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Trash2 size={20} style={{ color: 'var(--color-danger)' }} />
        </div>
        <div>
          <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>Excluir transacao</h3>
          <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: 0 }}>
            Esta acao nao pode ser desfeita.
          </p>
        </div>
      </div>

      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: 'var(--color-danger)',
          padding: '12px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{error}</span>
        </div>
      )}

      {loadingDetail ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
          <RefreshCw size={16} className="spin-animation" />
          Carregando detalhes...
        </div>
      ) : (
        <div style={{
          backgroundColor: 'rgba(13, 18, 34, 0.6)',
          border: '1px solid var(--border-card)',
          borderRadius: '8px', padding: '14px',
          fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>Descricao</span>
            <span style={{ fontWeight: 600, textAlign: 'right', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.raw_description}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>Data</span>
            <span style={{ fontWeight: 600 }}>{formatTxDate(tx.occurred_on)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>Valor</span>
            <span style={{ fontWeight: 700 }}>{formatTxCurrency(tx.amount, tx.transaction_kind)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>Conta</span>
            <span style={{ fontWeight: 600 }}>{accountName}</span>
          </div>
        </div>
      )}

      {isTransfer && (
        <div style={{
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.15)',
          borderRadius: '8px', padding: '12px 14px',
          color: 'var(--color-secondary)', fontSize: '12px',
          display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
        }}>
          <ArrowLeftRight size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>Transferencia: ambas as pontas (saida e entrada) e o vinculo serao excluidos.</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          style={{ flex: 1, padding: '12px' }}
          disabled={deleting}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleConfirm}
          style={{ flex: 1, padding: '12px', backgroundColor: 'var(--color-danger)', border: 'none' }}
          disabled={loadingDetail || deleting || !expectedUpdatedAt}
        >
          {deleting ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <RefreshCw size={14} className="spin-animation" /> Excluindo...
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <Trash2 size={14} /> Excluir
            </span>
          )}
        </button>
      </div>
    </div>
  );
};
