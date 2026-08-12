import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { TransactionList } from './TransactionList';
import { CategorizerPanel } from './CategorizerPanel';
import { AuditLogs } from './AuditLogs';
import { TrendingUp, TrendingDown, Wallet, AlertTriangle, Tag, RefreshCw, User, Landmark, Server } from 'lucide-react';

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
}

interface Summary {
  income: number;
  expense: number;
  balance: number;
  reviewCount: number;
  noCategoryCount: number;
  totalCount: number;
  loading: boolean;
}

export const Dashboard: React.FC<DashboardProps> = ({ profileId, profileCode = 'personal' }) => {
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Filters (shared with TransactionList)
  const [search, setSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [filterNoCategory, setFilterNoCategory] = useState(false);
  const [filterReviewOnly, setFilterReviewOnly] = useState(true);

  const [summary, setSummary] = useState<Summary>({
    income: 0, expense: 0, balance: 0, reviewCount: 0, noCategoryCount: 0, totalCount: 0, loading: true,
  });

  const fetchSummary = useCallback(async () => {
    setSummary((s) => ({ ...s, loading: true }));
    try {
      let q = supabase
        .from('transactions')
        .select('amount, transaction_kind, status, category_id', { count: 'exact' })
        .limit(5000);

      if (selectedAccount) q = q.eq('account_id', selectedAccount);
      if (startDate) q = q.gte('occurred_on', startDate);
      if (endDate) q = q.lte('occurred_on', endDate);
      if (filterNoCategory) q = q.is('category_id', null);
      if (filterReviewOnly) q = q.eq('status', 'review');

      const { data, error, count } = await q;
      if (error) throw error;

      const rows = data || [];
      let income = 0;
      let expense = 0;
      let reviewCount = 0;
      let noCategoryCount = 0;

      for (const r of rows) {
        const amt = parseFloat(r.amount) || 0;
        if (r.transaction_kind === 'income') income += amt;
        else if (r.transaction_kind === 'expense') expense += amt;
        if (r.status === 'review') reviewCount += 1;
        if (r.category_id === null) noCategoryCount += 1;
      }

      setSummary({
        income,
        expense,
        balance: income - expense,
        reviewCount,
        noCategoryCount,
        totalCount: count || rows.length,
        loading: false,
      });
    } catch (err: any) {
      console.error('Erro ao carregar resumo financeiro:', err);
      setSummary((s) => ({ ...s, loading: false }));
    }
  }, [selectedAccount, startDate, endDate, filterNoCategory, filterReviewOnly, profileId]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshTrigger]);

  const handleSuccess = () => {
    setSelectedTransaction(null);
    setRefreshTrigger((t) => t + 1);
  };

  const formatBRL = (val: number) =>
    val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const stats = [
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
      label: 'Saldo do período',
      value: formatBRL(summary.balance),
      icon: <Wallet size={18} />,
      color: summary.balance >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
    },
    {
      label: 'Em revisão',
      value: String(summary.reviewCount),
      icon: <AlertTriangle size={18} />,
      color: 'var(--color-warning)',
    },
    {
      label: 'Sem categoria',
      value: String(summary.noCategoryCount),
      icon: <Tag size={18} />,
      color: 'var(--color-secondary)',
    },
  ];

  const isProd = import.meta.env.PROD;
  const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const gatewayLabel = rawUrl.replace(/^https?:\/\//, '') || (isProd ? 'Supabase Cloud' : 'Gateway local');

  return (
    <div style={{ padding: '0 28px 28px', display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1600px', margin: '0 auto' }}>
      {/* Summary Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '16px' }}>
        {stats.map((stat) => (
          <div key={stat.label} className="glass glass-interactive" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {React.cloneElement(stat.icon, { color: stat.color })}
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
          </div>
        ))}
      </div>

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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '24px', alignItems: 'start' }}>
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
            startDate={startDate}
            onStartDateChange={setStartDate}
            endDate={endDate}
            onEndDateChange={setEndDate}
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
