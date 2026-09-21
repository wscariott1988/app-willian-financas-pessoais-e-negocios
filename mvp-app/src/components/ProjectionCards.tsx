import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type {
  ProjectionPayloadCategoryMode,
  ProjectionPayloadCategoryV1,
  ProjectionPayloadDeviation,
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
 * Rótulos e teses de direção de UMA categoria (PESSOAL-13C4A-E3.3), derivados
 * do modo de card e do tipo de referência. Mês passado é sempre genérico;
 * mês atual diferencia variável (ritmo proporcional), compromisso fixo
 * (média mensal completa) e alocação patrimonial (média de aportes).
 */
function categoryDirection(
  kind: ProjectionPayloadReferenceKind,
  mode: ProjectionPayloadCategoryMode,
): { row: string; above: string; below: string; equal: string } {
  if (kind === 'past') {
    return {
      row: 'Diferença',
      above: 'acima da referência',
      below: 'abaixo da referência',
      equal: 'igual à referência',
    };
  }
  if (mode === 'monthly_commitment') {
    return {
      row: 'Diferença da média mensal até agora',
      above: 'acima da média mensal',
      below: 'abaixo da média mensal',
      equal: 'igual à média mensal',
    };
  }
  if (mode === 'investment_allocation') {
    return {
      row: 'Diferença da média de aportes',
      above: 'acima da média de aportes',
      below: 'abaixo da média de aportes',
      equal: 'igual à média de aportes',
    };
  }
  return {
    row: 'Diferença no ritmo até hoje',
    above: 'acima do ritmo até hoje',
    below: 'abaixo do ritmo até hoje',
    equal: 'no ritmo esperado até hoje',
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
  if (category.mode === 'monthly_commitment') {
    return (
      <li>
        <article className="finance-ai-proj-card finance-ai-proj-category">
          <h3 className="finance-ai-card-title">{category.label}</h3>
          <dl className="finance-ai-card-dl">
            <Row label="Valor lançado até hoje" value={brlCents(category.realizedCents)} />
            <Row label="Média mensal histórica" value={brlCents(category.referenceCents)} />
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
  if (category.mode === 'investment_allocation') {
    return (
      <li>
        <article className="finance-ai-proj-card finance-ai-proj-category">
          <h3 className="finance-ai-card-title">{category.label}</h3>
          <dl className="finance-ai-card-dl">
            <Row label="Aportes realizados até hoje" value={brlCents(category.realizedCents)} />
            <Row
              label="Média mensal histórica de aportes"
              value={brlCents(category.referenceCents)}
            />
            <DirectionRow
              deviation={category.deviation}
              deviationCents={category.deviationCents}
              rowLabel={dir.row}
              above={dir.above}
              below={dir.below}
              equal={dir.equal}
            />
            <Row
              label="Cenário se a média de aportes se repetir por 12 meses"
              value={brlCents(category.annualScenarioCents)}
            />
          </dl>
        </article>
      </li>
    );
  }
  // variable_pace (rodada variável do mês atual): referência proporcional.
  return (
    <li>
      <article className="finance-ai-proj-card finance-ai-proj-category">
        <h3 className="finance-ai-card-title">{category.label}</h3>
        <dl className="finance-ai-card-dl">
          <Row label="Realizado até hoje" value={brlCents(category.realizedCents)} />
          <Row
            label="Referência até hoje (média proporcional)"
            value={brlCents(category.referenceCents)}
          />
          <DirectionRow
            deviation={category.deviation}
            deviationCents={category.deviationCents}
            rowLabel={dir.row}
            above={dir.above}
            below={dir.below}
            equal={dir.equal}
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

const VARIABLE_PACE_NOTICE =
  'A referência até hoje compara o realizado com a parcela da média histórica correspondente aos dias já transcorridos.';

const MONTHLY_COMMITMENT_NOTICE =
  'Esta categoria costuma ser paga em uma ou poucas datas. Por isso, a comparação usa a média mensal completa, e não uma distribuição diária.';

const CLOSING_NOTICE =
  'O fechamento usa o ritmo do realizado e pode oscilar quando contas mensais são pagas no início do mês.';

/** Notas por MODO de card presentes na resposta atual (deduplicadas). */
function categoryNotes(p: ProjectionPayloadSuccessV1): string[] {
  if (p.reference.kind !== 'current') return [];
  const notes: string[] = [];
  if (p.categories.some((c) => c.mode === 'variable_pace')) notes.push(VARIABLE_PACE_NOTICE);
  if (p.categories.some((c) => c.mode === 'monthly_commitment')) {
    notes.push(MONTHLY_COMMITMENT_NOTICE);
  }
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
          {CLOSING_NOTICE}
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