import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { RecentTransactions } from './RecentTransactions';
import { TransactionEditor } from './TransactionEditor';
import { DeleteConfirmation } from './DeleteConfirmation';
import { Modal } from './Modal';
import { PeriodSelector } from './PeriodSelector';
import { TrendingUp, TrendingDown, Wallet, AlertTriangle, Tag, RefreshCw, Landmark, Server, AlertCircle, Plus } from 'lucide-react';
import { fetchPeriodSummary } from '../lib/summary';
import { NON_PAID_STATUSES, STATUS_EDITABLE_FROM } from '../lib/status';
import type { PeriodController } from './AppShell';

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

interface DashboardProps {
  profileId: string;
  profileCode?: 'personal' | 'business';
  period: PeriodController;
  onOpenPending?: (filter: 'unpaid' | 'noCategory') => void;
  onNavigateToTransactions?: () => void;
}

interface EditorState {
  tx: Transaction | null;
  creating: boolean;
}

interface Summary {
  income: number;
  expense: number;
  balance: number;
  unpaidCount: number;
  noCategoryCount: number;
  totalCount: number;
  loading: boolean;
  error: string | null;
}

export const Dashboard: React.FC<DashboardProps> = ({ profileId, profileCode = 'personal', period, onOpenPending, onNavigateToTransactions }) => {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const [summary, setSummary] = useState<Summary>({
    income: 0, expense: 0, balance: 0, unpaidCount: 0, noCategoryCount: 0, totalCount: 0, loading: true, error: null,
  });

  const { range } = period;

  const fetchSummary = useCallback(async () => {
    setSummary((s) => ({ ...s, loading: true, error: null }));
    try {
      const periodSummary = await fetchPeriodSummary(range);

      const counters = await supabaseCounters();
      let unpaidCount = 0;
      let noCategoryCount = 0;
      if (counters) {
        unpaidCount = counters.unpaidCount;
        noCategoryCount = counters.noCategoryCount;
      }

      setSummary({
        income: periodSummary.income,
        expense: periodSummary.expense,
        balance: periodSummary.balance,
        unpaidCount,
        noCategoryCount,
        totalCount: periodSummary.totalCount,
        loading: false,
        error: null,
      });
    } catch (err: any) {
      console.error('Erro ao carregar resumo financeiro:', err);
      setSummary((s) => ({ ...s, loading: false, error: err.message || 'Erro ao consultar o resumo do período.' }));
    }
  }, [range]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshTrigger]);

  const handleEditorSuccess = () => {
    setEditor(null);
    setRefreshTrigger((t) => t + 1);
  };

  const handleCloseEditor = () => setEditor(null);

  const handleNewTransaction = () => setEditor({ tx: null, creating: true });

  const handleEditTransaction = (tx: Transaction) => {
    setEditor({ tx, creating: false });
  };

  const handleDeleteTransaction = (tx: Transaction) => {
    setDeleteTarget(tx);
  };

  const handleDeleteSuccess = () => {
    setDeleteTarget(null);
    setRefreshTrigger((t) => t + 1);
  };

  const handleCloseDelete = () => setDeleteTarget(null);

  const formatBRL = (val: number) =>
    val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const isProd = import.meta.env.PROD;
  const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const gatewayLabel = rawUrl.replace(/^https?:\/\//, '') || (isProd ? 'Supabase Cloud' : 'Gateway local');

  const summaryLoading = summary.loading ? (
    <div className="stat-card-value" style={{ color: 'var(--color-text-muted)', fontSize: '14px', fontWeight: 500 }}>
      <RefreshCw size={14} className="spin-animation" /> calculando...
    </div>
  ) : null;

  return (
    <div className="dash-root">
      <div className="dash-title">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
              Visão Geral
            </h1>
            <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
              Resumo e transações do período selecionado para o perfil ativo
            </p>
          </div>
          <button
            type="button"
            className="btn-primary tx-new-button"
            onClick={handleNewTransaction}
            aria-label="Nova transação"
            title="Nova transação"
          >
            <Plus size={16} />
            Nova transação
          </button>
        </div>
      </div>

      <PeriodSelector
        selection={period.selection}
        mode={period.mode}
        range={period.range}
        onSelectionChange={period.onSelectionChange}
        onModeChange={period.onModeChange}
        onPickerOpen={period.onPickerOpen}
        onCustomReset={period.onCustomReset}
      />

      {/* Resumo real do período. Resultado = receitas − despesas (não é saldo). */}
      <div className="summary-grid">
        <div className="stat-card">
          <span className="stat-card-label" style={{ color: 'var(--color-success)' }}>
            <TrendingUp size={14} /> Receitas
          </span>
          {summaryLoading ?? (
            <span className="stat-card-value" style={{ color: 'var(--color-success)' }}>
              {formatBRL(summary.income)}
            </span>
          )}
        </div>

        <div className="stat-card">
          <span className="stat-card-label" style={{ color: 'var(--color-danger)' }}>
            <TrendingDown size={14} /> Despesas
          </span>
          {summaryLoading ?? (
            <span className="stat-card-value" style={{ color: 'var(--color-danger)' }}>
              {formatBRL(summary.expense)}
            </span>
          )}
        </div>

        <div className="stat-card stat-result">
          <span className="stat-card-label">
            <Wallet size={14} /> Resultado do período
          </span>
          {summaryLoading ?? (
            <span
              className="stat-card-value"
              style={{ color: summary.balance >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
            >
              {summary.balance >= 0 ? '+' : ''}
              {formatBRL(summary.balance)}
            </span>
          )}
        </div>
      </div>

      {/* Pendências: painel único com duas linhas acionáveis (STATUS-P0b) */}
      <div className="pending-panel">
        <div className="pending-title">Pendências</div>
        <button
          type="button"
          className="pending-row"
          aria-pressed={false}
          onClick={() => onOpenPending?.('unpaid')}
          title="Abre Transações na fila de não pagos (a partir de 01/08/2026)"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} style={{ color: 'var(--color-warning)' }} />
            Não pagos
          </span>
          <span className="pending-title-hint">· A partir de 01/08/2026</span>
          <span className="pending-row-count">{summary.unpaidCount.toLocaleString('pt-BR')}</span>
        </button>
        <button
          type="button"
          className="pending-row"
          aria-pressed={false}
          onClick={() => onOpenPending?.('noCategory')}
          title="Abre Transações na fila global de pendências sem categoria"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <Tag size={16} style={{ color: 'var(--color-secondary)' }} />
            Sem categoria
          </span>
          <span className="pending-title-hint">· Todo o histórico</span>
          <span className="pending-row-count">{summary.noCategoryCount.toLocaleString('pt-BR')}</span>
        </button>
      </div>

      {/* Limpar filtros, erro de consulta e ambiente (compactos) */}
      <div className="dash-env">
        {summary.error && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            backgroundColor: 'rgba(255, 180, 171, 0.1)',
            border: '1px solid rgba(255, 180, 171, 0.2)',
            color: 'var(--color-error)',
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{summary.error}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {import.meta.env.DEV ? (
            <>
              <span className="badge badge-pending"><Landmark size={12} /> Supabase Local (PGLite)</span>
              <span className="badge"><Server size={12} /> {gatewayLabel}</span>
            </>
          ) : (
            <span className="badge badge-pending"><Landmark size={12} /> Supabase Cloud</span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            {summary.totalCount.toLocaleString('pt-BR')} transações no recorte
          </span>
        </div>
      </div>

      {/* Área operacional: transações recentes */}
      <div className="dash-main">
        <RecentTransactions
          profileId={profileId}
          range={range}
          refreshTrigger={refreshTrigger}
          onEditTransaction={handleEditTransaction}
          onDeleteTransaction={handleDeleteTransaction}
          onNavigateToTransactions={() => onNavigateToTransactions?.()}
        />
      </div>

      <Modal
        open={!!editor}
        onClose={handleCloseEditor}
        ariaLabel={editor?.creating ? 'Nova transação' : 'Editar transação'}
      >
        {editor && (
          <TransactionEditor
            profileId={profileId}
            profileCode={profileCode}
            transaction={editor.tx}
            creating={editor.creating}
            onSuccess={handleEditorSuccess}
            onClose={handleCloseEditor}
          />
        )}
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={handleCloseDelete}
        ariaLabel="Confirmar exclusao"
      >
        {deleteTarget && (
          <DeleteConfirmation
            transaction={deleteTarget}
            onClose={handleCloseDelete}
            onSuccess={handleDeleteSuccess}
          />
        )}
      </Modal>

      <button
        type="button"
        className="tx-fab"
        onClick={handleNewTransaction}
        aria-label="Nova transação"
        title="Nova transação"
      >
        <Plus size={24} />
      </button>
    </div>
  );
};

// Contadores de pendências (STATUS-P0b): "Não pagos" = status ativos não-posted
// a partir do cutoff (nunca review do histórico); "Sem categoria" = todo o histórico.
async function supabaseCounters() {
  try {
    const [unpaid, noCategory] = await Promise.all([
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .in('status', NON_PAID_STATUSES)
        .gte('occurred_on', STATUS_EDITABLE_FROM),
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .is('category_id', null),
    ]);
    return { unpaidCount: unpaid.count ?? 0, noCategoryCount: noCategory.count ?? 0 };
  } catch (err) {
    console.error('Erro ao carregar contadores de pendências:', err);
    return null;
  }
}
