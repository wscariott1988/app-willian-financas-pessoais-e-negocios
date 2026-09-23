import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type {
  ProjectionPayloadCategoryMode,
  ProjectionPayloadCategoryV1,
  ProjectionPayloadDeviation,
  ProjectionPayloadForecastMonthV1,
  ProjectionPayloadForecastV1,
  ProjectionPayloadReferenceKind,
  ProjectionPayloadSuccessV1,
  ProjectionPayloadV1,
} from '../../server/finance-ai/projectionPayloadV1';

const PT_MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

function brlCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function monthNameOf(yearMonth: string): string {
  const m = Number(yearMonth.slice(5, 7));
  const name = PT_MONTHS[m - 1];
  return name ? `${name} de ${yearMonth.slice(0, 4)}` : yearMonth;
}

function DirIcon({ d }: { d: ProjectionPayloadDeviation }) {
  if (d === 'above') return <TrendingUp aria-hidden="true" role="presentation" size={12} />;
  if (d === 'below') return <TrendingDown aria-hidden="true" role="presentation" size={12} />;
  return <Minus aria-hidden="true" role="presentation" size={12} />;
}

/**
 * Rótulos e teses de direção de UMA categoria (PESSOAL-13C4A-E3.3 + E3.7).
 * O modo de card apenas escolhe a LINGUAGEM; a base de comparação é SEMPRE a
 * média mensal completa (mês atual e passado) — nunca há referência
 * proporcional/ritmo até o dia.
 */
function categoryDirection(
  kind: ProjectionPayloadReferenceKind,
  mode: ProjectionPayloadCategoryMode,
): { row: string; above: string; below: string; equal: string; referenceLabel: string; annualLabel: string } {
  if (kind === 'past') {
    return {
      row: 'Diferença',
      above: 'acima da referência',
      below: 'abaixo da referência',
      equal: 'igual à referência',
      referenceLabel: 'Média histórica',
      annualLabel: 'Cenário se a média se repetir por 12 meses',
    };
  }
  if (mode === 'monthly_commitment') {
    return {
      row: 'Diferença para a média mensal',
      above: 'acima da média mensal',
      below: 'abaixo da média mensal',
      equal: 'igual à média mensal',
      referenceLabel: 'Média mensal histórica',
      annualLabel: 'Cenário se a média se repetir por 12 meses',
    };
  }
  if (mode === 'investment_allocation') {
    return {
      row: 'Diferença para a média de aportes',
      above: 'acima da média de aportes',
      below: 'abaixo da média de aportes',
      equal: 'igual à média de aportes',
      referenceLabel: 'Média mensal histórica de aportes',
      annualLabel: 'Cenário se a média de aportes se repetir por 12 meses',
    };
  }
  return {
    row: 'Diferença para a média mensal',
    above: 'acima da média mensal',
    below: 'abaixo da média mensal',
    equal: 'igual à média mensal',
    referenceLabel: 'Média mensal histórica',
    annualLabel: 'Cenário se a média se repetir por 12 meses',
  };
}

function isUsableProjection(value: unknown): value is ProjectionPayloadV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; status?: unknown };
  return v.version === 1 && (v.status === 'success' || v.status === 'insufficient');
}

function monthsLabel(n: number): string {
  return n === 1 ? `${n} mês` : `${n} meses`;
}

function badgeText(p: ProjectionPayloadV1): string {
  if (p.status === 'insufficient') {
    return `Dados insuficientes · ${monthsLabel(p.coverage.coveredMonths)} · mínimo ${p.coverage.minimumCoverageMonths}`;
  }
  return p.quality === 'preliminary'
    ? `Base preliminar · ${p.coverage.coveredMonths}/${p.coverage.windowMonths} meses`
    : `Base completa · ${p.coverage.coveredMonths}/${p.coverage.windowMonths} meses`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="finance-ai-card-row">
      <dt className="finance-ai-card-dt">{label}</dt>
      <dd className="finance-ai-card-dd">{value}</dd>
    </div>
  );
}

