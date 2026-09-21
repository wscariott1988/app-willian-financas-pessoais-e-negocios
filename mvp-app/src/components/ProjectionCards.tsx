import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type {
  ProjectionPayloadCategoryV1,
  ProjectionPayloadComparisonBasis,
  ProjectionPayloadDeviation,
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

function directionOf(
  d: ProjectionPayloadDeviation,
  basis: ProjectionPayloadComparisonBasis,
): { label: string; tone: string } {
  if (basis === 'expected_to_date') {
    if (d === 'above') return { label: 'acima do ritmo até hoje', tone: 'finance-ai-proj-above' };
    if (d === 'below') return { label: 'abaixo do ritmo até hoje', tone: 'finance-ai-proj-below' };
    return { label: 'no ritmo esperado até hoje', tone: 'finance-ai-proj-equal' };
  }
  if (d === 'above') return { label: 'acima da referência', tone: 'finance-ai-proj-above' };
  if (d === 'below') return { label: 'abaixo da referência', tone: 'finance-ai-proj-below' };
  return { label: 'igual à referência', tone: 'finance-ai-proj-equal' };
}

function DirIcon({ d }: { d: ProjectionPayloadDeviation }) {
  if (d === 'above') return <TrendingUp aria-hidden="true" role="presentation" size={12} />;
  if (d === 'below') return <TrendingDown aria-hidden="true" role="presentation" size={12} />;
  return <Minus aria-hidden="true" role="presentation" size={12} />;
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
  basis,
}: {
  deviation: ProjectionPayloadDeviation;
  deviationCents: number;
  basis: ProjectionPayloadComparisonBasis;
}) {
  const dir = directionOf(deviation, basis);
  return (
    <div className="finance-ai-card-row">
      <dt className="finance-ai-card-dt">
        {basis === 'expected_to_date' ? 'Diferença no ritmo até hoje' : 'Diferença'}
      </dt>
      <dd className="finance-ai-card-dd finance-ai-proj-dd">
        <span>{brlCents(Math.abs(deviationCents))}</span>
        <span className={`finance-ai-proj-dir ${dir.tone}`}>
          <DirIcon d={deviation} /> {dir.label}
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
  if (c.referenceBasis === 'expected_to_date') {
    return (
      <li>
        <article className="finance-ai-proj-card">
          <h3 className="finance-ai-card-title">Mês atual</h3>
          <dl className="finance-ai-card-dl">
            <Row label="Realizado até hoje" value={brlCents(c.realizedCents)} />
            <Row label="Esperado até hoje" value={brlCents(c.expectedToDateCents)} />
            <Row label="Futuros registrados" value={brlCents(c.futureRegisteredCents)} />
            <Row label="Comprometido" value={brlCents(c.committedCents)} />
            <Row
              label="Fechamento estimado"
              value={
                c.closingProjectionCents === null
                  ? 'Disponível a partir do 7º dia'
                  : brlCents(c.closingProjectionCents)
              }
            />
          </dl>
        </article>
      </li>
    );
  }
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
            basis="monthly_mean"
          />
        </dl>
      </article>
    </li>
  );
}

function CategoryCard({
  category,
  basis,
}: {
  category: ProjectionPayloadCategoryV1;
  basis: ProjectionPayloadComparisonBasis;
}) {
  const refLabel =
    basis === 'expected_to_date' ? 'Referência até hoje (média proporcional)' : 'Média histórica';
  const realizedLabel = basis === 'expected_to_date' ? 'Realizado até hoje' : 'Realizado no mês';
  return (
    <li>
      <article className="finance-ai-proj-card finance-ai-proj-category">
        <h3 className="finance-ai-card-title">{category.label}</h3>
        <dl className="finance-ai-card-dl">
          <Row label={realizedLabel} value={brlCents(category.realizedCents)} />
          <Row label={refLabel} value={brlCents(category.referenceCents)} />
          <DirectionRow
            deviation={category.deviation}
            deviationCents={category.deviationCents}
            basis={basis}
          />
          <Row label="Média mensal histórica" value={brlCents(category.monthlyMeanCents)} />
          <Row
            label="Cenário se a média se repetir por 12 meses"
            value={brlCents(category.annualScenarioCents)}
          />
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

const TO_DATE_NOTICE =
  'A referência até hoje distribui a média histórica pelos dias transcorridos. Para contas pagas de uma vez, como aluguel, ficar acima dessa referência indica apenas que o pagamento já ocorreu; não significa que o mês terminará acima da média.';

function SuccessCards({ projection }: { projection: ProjectionPayloadSuccessV1 }) {
  const showNotice =
    projection.intent !== 'projection_base' &&
    projection.comparison.referenceBasis === 'expected_to_date';
  if (projection.intent === 'projection_categories') {
    return (
      <>
        <ul className="finance-ai-projection-list">
          {projection.categories.map((c) => (
            <CategoryCard
              key={c.label}
              category={c}
              basis={projection.comparison.referenceBasis}
            />
          ))}
          <RemainingCard p={projection} />
        </ul>
        {showNotice && (
          <p className="finance-ai-notice" role="note">
            {TO_DATE_NOTICE}
          </p>
        )}
      </>
    );
  }
  if (projection.intent === 'projection_base') {
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
      {showNotice && (
        <p className="finance-ai-notice" role="note">
          {TO_DATE_NOTICE}
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