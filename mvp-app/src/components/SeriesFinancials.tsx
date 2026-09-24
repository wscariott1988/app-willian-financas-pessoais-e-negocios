// SeriesFinancials.tsx — PESSOAL-13C4A-E8: seção "Parcelamentos e recorrências".
//
// Presentacional puro (sem Supabase/Gemini): recebe os insights já calculados e
// apenas renderiza. Responsividade por CSS Grid (3 colunas no desktop; mobile
// em duas linhas com descrição/data/valor em células separadas). Nenhum
// posicionamento absoluto para alinhar valores financeiros.
//
// Nota (E8): o FAB do app (`.tx-fab`) é renderizado apenas nas telas Início e
// Transações (`Dashboard`/`TransactionsView`) — esta tela não o contém. Um
// controle flutuante observado sobre a última linha nesta view é externo
// (extensão de navegador) e não recebe workaround artificial.
import React from 'react';
import { Repeat } from 'lucide-react';
import { formatShortDate } from '../lib/period';
import type { AnalyticsInsights } from '../lib/analyticsInsights';

function formatBRL(val: number): string {
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

interface SeriesFinancialsProps {
  insights: AnalyticsInsights;
  seriesEmpty: boolean;
}

export const SeriesFinancials: React.FC<SeriesFinancialsProps> = ({ insights, seriesEmpty }) => {
  return (
    <section className="analytics-section" aria-label="Parcelamentos e recorrências">
      <h2 className="analytics-section-title">
        <Repeat size={15} /> Parcelamentos e recorrências
      </h2>
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
              <span className="series-metric-value">{insights.recurring.count}</span>
              <span className="series-metric-label">recorrências ativas</span>
            </div>
            <div className="series-metric series-metric--committed">
              <span className="series-metric-value series-metric-value--money">
                {formatBRL(insights.installment.committed)}
              </span>
              <span className="series-metric-label">futuro comprometido</span>
            </div>
          </div>

          {insights.upcoming.length > 0 && (
            <div className="series-sub">
              <h3 className="analytics-section-subtitle">Próximos compromissos</h3>
              <ul className="series-rows">
                {insights.upcoming.map((c) => (
                  <li key={c.key} className="series-row">
                    <span className="series-row-label">
                      <span
                        className={`badge-pill ${c.kindLabel === 'Parcela' ? 'badge-pill-installment' : 'badge-pill-recurring'}`}
                      >
                        {c.kindLabel}
                      </span>
                      {c.displayName}
                    </span>
                    <span className="series-row-meta">{formatShortDate(c.occurredOn)}</span>
                    <span className="series-row-amount">{formatBRL(c.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights.installment.finishingSoon.length > 0 && (
            <div className="series-sub">
              <h3 className="analytics-section-subtitle">Parcelas próximas de terminar</h3>
              <ul className="series-rows">
                {insights.installment.finishingSoon.map((c) => (
                  <li key={c.seriesId} className="series-row">
                    <span className="series-row-label">{c.displayName}</span>
                    <span className="series-row-meta">
                      {c.remaining} {c.remaining === 1 ? 'parcela restante' : 'parcelas restantes'}
                    </span>
                    <span className="series-row-amount">{formatBRL(c.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
};