function DirectionRow({
  deviation,
  deviationCents,
  rowLabel,
  above,
  below,
  equal,
}: {
  deviation: ProjectionPayloadDeviation;
  deviationCents: number;
  rowLabel: string;
  above: string;
  below: string;
  equal: string;
}) {
  const label =
    deviation === 'above' ? above : deviation === 'below' ? below : equal;
  const tone =
    deviation === 'above'
      ? 'finance-ai-proj-above'
      : deviation === 'below'
        ? 'finance-ai-proj-below'
        : 'finance-ai-proj-equal';
  return (
    <div className="finance-ai-card-row">
      <dt className="finance-ai-card-dt">{rowLabel}</dt>
      <dd className="finance-ai-card-dd finance-ai-proj-dd">
        <span>{brlCents(Math.abs(deviationCents))}</span>
        <span className={`finance-ai-proj-dir ${tone}`}>
          <DirIcon d={deviation} /> {label}
        </span>
      </dd>
    </div>
  );
}

function SummaryCard({ projection }: { projection: ProjectionPayloadSuccessV1 }) {
  return (
    <li>
      <article className="finance-ai-proj-card">
        <h3 className="finance-ai-card-title">Visão geral</h3>
        <dl className="finance-ai-card-dl">
          <Row label="Média mensal histórica" value={brlCents(projection.summary.monthlyMeanCents)} />
          <Row
            label="Cenário se a média se repetir por 12 meses"
            value={brlCents(projection.summary.annualScenarioCents)}
          />
        </dl>
      </article>
    </li>
  );
}

function MonthCard({ projection }: { projection: ProjectionPayloadSuccessV1 }) {
  const c = projection.comparison;
  if (projection.reference.kind === 'past') {
    return (
      <li>
        <article className="finance-ai-proj-card">
          <h3 className="finance-ai-card-title">
            Mês analisado · {monthNameOf(projection.reference.month)}
          </h3>
          <dl className="finance-ai-card-dl">
            <Row label="Realizado" value={brlCents(c.realizedCents)} />
            <Row label="Média histórica" value={brlCents(c.referenceCents)} />
            <DirectionRow
              deviation={c.deviation}
              deviationCents={c.deviationCents}
              rowLabel="Diferença"
              above="acima da referência"
              below="abaixo da referência"
              equal="igual à referência"
            />
          </dl>
        </article>
      </li>
    );
  }
  // PESSOAL-13C4A-E3.7: o mês atual usa a MESMA forma do passado — realizado do
  // mês inteiro, média mensal histórica e diferença. Nunca ritmo/futuros/
  // fechamento. Payloads legados (expected_to_date) também renderizam aqui.
  return (
    <li>
      <article className="finance-ai-proj-card">
        <h3 className="finance-ai-card-title">Mês atual</h3>
        <dl className="finance-ai-card-dl">
          <Row label="Realizado no mês" value={brlCents(c.realizedCents)} />
          <Row label="Média mensal histórica" value={brlCents(c.referenceCents)} />
          <DirectionRow
            deviation={c.deviation}
            deviationCents={c.deviationCents}
            rowLabel="Diferença"
            above="acima da média mensal"
            below="abaixo da média mensal"
            equal="igual à média mensal"
          />
        </dl>
      </article>
    </li>
  );
}

