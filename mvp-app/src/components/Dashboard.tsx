import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { TransactionList } from './TransactionList';
import { CategorizerPanel } from './CategorizerPanel';
import { AuditLogs } from './AuditLogs';
import { PeriodSelector } from './PeriodSelector';
import { TrendingUp, TrendingDown, Wallet, AlertTriangle, Tag, RefreshCw, Landmark, Server, AlertCircle, FilterX } from 'lucide-react';
import { fetchPeriodSummary } from '../lib/summary';
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
}

interface Summary {
  income: number;
  expense: number;
  balance: number;
  reviewCount: number;
  noCategoryCount: number;
  totalCount: number;
  loading: boolean;
  error: string | null;
}

export const Dashboard: React.FC<DashboardProps> = ({ profileId, profileCode = 'personal', period }) => {
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // A lista abre sem filtro de status nem de categoria (período vem do seletor global).
  const [search, setSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [filterNoCategory, setFilterNoCategory] = useState(false);
  const [filterReviewOnly, setFilterReviewOnly] = useState(false);

  const [summary, setSummary] = useState<Summary>({
    income: 0, expense: 0, balance: 0, reviewCount: 0, noCategoryCount: 0, totalCount: 0, loading: true, error: null,
  });

  const { range } = period;

  const fetchSummary = useCallback(async () => {
    setSummary((s) => ({ ...s, loading: true, error: null }));
    try {
      const periodSummary = await fetchPeriodSummary(range);

      const counters = await supabaseCounters(range);
      let reviewCount = 0;
      let noCategoryCount = 0;
      if (counters) {
        reviewCount = counters.reviewCount;
        noCategoryCount = counters.noCategoryCount;
      }

      setSummary({
        income: periodSummary.income,
        expense: periodSummary.expense,
        balance: periodSummary.balance,
        reviewCount,
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

  const handleSuccess = () => {
    setSelectedTransaction(null);
    setRefreshTrigger((t) => t + 1);
  };

  const formatBRL = (val: number) =>
    val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const filtersActive = filterReviewOnly || filterNoCategory;

  const handleClearFilters = () => {
    setFilterReviewOnly(false);
    setFilterNoCategory(false);
  };

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
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
          Visão Geral
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
          Resumo e transações do período selecionado para o perfil ativo
        </p>
      </div>

      <PeriodSelector
        selection={period.selection}
        mode={period.mode}
        range={period.range}
        onSelectionChange={period.onSelectionChange}
        onModeChange={period.onModeChange}
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

      {/* Pendências: painel único com duas linhas acionáveis (filtram a lista) */}
      <div className="pending-panel">
        <div className="pending-title">Pendências</div>
        <button
          type="button"
          className="pending-row"
          aria-pressed={filterReviewOnly}
          onClick={() => setFilterReviewOnly((v) => !v)}
          title="Filtra a lista abaixo para status = review"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} style={{ color: 'var(--color-warning)' }} />
            Em revisão
          </span>
          <span className="pending-row-count">{String(summary.reviewCount)}</span>
        </button>
        <button
          type="button"
          className="pending-row"
          aria-pressed={filterNoCategory}
          onClick={() => setFilterNoCategory((v) => !v)}
          title="Filtra a lista abaixo para category_id = null"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <Tag size={16} style={{ color: 'var(--color-secondary)' }} />
            Sem categoria
          </span>
          <span className="pending-row-count">{String(summary.noCategoryCount)}</span>
        </button>
      </div>

      {/* Limpar filtros, erro de consulta e ambiente (compactos) */}
      <div className="dash-env">
        {filtersActive && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn-secondary"
              onClick={handleClearFilters}
              style={{ padding: '8px 14px', fontSize: '12px' }}
              title="Remove os filtros de status e categoria (mantém mês, período, busca e conta)"
            >
              <FilterX size={14} />
              Limpar filtros
            </button>
          </div>
        )}

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

      {/* Área operacional: coluna principal (lista + auditoria) */}
      <div className="dash-main">
        <TransactionList
          profileId={profileId}
          selectedTransactionId={selectedTransaction?.id || null}
          onSelectTransaction={setSelectedTransaction}
          refreshTrigger={refreshTrigger}
          search={search}
          onSearchChange={setSearch}
          selectedAccount={selectedAccount}
          onAccountChange={setSelectedAccount}
          startDate={range.start}
          onStartDateChange={() => {}}
          endDate={range.end}
          onEndDateChange={() => {}}
          filterNoCategory={filterNoCategory}
          onFilterNoCategoryChange={setFilterNoCategory}
          filterReviewOnly={filterReviewOnly}
          onFilterReviewOnlyChange={setFilterReviewOnly}
        />
        <AuditLogs profileId={profileId} refreshTrigger={refreshTrigger} />
      </div>

      {/* Coluna lateral: recategorização existente (Pendências entra na lateral no desktop) */}
      <div className="dash-side">
        <div style={{ position: 'sticky', top: '20px' }}>
          <CategorizerPanel
            transaction={selectedTransaction}
            onSuccess={handleSuccess}
            onClose={() => setSelectedTransaction(null)}
          />
        </div>
      </div>
    </div>
  );
};

// Contadores auxiliares do resumo (fila de revisão e sem categoria), no mesmo recorte de datas.
async function supabaseCounters(range: { start: string; end: string }) {
  try {
    const [review, noCategory] = await Promise.all([
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .gte('occurred_on', range.start)
        .lte('occurred_on', range.end)
        .eq('status', 'review'),
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .gte('occurred_on', range.start)
        .lte('occurred_on', range.end)
        .is('category_id', null),
    ]);
    return { reviewCount: review.count ?? 0, noCategoryCount: noCategory.count ?? 0 };
  } catch (err) {
    console.error('Erro ao carregar contadores do resumo:', err);
    return null;
  }
}
