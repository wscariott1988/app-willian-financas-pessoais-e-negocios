import React from 'react';
import { Eye, AlertCircle, RefreshCw, X, Pencil, ArrowLeftRight } from 'lucide-react';
import { useTransactionDetail, type TransactionDetailData } from '../hooks/useTransactionDetail';
import { displayPaymentStatus } from '../lib/status';
import { accountDisplayLabel } from '../lib/accountCrud';

interface TransactionDetailProps {
  transactionId: string;
  onClose: () => void;
  onEdit: (transactionId: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  expense: 'Despesa',
  income: 'Receita',
  transfer: 'Transferência',
};

function formatCurrency(val: string, kind: string): string {
  const num = parseFloat(val);
  const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
  return `${prefix} R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('T')[0].split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value && value !== 0) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', minWidth: 0 }}>
      <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 600, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

export const TransactionDetail: React.FC<TransactionDetailProps> = ({
  transactionId,
  onClose,
  onEdit,
}) => {
  const { data, loading, error, retry } = useTransactionDetail(transactionId, true);

  const handleEdit = () => {
    onEdit(transactionId);
  };

  return (
    <div className="glass" style={{ padding: 'clamp(16px, 4vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '480px', width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: 'rgba(14, 165, 233, 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Eye size={20} style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>Detalhes da transação</h3>
        </div>
        <button
          onClick={onClose}
          aria-label="Fechar detalhes"
          title="Fechar detalhes"
          style={{
            minWidth: '44px', minHeight: '44px', width: '44px', height: '44px',
            padding: 0, background: 'transparent', color: 'var(--color-text-muted)',
            borderRadius: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <X size={18} />
        </button>
      </div>

      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: 'var(--color-danger)',
          padding: '12px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4 }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={retry}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '13px', alignSelf: 'flex-start' }}
          >
            <RefreshCw size={14} /> Tentar novamente
          </button>
        </div>
      )}

      {loading && !error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
          <RefreshCw size={16} className="spin-animation" />
          Carregando detalhes...
        </div>
      )}

      {!loading && !error && data && (
        <TransactionDetailContent data={data} />
      )}

      {!loading && !error && !data && (
        <div style={{ padding: '16px', color: 'var(--color-text-muted)', fontSize: '13px', textAlign: 'center' }}>
          Nenhum dado encontrado.
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          style={{ flex: 1, padding: '12px' }}
        >
          Fechar
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleEdit}
          style={{ flex: 1, padding: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
          disabled={loading || !!error}
        >
          <Pencil size={14} /> Editar
        </button>
      </div>
    </div>
  );
};

function TransactionDetailContent({ data }: { data: TransactionDetailData }) {
  const t = data.transaction;
  const kind = (t.transaction_kind as string) || '';
  const amount = (t.amount as string) || '0';
  const status = (t.status as string) || 'posted';
  const occurredOn = ((t.occurred_on as string) || '').split('T')[0];
  const isTransfer = kind === 'transfer' && !!data.transfer;

  let toAccountName: string | null = null;
  if (isTransfer && data.transfer) {
    const tr = data.transfer;
    const isOut = t.id === tr.out_transaction_id;
    toAccountName = isOut
      ? accountDisplayLabel(tr.in_account as { display_name: string } | null)
      : accountDisplayLabel(tr.out_account as { display_name: string } | null);
  }

  const stLabel = displayPaymentStatus(status, occurredOn);

  return (
    <div style={{
      backgroundColor: 'rgba(13, 18, 34, 0.6)',
      border: '1px solid var(--border-card)',
      borderRadius: '8px', padding: '14px',
      fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <DetailRow label="Descrição" value={t.raw_description as string} />
      <DetailRow label="Tipo" value={KIND_LABEL[kind] || kind} />
      <DetailRow label="Valor" value={formatCurrency(amount, kind)} />
      <DetailRow label="Data" value={formatDate(occurredOn)} />
      {stLabel && <DetailRow label="Status" value={stLabel} />}
      <DetailRow label="Conta" value={accountDisplayLabel(t.accounts as { display_name: string } | null)} />
      {isTransfer && toAccountName && (
        <DetailRow label="Conta de destino" value={toAccountName} />
      )}
      <DetailRow label="Categoria" value={(t.categories as { display_name: string } | null)?.display_name || (t.category_raw as string) || null} />
      {(t.memo as string) && (
        <DetailRow label="Observação" value={t.memo as string} />
      )}

      {(data.series && data.series.series_id) && (
        <div style={{
          marginTop: '4px',
          padding: '8px 10px',
          backgroundColor: 'rgba(14, 165, 233, 0.06)',
          border: '1px solid rgba(14, 165, 233, 0.12)',
          borderRadius: '6px',
          fontSize: '12px',
          color: 'var(--color-primary)',
          display: 'flex', gap: '6px', alignItems: 'flex-start',
        }}>
          <ArrowLeftRight size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>
            Esta transação faz parte de uma série{data.series.kind ? ` (${data.series.kind === 'installment' ? 'Parcelada' : 'Recorrente'})` : ''}.
            Ocorrência {Number(data.series.occurrence_index) + 1}
            {data.series.total_occurrences != null ? ` de ${data.series.total_occurrences}` : ''}.
          </span>
        </div>
      )}
    </div>
  );
}