function CategoryCard({
  category,
  kind,
}: {
  category: ProjectionPayloadCategoryV1;
  kind: ProjectionPayloadReferenceKind;
}) {
  const dir = categoryDirection(kind, category.mode);
  if (kind === 'past') {
    return (
      <li>
        <article className="finance-ai-proj-card finance-ai-proj-category">
          <h3 className="finance-ai-card-title">{category.label}</h3>
          <dl className="finance-ai-card-dl">
            <Row label="Realizado no mês" value={brlCents(category.realizedCents)} />
            <Row label="Média histórica" value={brlCents(category.referenceCents)} />
            <DirectionRow
              deviation={category.deviation}
              deviationCents={category.deviationCents}
              rowLabel={dir.row}
              above={dir.above}
              below={dir.below}
              equal={dir.equal}
            />
            <Row
              label="Cenário se a média se repetir por 12 meses"
              value={brlCents(category.annualScenarioCents)}
            />
          </dl>
        </article>
      </li>
    );
  }
  // Mês atual (PESSOAL-13C4A-E3.7): MESMA forma do mês passado — realizado do
  // mês inteiro, média mensal histórica e diferença. O modo muda só a
  // linguagem. Nunca futuros/comprometido/ritmo/fechamento.
  const realizedLabel =
    category.mode === 'monthly_commitment'
      ? 'Valor lançado no mês'
      : category.mode === 'investment_allocation'
        ? 'Aportes lançados no mês'
        : 'Total lançado no mês';
  return (
    <li>
      <article className="finance-ai-proj-card finance-ai-proj-category">
        <h3 className="finance-ai-card-title">{category.label}</h3>
        <dl className="finance-ai-card-dl">
          <Row label={realizedLabel} value={brlCents(category.realizedCents)} />
          <Row label={dir.referenceLabel} value={brlCents(category.referenceCents)} />
          <DirectionRow
            deviation={category.deviation}
            deviationCents={category.deviationCents}
            rowLabel={dir.row}
            above={dir.above}
            below={dir.below}
            equal={dir.equal}
          />
          <Row label={dir.annualLabel} value={brlCents(category.annualScenarioCents)} />
        </dl>
      </article>
    </li>
  );
}

function RemainingCard({ p }: { p: ProjectionPayloadSuccessV1 }) {
  const remaining = p.remaining;
  if (!remaining) return null;
  return (
    <li>
      <article className="finance-ai-proj-card finance-ai-proj-remaining">
        <h3 className="finance-ai-card-title">Outras {remaining.categoriesCount} categorias</h3>
        <dl className="finance-ai-card-dl">
          <Row label="Média mensal histórica" value={brlCents(remaining.monthlyMeanCents)} />
          <Row
            label="Cenário se a média se repetir por 12 meses"
            value={brlCents(remaining.annualScenarioCents)}
          />
        </dl>
      </article>
    </li>
  );
}

// PESSOAL-13C4A-E6: card-resumo do horizonte (projetado = lançado + estimativa
// ainda não lançada; referência histórica anualizada sem somar estimativas).
function ForecastSummaryCard({ forecast }: { forecast: ProjectionPayloadForecastV1 }) {
  return (
    <li>
      <article className="finance-ai-proj-card">
        <h3 className="finance-ai-card-title">Horizonte projetado</h3>
        <dl className="finance-ai-card-dl">
          <Row label="Cenário projetado" value={brlCents(forecast.summary.projectedCents)} />
          <Row label="Já lançado" value={brlCents(forecast.summary.registeredCents)} />
          <Row
            label="Estimativa ainda não lançada"
            value={brlCents(forecast.summary.estimatedRemainingCents)}
          />
          <Row
            label="Referência histórica anualizada"
            value={brlCents(forecast.summary.historicalReferenceCents)}
          />
        </dl>
      </article>
    </li>
  );
}

// PESSOAL-13C4A-E6: um card por mês do horizonte (out/2026..set/2027). Valores
// byte-exatos do payload — o cliente nunca recalcula.
function ForecastMonthCard({ forecastMonth }: { forecastMonth: ProjectionPayloadForecastMonthV1 }) {
  return (
    <li>
      <article className="finance-ai-proj-card">
        <h3 className="finance-ai-card-title">{monthNameOf(forecastMonth.month)}</h3>
        <dl className="finance-ai-card-dl">
          <Row label="Cenário projetado" value={brlCents(forecastMonth.projectedCents)} />
          <Row label="Já lançado" value={brlCents(forecastMonth.registeredCents)} />
          <Row
            label="Estimativa ainda não lançada"
            value={brlCents(forecastMonth.estimatedRemainingCents)}
          />
          <Row label="Referência histórica" value={brlCents(forecastMonth.historicalReferenceCents)} />
        </dl>
      </article>
    </li>
  );
}

