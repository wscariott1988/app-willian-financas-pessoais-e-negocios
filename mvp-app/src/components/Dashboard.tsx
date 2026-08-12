import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { TransactionList } from './TransactionList';
import { CategorizerPanel } from './CategorizerPanel';
import { AuditLogs } from './AuditLogs';
import { PeriodSelector } from './PeriodSelector';
import { TrendingUp, TrendingDown, Wallet, AlertTriangle, Tag, RefreshCw, User, Landmark, Server, AlertCircle, FilterX } from 'lucide-react';
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

  // Filters (shared with TransactionList) — a faixa de datas vem do período global.
  // A lista abre sem filtro de status nem de categoria.
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

      // Contadores auxiliares (fila de revisão e sem categoria) apenas para o resumo da página inicial
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

  interface StatCard {
    label: string;
    value: string;
    icon: React.ReactElement;
    color: string;
    filter?: 'reviewOnly' | 'noCategory';
    hint?: string;
  }

  const statFilterActive = (filter: 'reviewOnly' | 'noCategory'): boolean =>
    filter === 'reviewOnly' ? filterReviewOnly : filterNoCategory;

  const stats: StatCard[] = [
    {
      label: 'Receitas',
      value: formatBRL(summary.income),
      icon: <TrendingUp size={18} />,
      color: 'var(--color-success)',
    },
    {
      label: 'Despesas',
      value: formatBRL(summary.expense),
      icon: <TrendingDown size={18} />,
      color: 'var(--color-danger)',
    },
    {
      label: 'Resultado do período',
      value: formatBRL(summary.balance),
      icon: <Wallet size={18} />,
      color: summary.balance >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
    },
    {
      label: 'Em revisão',
      value: String(summary.reviewCount),
      icon: <AlertTriangle size={18} />,
      color: 'var(--color-warning)',
      filter: 'reviewOnly' as const,
      hint: 'Filtra a lista abaixo para status = review',
    },
    {
      label: 'Sem categoria',
      value: String(summary.noCategoryCount),
      icon: <Tag size={18} />,
      color: 'var(--color-secondary)',
      filter: 'noCategory' as const,
      hint: 'Filtra a lista abaixo para category_id = null',
    },
  ];

  const filtersActive = filterReviewOnly || filterNoCategory;

  const handleClearFilters = () => {
    setFilterReviewOnly(false);
    setFilterNoCategory(false);
  };

  const isProd = import.meta.env.PROD;
  const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const gatewayLabel = rawUrl.replace(/^https?:\/\//, '') || (isProd ? 'Supabase Cloud' : 'Gateway local');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Título da página */}
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.01em', marginBottom: '4px' }}>
          Início
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
          Resumo e transações do período selecionado para o perfil ativo
        </p>
      </div>

      {/* Seletor global de mês */}
      <PeriodSelector
        selection={period.selection}
        mode={period.mode}
        range={period.range}
        onSelectionChange={period.onSelectionChange}
        onModeChange={period.onModeChange}
      />

      {/* Resumo do período. Cards de Receita/Despesa/Resultado são informativos;
          “Em revisão” e “Sem categoria” são botões que filtram APENAS a lista. */}
      <div className="summary-grid">
        {stats.map((stat) => {
          const statBody = (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {React.cloneElement(stat.icon as React.ReactElement<{ color?: string }>, { color: stat.color })}
                {stat.label}
              </div>
              {summary.loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                  <RefreshCw size={14} className="spin-animation" /> calculando...
                </div>
              ) : (
                <div style={{ fontSize: '19px', fontWeight: 800, color: stat.color, letterSpacing: '-0.01em' }}>
                  {stat.value}
                </div>
              )}
              {stat.filter && (
                <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: statFilterActive(stat.filter) ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>
                  {statFilterActive(stat.filter) ? 'Filtro ativo — clique para remover' : 'Clique para filtrar a lista'}
                </div>
              )}
            </>
          );

          if (!stat.filter) {
            return (
              <div key={stat.label} className="glass glass-interactive stat-card">
                {statBody}
              </div>
            );
          }

          const active = statFilterActive(stat.filter);
          return (
            <button
              key={stat.label}
              type="button"
              className={`glass glass-interactive stat-card ${active ? 'stat-filter-active' : ''}`}
              aria-pressed={active}
              title={stat.hint}
              onClick={() => {
                if (stat.filter === 'reviewOnly') setFilterReviewOnly((v) => !v);
                else setFilterNoCategory((v) => !v);
              }}
            >
              {statBody}
            </button>
          );
        })}
      </div>

      {/* Limpar filtros da lista */}
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

      {/* Erro de consulta do resumo */}
      {summary.error && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: 'var(--color-danger)',
          padding: '12px 16px',
          borderRadius: '8px',
          fontSize: '13px',
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <span>{summary.error}</span>
        </div>
      )}

      {/* Environment strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
        <span className="badge badge-posted"><User size={12} /> Perfil: {profileCode === 'business' ? 'Negócio' : 'Pessoal'}</span>
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

      {/* Main Grid */}
      <div className="dashboard-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', minWidth: 0 }}>
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

        <div style={{ position: 'sticky', top: '20px' }}>
          <CategorizerPanel
            transaction={selectedTransaction}
            onSuccess={handleSuccess}
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
