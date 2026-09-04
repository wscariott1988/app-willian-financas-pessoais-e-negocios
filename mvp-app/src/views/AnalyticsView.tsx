import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { PeriodSelector } from '../components/PeriodSelector';
import { RefreshCw, TrendingUp, TrendingDown, Wallet, AlertCircle, Tag, Landmark, PieChart } from 'lucide-react';
import { fetchAllPages } from '../lib/pagination';
import {
  buildAnalytics,
  type AnalyticsResult,
  type AnalyticsTxRow,
} from '../lib/analytics';
import { isAbortError } from '../lib/status';
import { createLatestRequestGuard } from '../lib/latestRequest';
import type { PageFetcher } from '../lib/pagination';
import type { PeriodController } from '../components/AppShell';

const PAGE_SIZE = 1000;
const ANALYTICS_PAGE_SIZE = PAGE_SIZE;

function formatBRL(val: number): string {
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatPct(share: number): string {
  return `${(share * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

interface AnalyticsViewProps {
  profileId: string;
  profileCode?: 'personal' | 'business';
  period: PeriodController;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ profileId, profileCode = 'personal', period }) => {
  const { range } = period;
  const [result, setResult] = useState<AnalyticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // requestId: identifica a consulta corrente. Uma resposta defasada (de um
  // período anterior que terminou depois da atual) nunca pode sobrescrever a
  // atual — evita mostrar dados do período errado (F-01).
  const latestRef = useRef(createLatestRequestGuard());

  const load = useCallback(async (signal?: AbortSignal) => {
    const myRequest = latestRef.current.next();
    setLoading(true);
    setError(null);
    // Limpa o resultado anterior imediatamente: enquanto o novo período
    // carrega, NÃO exibimos os números do período antigo como se fossem atuais.
    setResult(null);
    try {
      const fetcher: PageFetcher = async (from, to) => {
        let q = supabase
          .from('transactions')
          .select('id, transaction_kind, amount, account_id, category_id, accounts(display_name), categories(display_name, canonical_path)', { count: 'exact' })
          .is('deleted_at', null)
          .gte('occurred_on', range.start)
          .lte('occurred_on', range.end)
          .order('occurred_on', { ascending: false })
          .order('created_at', { ascending: false });
        if (signal) q = q.abortSignal(signal);
        const r = await q.range(from, to);
        return {
          rows: (r.data ?? []) as unknown[],
          totalCount: r.count,
          error: r.error,
        };
      };
      const { rows } = await fetchAllPages<AnalyticsTxRow>(fetcher, ANALYTICS_PAGE_SIZE);
      if (!latestRef.current.isCurrent(myRequest)) return;
      setResult(buildAnalytics(rows));
    } catch (err: any) {
      if (isAbortError(err)) return;
      if (!latestRef.current.isCurrent(myRequest)) return;
      console.error('Erro ao carregar análises:', err);
      setError(err.message || 'Não foi possível carregar as análises.');
    } finally {
      if (latestRef.current.isCurrent(myRequest)) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const isEmpty = !!result && result.totals.totalCount === 0;

  return (
    <div className="analytics-root">
      <div className="dash-title">
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
          Análises
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
          Leitura do período no perfil {profileCode === 'business' ? 'Negócio' : 'Pessoal'} — somente leitura
        </p>
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

      {loading && !result ? (
        <div className="analytics-state">
          <RefreshCw size={16} className="spin-animation" /> Calculando análises...
        </div>
      ) : error ? (
        <div className="analytics-error">
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{error}</span>
        </div>
      ) : result ? (
        <>
          {/* Resumo financeiro (mesma semântica do Dashboard) */}
          <div className="summary-grid">
            <div className="stat-card">
              <span className="stat-card-label" style={{ color: 'var(--color-success)' }}>
                <TrendingUp size={14} /> Receitas
              </span>
              <span className="stat-card-value" style={{ color: 'var(--color-success)' }}>
                {formatBRL(result.totals.income)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-card-label" style={{ color: 'var(--color-danger)' }}>
                <TrendingDown size={14} /> Despesas
              </span>
              <span className="stat-card-value" style={{ color: 'var(--color-danger)' }}>
                {formatBRL(result.totals.expense)}
              </span>
            </div>
            <div className="stat-card stat-result">
              <span className="stat-card-label">
                <Wallet size={14} /> Resultado do período
              </span>
              <span
                className="stat-card-value"
                style={{ color: result.totals.balance >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
              >
                {result.totals.balance >= 0 ? '+' : ''}
                {formatBRL(result.totals.balance)}
              </span>
            </div>
          </div>

          {isEmpty && (
            <p className="analytics-empty">
              Nenhuma transação no período selecionado para este perfil.
            </p>
          )}

          {/* Despesas por categoria */}
          <section className="analytics-section" aria-label="Despesas por categoria">
            <h2 className="analytics-section-title"><PieChart size={15} /> Despesas por categoria</h2>
            {result.expensesByCategory.length === 0 ? (
              <p className="analytics-empty">Nenhuma despesa no período.</p>
            ) : (
              <ul className="analytics-rank">
                {result.expensesByCategory.map((c) => (
                  <li key={c.category_id ?? '__none__'} className="analytics-rank-row">
                    <span className="analytics-rank-label">{c.label}</span>
                    <span className="analytics-rank-amount">{formatBRL(c.amount)}</span>
                    <span className="analytics-rank-share">{formatPct(c.share)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Receitas por categoria */}
          <section className="analytics-section" aria-label="Receitas por categoria">
            <h2 className="analytics-section-title"><TrendingUp size={15} /> Receitas por categoria</h2>
            {result.incomesByCategory.length === 0 ? (
              <p className="analytics-empty">Nenhuma receita no período.</p>
            ) : (
              <ul className="analytics-rank">
                {result.incomesByCategory.map((c) => (
                  <li key={c.category_id ?? '__none__'} className="analytics-rank-row">
                    <span className="analytics-rank-label">{c.label}</span>
                    <span className="analytics-rank-amount">{formatBRL(c.amount)}</span>
                    <span className="analytics-rank-share">{formatPct(c.share)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Movimentação por conta (NUNCA "saldo da conta") */}
          <section className="analytics-section" aria-label="Movimentação por conta">
            <h2 className="analytics-section-title"><Landmark size={15} /> Movimentação por conta</h2>
            {result.accounts.length === 0 ? (
              <p className="analytics-empty">Nenhuma movimentação no período.</p>
            ) : (
              <div className="analytics-table-wrap">
                <table className="analytics-table">
                  <thead>
                    <tr>
                      <th scope="col">Conta</th>
                      <th scope="col" className="analytics-num">Receitas</th>
                      <th scope="col" className="analytics-num">Despesas</th>
                      <th scope="col" className="analytics-num">Transferido</th>
                      <th scope="col" className="analytics-num">Líquido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.accounts.map((a) => (
                      <tr key={a.account_id}>
                        <th scope="row">{a.label}</th>
                        <td className="analytics-num analytics-income">{formatBRL(a.income)}</td>
                        <td className="analytics-num analytics-expense">{formatBRL(a.expense)}</td>
                        <td className="analytics-num analytics-muted">{formatBRL(a.transfer)}</td>
                        <td className="analytics-num" style={{ color: a.net >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {a.net >= 0 ? '+' : ''}{formatBRL(a.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="dash-env" style={{ marginTop: '12px' }}>
            <span className="badge"><Tag size={12} /> {result.totals.totalCount.toLocaleString('pt-BR')} transações no recorte</span>
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--color-text-muted)' }}>
              Transferências neutralizadas no resultado; pernas exibidas por conta.
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
};