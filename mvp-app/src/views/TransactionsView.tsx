import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { TransactionList, type Transaction } from '../components/TransactionList';
import { CategorizerPanel } from '../components/CategorizerPanel';
import { PeriodSelector } from '../components/PeriodSelector';
import { addMonths, formatMonthLabel, PERIOD_MODES } from '../lib/period';
import type { PeriodController } from '../components/AppShell';

interface TransactionsViewProps {
  profileId: string;
  period: PeriodController;
}

export const TransactionsView: React.FC<TransactionsViewProps> = ({ profileId, period }) => {
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [mobile, setMobile] = useState(false);
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

  const handleSelect = (tx: Transaction) => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    setPeriodOpen(false);
    setSelectedTransaction(tx);
  };

  const handleCloseCategorizer = () => {
    setSelectedTransaction(null);
    // devolve o foco ao elemento que abriu o painel
    if (lastFocused.current) {
      requestAnimationFrame(() => lastFocused.current?.focus());
    }
  };

  const handleClosePeriod = () => {
    setPeriodOpen(false);
    requestAnimationFrame(() => periodBtnRef.current?.focus());
  };

  // Escape fecha o painel aberto (sem dependência nova)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectedTransaction) handleCloseCategorizer();
      else if (periodOpen) handleClosePeriod();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTransaction, periodOpen]);

  const modeLabel = PERIOD_MODES.find((m) => m.id === period.mode)?.label ?? '';

  return (
    <div className="tx-view">
      <div className="tx-view-title">
        <h1>Transações</h1>
        <p className="tx-view-subtitle">Todas as transações do perfil ativo no período selecionado</p>
      </div>

      {mobile ? (
        <>
          {/* Barra compacta de período (mobile) */}
          <div className="tx-period-bar">
            <button
              type="button"
              className="tx-period-nav"
              onClick={() => period.onSelectionChange(addMonths(period.selection, -1))}
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
              onClick={() => period.onSelectionChange(addMonths(period.selection, 1))}
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
        />
      )}

      <div className={`tx-view-grid ${selectedTransaction ? 'with-side' : ''}`}>
        <div className="tx-view-main">
          <TransactionList
            profileId={profileId}
            selectedTransactionId={selectedTransaction?.id ?? null}
            onSelectTransaction={handleSelect}
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
          />
        </div>

        {/* Recategorização: existe somente quando há seleção (sem painel vazio permanente) */}
        {selectedTransaction && (
          <>
            <div className="tx-view-backdrop open" onClick={handleCloseCategorizer} />
            <div className="tx-view-side open">
              <CategorizerPanel
                transaction={selectedTransaction}
                onSuccess={() => {
                  setSelectedTransaction(null);
                  setRefreshTrigger((t) => t + 1);
                }}
                onClose={handleCloseCategorizer}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
