import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { PeriodSelector } from '../components/PeriodSelector';
import { RefreshCw, TrendingUp, TrendingDown, Wallet, AlertCircle, Tag, Landmark, PieChart, CalendarRange, CheckCheck, Repeat, CreditCard } from 'lucide-react';
import { fetchAllPages } from '../lib/pagination';
import { isAbortError } from '../lib/status';
import { STATUS_EDITABLE_FROM } from '../lib/status';
import { createLatestRequestGuard } from '../lib/latestRequest';
import { buildAnalytics, type AnalyticsResult, type AnalyticsTxRow } from '../lib/analytics';
import {
  buildInsights,
  buildEvolutionWindow,
  toSeriesOccurrenceRows,
  type AnalyticsInsights,
} from '../lib/analyticsInsights';
import { formatShortDate } from '../lib/period';
import { todayISO } from '../lib/series';
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

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ profileId, period }) => {
  const { range, selection } = period;
  const [result, setResult] = useState<AnalyticsResult | null>(null);
  const [insights, setInsights] = useState<AnalyticsInsights | null>(null);
  const [categoryLimit, setCategoryLimit] = useState<5 | 10>(5);
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
    setInsights(null);
    try {
      const today = todayISO();
      const evWindow = buildEvolutionWindow(selection, 6);

      const periodFetcher: PageFetcher = async (from, to) => {
        let q = supabase
          .from('transactions')
          .select('id, transaction_kind, amount, account_id, category_id, occurred_on, status, raw_description, accounts(display_name), categories(display_name, canonical_path)', { count: 'exact' })
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

      // Evolução mensal: projeção enxuta (sem embeds) dos últimos 6 meses cheios.
      const evolutionFetcher: PageFetcher = async (from, to) => {
        let q = supabase
          .from('transactions')
          .select('amount, transaction_kind, occurred_on', { count: 'exact' })
          .is('deleted_at', null)
          .gte('occurred_on', evWindow.start)
          .lte('occurred_on', evWindow.end);
        if (signal) q = q.abortSignal(signal);
        const r = await q.range(from, to);
        return {
          rows: (r.data ?? []) as unknown[],
          totalCount: r.count,
          error: r.error,
        };
      };

      // Parcelamentos e recorrências: ocorrências FUTURAS vivas (read-only).
      // Série/status embutidos — sem N+1; cada ocorrência paga usa o valor
      // materializado (transaction_series_occurrences.amount), nunca amount_total.
      const seriesFetcher: PageFetcher = async (from, to) => {
        let q = supabase
          .from('transaction_series_occurrences')
          .select('occurrence_index, occurred_on, amount, transaction_series(id, kind, frequency, display_name, amount_total, total_occurrences, starts_on, direction, state), transactions(status, deleted_at)', { count: 'exact' })
          .gte('occurred_on', today)
          .order('occurred_on', { ascending: true });
        if (signal) q = q.abortSignal(signal);
        const r = await q.range(from, to);
        return {
          rows: (r.data ?? []) as unknown[],
          totalCount: r.count,
          error: r.error,
        };
      };

      const [periodPage, evolutionPage, seriesPage] = await Promise.all([
        fetchAllPages<AnalyticsTxRow>(periodFetcher, ANALYTICS_PAGE_SIZE),
        fetchAllPages<AnalyticsTxRow>(evolutionFetcher, ANALYTICS_PAGE_SIZE),
        fetchAllPages<unknown>(seriesFetcher, ANALYTICS_PAGE_SIZE),
      ]);
      if (!latestRef.current.isCurrent(myRequest)) return;
      setResult(buildAnalytics(periodPage.rows));
      setInsights(
        buildInsights({
          periodRows: periodPage.rows,
          evolutionRows: evolutionPage.rows,
          seriesOccurrences: toSeriesOccurrenceRows(seriesPage.rows),
          months: evWindow.months,
          todayISO: today,
        }),
      );
    } catch (err: any) {
      if (isAbortError(err)) return;
      if (!latestRef.current.isCurrent(myRequest)) return;
      console.error('Erro ao carregar análises:', err);
      setError(err.message || 'Não foi possível carregar as análises.');
    } finally {
      if (latestRef.current.isCurrent(myRequest)) setLoading(false);
    }
  }, [range, selection]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const isEmpty = !!result && result.totals.totalCount === 0;

  const evolutionMax = React.useMemo(() => {
    const pts = insights?.monthlyEvolution ?? [];
    let max = 1;
    for (const p of pts) {
      max = Math.max(max, p.income, p.expense);
    }
    return max;
  }, [insights]);

  const barPct = (value: number): number => Math.max(2, Math.round((value / evolutionMax) * 100));

  const segPct = (value: number, total: number): number => (total > 0 ? Math.round((value / total) * 100) : 0);

  const seriesEmpty =
    !!insights &&
    insights.installment.count === 0 &&
    insights.installment.committed === 0 &&
    insights.recurring.count === 0 &&
    insights.upcoming.length === 0;

  const pv = insights?.paidVsForecast;

  return (
    <div className="analytics-root">
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
      ) : result && insights ? (
        <>
          {/* Resumo do período (mesma semântica do Dashboard) */}
          <section className="analytics-section" aria-label="Resumo do período">
            <h2 className="analytics-section-title"><Wallet size={15} /> Resumo do período</h2>
            <div className="summary-grid">
              <div className="stat-card">
                <span className="stat-card-label" style={{ color: 'var(--color-success)' }}>
                  <TrendingUp size={14} /> Receitas
                </span>
                <span className="stat-card-value" style={{ color: 'var(--color-success)' }}>
                  {formatBRL(insights.summary.income)}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-card-label" style={{ color: 'var(--color-danger)' }}>
                  <TrendingDown size={14} /> Despesas
                </span>
                <span className="stat-card-value" style={{ color: 'var(--color-danger)' }}>
                  {formatBRL(insights.summary.expense)}
                </span>
              </div>
              <div className="stat-card stat-result">
                <span className="stat-card-label">
                  <Wallet size={14} /> Resultado do período
                </span>
                <span
                  className="stat-card-value"
                  style={{ color: insights.summary.balance >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
                >
                  {insights.summary.balance >= 0 ? '+' : ''}
                  {formatBRL(insights.summary.balance)}
                </span>
              </div>
            </div>
            <div className="analytics-share-row">
              <span className="analytics-share-label">Despesas sobre receitas</span>
              <span className="analytics-share-value">
                {insights.summary.expenseShare == null ? (
                  <span>—</span>
                ) : (
                  <>
                    <span className="analytics-share-track">
                      <span
                        className="analytics-share-fill"
                        style={{ width: `${Math.min(100, insights.summary.expenseShare * 100)}%` }}
                      />
                    </span>
                    <span>{formatPct(insights.summary.expenseShare)}</span>
                  </>
                )}
              </span>
            </div>
          </section>

          {isEmpty && (
            <p className="analytics-empty">
              Nenhuma transação no período selecionado para este perfil.
            </p>
          )}

          {/* Evolução mensal (CSS puro, mobile-first, sem biblioteca) */}
          <section className="analytics-section" aria-label="Evolução mensal">
            <h2 className="analytics-section-title"><CalendarRange size={15} /> Evolução mensal</h2>
            <div className="analytics-legend">
              <span className="analytics-legend-dot analytics-legend-income" /> Receitas
              <span className="analytics-legend-dot analytics-legend-expense" /> Despesas
              <span className="analytics-legend-dot analytics-legend-balance" /> Resultado
            </div>
            <div className="evolution-chart" role="img" aria-label="Evolução mensal de receitas e despesas nos últimos meses">
              {insights.monthlyEvolution.map((p) => (
                <div className="evolution-col" key={p.key}>
                  <div className="evolution-bars">
                    <div
                      className="evolution-bar evolution-bar-income"
                      style={{ height: `${barPct(p.income)}%` }}
                      title={`Receitas: ${formatBRL(p.income)}`}
                    />
                    <div
                      className="evolution-bar evolution-bar-expense"
                      style={{ height: `${barPct(p.expense)}%` }}
                      title={`Despesas: ${formatBRL(p.expense)}`}
                    />
                  </div>
                  <div className="evolution-month">{p.label}</div>
                  <div
                    className="evolution-balance"
                    style={{ color: p.balance >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
                  >
                    {p.balance >= 0 ? '+' : ''}{formatBRL(p.balance)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Despesas por categoria */}
          <section className="analytics-section" aria-label="Despesas por categoria">
            <h2 className="analytics-section-title"><PieChart size={15} /> Despesas por categoria</h2>
            <div className="analytics-toggle" role="group" aria-label="Quantas categorias exibir">
              <button
                type="button"
                className={categoryLimit === 5 ? 'active' : ''}
                aria-pressed={categoryLimit === 5}
                onClick={() => setCategoryLimit(5)}
              >
                Top 5
              </button>
              <button
                type="button"
                className={categoryLimit === 10 ? 'active' : ''}
                aria-pressed={categoryLimit === 10}
                onClick={() => setCategoryLimit(10)}
              >
                Top 10
              </button>
            </div>
            {insights.expensesByCategory.length === 0 ? (
              <p className="analytics-empty">Nenhuma despesa no período.</p>
            ) : (
              <ul className="analytics-rank">
                {insights.expensesByCategory.slice(0, categoryLimit).map((c) => (
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

          {/* Pago x previsto */}
          <section className="analytics-section" aria-label="Pago x previsto">
            <h2 className="analytics-section-title"><CheckCheck size={15} /> Pago x previsto</h2>
            {pv && pv.paid === 0 && pv.unpaid === 0 && pv.total === 0 ? (
              <p className="analytics-empty">Nenhuma transação de receita ou despesa no período.</p>
            ) : pv ? (
              <>
                <div
                  className="paid-bar"
                  role="img"
                  aria-label={`Pago ${segPct(pv.paid, pv.total)}% da movimentação do período`}
                >
                  <div className="paid-seg paid-seg-paid" style={{ width: `${segPct(pv.paid, pv.total)}%` }} />
                  <div className="paid-seg paid-seg-unpaid" style={{ width: `${segPct(pv.unpaid, pv.total)}%` }} />
                  {pv.outsideStatusWindow > 0 && (
                    <div className="paid-seg paid-seg-legacy" style={{ width: `${segPct(pv.outsideStatusWindow, pv.total)}%` }} />
                  )}
                </div>
                <ul className="analytics-rank">
                  <li className="analytics-rank-row">
                    <span className="analytics-rank-label" style={{ color: 'var(--color-success)' }}>Pago</span>
                    <span className="analytics-rank-amount">{formatBRL(pv.paid)}</span>
                  </li>
                  <li className="analytics-rank-row">
                    <span className="analytics-rank-label" style={{ color: 'var(--color-pending)' }}>Não pago (previsto)</span>
                    <span className="analytics-rank-amount">{formatBRL(pv.unpaid)}</span>
                  </li>
                  <li className="analytics-rank-row">
                    <span className="analytics-rank-label">Total geral</span>
                    <span className="analytics-rank-amount">{formatBRL(pv.total)}</span>
                  </li>
                </ul>
                {pv.outsideStatusWindow > 0 && (
                  <p className="analytics-footnote">
                    {formatBRL(pv.outsideStatusWindow)} antes do controle de status (antes de {formatShortDate(STATUS_EDITABLE_FROM)}).
                  </p>
                )}
              </>
            ) : null}
          </section>

          {/* Parcelamentos e recorrências */}
          <section className="analytics-section" aria-label="Parcelamentos e recorrências">
            <h2 className="analytics-section-title"><Repeat size={15} /> Parcelamentos e recorrências</h2>
            {seriesEmpty ? (
              <p className="analytics-empty">Nenhuma parcela ou recorrência futura cadastrada.</p>
            ) : (
              <>
                <div className="series-metrics">
                  <div className="series-metric">
                    <span className="series-metric-value">{insights.installment.count}</span>
                    <span className="series-metric-label">parcelamentos ativos</span>
                  </div>
                  <div className="series-metric">
                    <span className="series-metric-value">{formatBRL(insights.installment.committed)}</span>
                    <span className="series-metric-label">futuro comprometido</span>
                  </div>
                  <div className="series-metric">
                    <span className="series-metric-value">{insights.recurring.count}</span>
                    <span className="series-metric-label">recorrências ativas</span>
                  </div>
                </div>

                {insights.upcoming.length > 0 && (
                  <div className="series-sub">
                    <h3 className="analytics-section-subtitle">Próximos compromissos</h3>
                    <ul className="analytics-rank">
                      {insights.upcoming.map((c) => (
                        <li key={c.key} className="analytics-rank-row">
                          <span className="analytics-rank-label">
                            <span className={`badge-pill ${c.kindLabel === 'Parcela' ? 'badge-pill-installment' : 'badge-pill-recurring'}`}>{c.kindLabel}</span>
                            {c.displayName}
                          </span>
                          <span className="analytics-rank-share">{formatShortDate(c.occurredOn)}</span>
                          <span className="analytics-rank-amount">{formatBRL(c.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {insights.installment.finishingSoon.length > 0 && (
                  <div className="series-sub">
                    <h3 className="analytics-section-subtitle">Parcelas próximas de terminar</h3>
                    <ul className="analytics-rank">
                      {insights.installment.finishingSoon.map((c) => (
                        <li key={c.seriesId} className="analytics-rank-row">
                          <span className="analytics-rank-label">{c.displayName}</span>
                          <span className="analytics-rank-share">
                            {c.remaining} {c.remaining === 1 ? 'parcela restante' : 'parcelas restantes'}
                          </span>
                          <span className="analytics-rank-amount">{formatBRL(c.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Maiores despesas */}
          <section className="analytics-section" aria-label="Maiores despesas">
            <h2 className="analytics-section-title"><CreditCard size={15} /> Maiores despesas</h2>
            {insights.topExpenses.length === 0 ? (
              <p className="analytics-empty">Nenhuma despesa no período.</p>
            ) : (
              <ul className="analytics-rank">
                {insights.topExpenses.map((t, i) => (
                  <li key={`${t.occurred_on}-${t.description}-${i}`} className="analytics-rank-row">
                    <span className="analytics-rank-label">
                      <span className="analytics-top-title">{t.description || 'Sem descrição'}</span>
                      <span className="analytics-top-meta">{t.category} · {formatShortDate(t.occurred_on)}</span>
                    </span>
                    <span className="analytics-rank-amount">{formatBRL(t.amount)}</span>
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