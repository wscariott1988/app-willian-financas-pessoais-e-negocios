import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X, Plus } from 'lucide-react';
import { TransactionList, type Transaction } from '../components/TransactionList';
import { TransactionEditor } from '../components/TransactionEditor';
import { DeleteConfirmation } from '../components/DeleteConfirmation';
import { Modal } from '../components/Modal';
import { PeriodSelector } from '../components/PeriodSelector';
import { addMonths, formatMonthLabel, PERIOD_MODES } from '../lib/period';
import type { PendingFilter } from '../lib/txList';
import type { PeriodController } from '../components/AppShell';

export type TxMode = 'period' | 'pending';

const PENDING_FILTERS: ReadonlyArray<{ id: PendingFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'review', label: 'Em revisão' },
  { id: 'noCategory', label: 'Sem categoria' },
];

interface TransactionsViewProps {
  profileId: string;
  profileCode: 'personal' | 'business';
  period: PeriodController;
  mode: TxMode;
  onModeChange: (m: TxMode) => void;
  pendingFilter: PendingFilter;
  onPendingFilterChange: (f: PendingFilter) => void;
}

interface EditorState {
  tx: Transaction | null;
  creating: boolean;
}

export const TransactionsView: React.FC<TransactionsViewProps> = ({
  profileId,
  profileCode,
  period,
  mode,
  onModeChange,
  pendingFilter,
  onPendingFilterChange,
}) => {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [mobile, setMobile] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const lastFocused = useRef<HTMLElement | null>(null);
  const periodBtnRef = useRef<HTMLButtonElement | null>(null);

  const [search, setSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [filterNoCategory, setFilterNoCategory] = useState(false);
  const [filterReviewOnly, setFilterReviewOnly] = useState(false);

  // Mobile (<768px): barra compacta + painéis; tablet/desktop: composição completa.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    setMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleClosePeriod = () => {
    setPeriodOpen(false);
    requestAnimationFrame(() => periodBtnRef.current?.focus());
  };

  const handleNewTransaction = () => {
    setPeriodOpen(false);
    setEditor({ tx: null, creating: true });
  };

  const handleEditTransaction = (tx: Transaction) => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    setPeriodOpen(false);
    setEditor({ tx, creating: false });
  };

  const handleDeleteTransaction = (tx: Transaction) => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    setPeriodOpen(false);
    setDeleteTarget(tx);
  };

  const handleCloseEditor = () => {
    setEditor(null);
    if (lastFocused.current) {
      requestAnimationFrame(() => lastFocused.current?.focus());
    }
  };

  const handleEditorSuccess = () => {
    setEditor(null);
    setRefreshTrigger((t) => t + 1);
  };

  const handleDeleteSuccess = () => {
    setDeleteTarget(null);
    setRefreshTrigger((t) => t + 1);
    if (lastFocused.current) {
      requestAnimationFrame(() => lastFocused.current?.focus());
    }
  };

  const handleCloseDelete = () => {
    setDeleteTarget(null);
    if (lastFocused.current) {
      requestAnimationFrame(() => lastFocused.current?.focus());
    }
  };

  // Escape fecha o painel aberto
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editor) handleCloseEditor();
      else if (periodOpen) handleClosePeriod();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, periodOpen]);

  const modeLabel = period.mode === 'custom'
    ? 'Personalizado'
    : PERIOD_MODES.find((m) => m.id === period.mode)?.label ?? '';
  const isPending = mode === 'pending';

  return (
    <div className="tx-view">
      <div className="tx-view-head">
        <div className="tx-view-title">
          <h1>{isPending ? 'Pendências' : 'Transações'}</h1>
          <p className="tx-view-subtitle">
            {isPending
              ? 'Transações em revisão ou sem categoria de todo o histórico'
              : 'Todas as transações do perfil ativo no período selecionado'}
          </p>
        </div>

        <div className="tx-mode-toggle" role="group" aria-label="Modo de transações">
          <button
            type="button"
            aria-pressed={mode === 'period'}
            onClick={() => onModeChange('period')}
          >
            Do período
          </button>
          <button
            type="button"
            aria-pressed={isPending}
            onClick={() => onModeChange('pending')}
          >
            Pendências
          </button>
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

      {isPending ? (
        /* Fila global: sem seletor mensal e sem intervalo de datas */
        <div className="tx-pending-controls">
          <div className="tx-pending-pills" role="group" aria-label="Filtro de pendências">
            {PENDING_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={pendingFilter === f.id ? 'active' : ''}
                aria-pressed={pendingFilter === f.id}
                onClick={() => onPendingFilterChange(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="tx-pending-count">
            {pendingCount.toLocaleString('pt-BR')} pendências no histórico
          </span>
        </div>
      ) : mobile ? (
        <>
          {/* Barra compacta de período (mobile) */}
          <div className="tx-period-bar">
            <button
              type="button"
              className="tx-period-nav"
              onClick={() => {
                if (period.mode === 'custom') period.onCustomReset();
                period.onSelectionChange(addMonths(period.selection, -1));
              }}
              aria-label="Mês anterior"
              title="Mês anterior"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="tx-period-label">
              <span className="tx-period-month">{formatMonthLabel(period.selection)}</span>
              <span className="tx-period-mode">{modeLabel}</span>
            </div>
            <button
              type="button"
              className="tx-period-nav"
              onClick={() => {
                if (period.mode === 'custom') period.onCustomReset();
                period.onSelectionChange(addMonths(period.selection, 1));
              }}
              aria-label="Mês seguinte"
              title="Mês seguinte"
            >
              <ChevronRight size={20} />
            </button>
            <button
              ref={periodBtnRef}
              type="button"
              className="tx-period-open"
              aria-expanded={periodOpen}
              onClick={() => setPeriodOpen((v) => !v)}
            >
              Período
            </button>
          </div>

          {/* Painel completo do período (bottom sheet) */}
          {periodOpen && (
            <div className="tx-sheet-layer">
              <div className="tx-sheet-backdrop" onClick={handleClosePeriod} />
              <div className="tx-sheet-panel" role="dialog" aria-modal="true" aria-label="Selecionar período">
                <div className="tx-sheet-header">
                  <h2>Período</h2>
                  <button
                    type="button"
                    className="categorizer-close"
                    onClick={handleClosePeriod}
                    aria-label="Fechar seleção de período"
                    title="Fechar"
                  >
                    <X size={18} />
                  </button>
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
              </div>
            </div>
          )}
        </>
      ) : (
        <PeriodSelector
          selection={period.selection}
          mode={period.mode}
          range={period.range}
          onSelectionChange={period.onSelectionChange}
          onModeChange={period.onModeChange}
          onPickerOpen={period.onPickerOpen}
          onCustomReset={period.onCustomReset}
        />
      )}

      <div className="tx-view-grid">
        <div className="tx-view-main">
          <TransactionList
            profileId={profileId}
            selectedTransactionId={null}
            onSelectTransaction={() => {}}
            refreshTrigger={refreshTrigger}
            search={search}
            onSearchChange={setSearch}
            selectedAccount={selectedAccount}
            onAccountChange={setSelectedAccount}
            startDate={period.range.start}
            onStartDateChange={() => {}}
            endDate={period.range.end}
            onEndDateChange={() => {}}
            filterNoCategory={filterNoCategory}
            onFilterNoCategoryChange={setFilterNoCategory}
            filterReviewOnly={filterReviewOnly}
            onFilterReviewOnlyChange={setFilterReviewOnly}
            mode={mode}
            pendingFilter={pendingFilter}
            onPendingCountChange={setPendingCount}
            onEditTransaction={handleEditTransaction}
            onDeleteTransaction={handleDeleteTransaction}
          />
        </div>
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