// PESSOAL-13C4A-E6: nota única que explica POR QUE a estimativa não soma o
// registrado ao projetado (opção de evitar contar o mesmo gasto duas vezes).
const FORECAST_NOTE =
  'A projeção considera o maior valor entre o que já está lançado e a média histórica de cada categoria, evitando contar o mesmo gasto duas vezes.';

// PESSOAL-13C4A-E3.7: aviso curto do mês atual — o total observado pode
// mudar enquanto novos lançamentos do mês forem registrados.
const CURRENT_CHANGE_NOTICE =
  'Novos lançamentos ainda podem alterar o total do mês.';

/** Notas presentes na resposta atual (deduplicadas). */
function categoryNotes(p: ProjectionPayloadSuccessV1): string[] {
  if (p.reference.kind !== 'current') return [];
  const notes: string[] = [];
  if (p.categories.length > 0) notes.push(CURRENT_CHANGE_NOTICE);
  return notes;
}

function SuccessCards({ projection }: { projection: ProjectionPayloadSuccessV1 }) {
  if (projection.intent === 'projection_categories') {
    const notes = categoryNotes(projection);
    return (
      <>
        <ul className="finance-ai-projection-list">
          {projection.categories.map((c) => (
            <CategoryCard
              key={c.label}
              category={c}
              kind={projection.reference.kind}
            />
          ))}
          <RemainingCard p={projection} />
        </ul>
        {notes.map((note) => (
          <p className="finance-ai-notice" role="note" key={note}>
            {note}
          </p>
        ))}
      </>
    );
  }
  if (projection.intent === 'projection_base') {
    // PESSOAL-13C4A-E6: com forecast → card-resumo do horizonte + grade dos 12
    // meses. Sem forecast (payload legado) → SummaryCard do E2 preservado.
    if (projection.forecast) {
      return (
        <>
          <ul className="finance-ai-projection-list">
            <SummaryCard projection={projection} />
            <ForecastSummaryCard forecast={projection.forecast} />
          </ul>
          <ul className="finance-ai-proj-forecast-grid">
            {projection.forecast.months.map((m) => (
              <ForecastMonthCard key={m.month} forecastMonth={m} />
            ))}
          </ul>
          <p className="finance-ai-notice" role="note">
            {FORECAST_NOTE}
          </p>
        </>
      );
    }
    return (
      <ul className="finance-ai-projection-list">
        <SummaryCard projection={projection} />
      </ul>
    );
  }
  return (
    <>
      <ul className="finance-ai-projection-list">
        <MonthCard projection={projection} />
      </ul>
      {projection.intent === 'projection_current_month' && (
        <p className="finance-ai-notice" role="note">
          {CURRENT_CHANGE_NOTICE}
        </p>
      )}
    </>
  );
}

function InsufficientCard({ p }: { p: Extract<ProjectionPayloadV1, { status: 'insufficient' }> }) {
  return (
    <article className="finance-ai-proj-card finance-ai-proj-insufficient">
      <h3 className="finance-ai-card-title">Dados insuficientes</h3>
      <p className="finance-ai-card-subtitle">
        Ainda não há dados suficientes para projetar: foram encontrados{' '}
        {p.coverage.coveredMonths} de {p.coverage.windowMonths} meses com cobertura completa
        (mínimo de {p.coverage.minimumCoverageMonths}).
      </p>
    </article>
  );
}

export function ProjectionCards({ projection }: { projection?: ProjectionPayloadV1 }) {
  if (!isUsableProjection(projection)) return null;
  return (
    <section className="finance-ai-projection" aria-label="Cards de projeção">
      <span className="finance-ai-projection-badge">{badgeText(projection)}</span>
      {projection.status === 'insufficient' ? (
        <InsufficientCard p={projection} />
      ) : (
        <SuccessCards projection={projection} />
      )}
    </section>
  );
}