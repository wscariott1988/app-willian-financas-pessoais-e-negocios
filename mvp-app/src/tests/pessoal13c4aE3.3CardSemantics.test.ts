// pessoal13c4aE3.3CardSemantics.test.ts — PESSOAL-13C4A-E3.3: semântica de card
// POR CATEGORIA. Prova, no nível do motor + contrato:
//
//   1. projectionCategoryMode deriva do RÓTULO reaproveitando
//      classifySavingsCategory (NUNCA duplica a lista de termos): fixed_contract
//      / debt_commitment → monthly_commitment; asset_allocation →
//      investment_allocation; todo o resto (variável e saúde sem contrato) →
//      variable_pace;
//   2. a base de comparação é POR CATEGORIA: só rodadas variáveis do mês atual
//      usam a referência proporcional (expected_to_date); compromissos fixos,
//      dívidas e investimentos usam a média mensal completa (monthly_mean);
//      mês passado SEMPRE usa monthly_mean — nada de "ritmo" no passado;
//   3. exemplo fechado (Aluguel × Supermercado): o card do aluguel usa a média
//      R$ 1.846,59 (nunca o proporcional R$ 1.292,61) com +R$ 81,21; o card do
//      supermercado usa a referência proporcional R$ 1.120,91 com −R$ 996,93;
//   4. o mapeador expõe mode/referenceBasis por categoria e o sanitizador valida
//      a coerência cruzada modo ↔ referenceBasis ↔ kind (combinações inválidas
//      → payload undefined, nunca objeto parcial enganoso).
import { describe, it, expect } from 'vitest';
import {
  buildProjection,
  projectionCategoryMode,
  type ProjectionEngineInput,
  type ProjectionPeriod,
  type ProjectionTransaction,
} from '../lib/analyticsProjection';
import {
  mapProjectionToPayloadV1,
  sanitizeProjectionPayloadV1,
  type ProjectionPayloadSuccessV1,
  type ProjectionPayloadV1,
} from '../../server/finance-ai/projectionPayloadV1';

const PAD2 = (v: number) => String(v).padStart(2, '0');

function ymd(y: number, m: number, d: number): string {
  return `${y}-${PAD2(m)}-${PAD2(d)}`;
}

function tx(
  date: string,
  cents: number,
  label: string,
  catId = `c-${label.toLowerCase()}`,
): ProjectionTransaction {
  return {
    accountId: 'ACCT-A',
    occurredOn: date,
    amountCents: cents,
    transactionKind: 'expense',
    categoryId: catId,
    categoryLabel: label,
    deletedAt: null,
    status: 'posted',
  };
}

function period(account: string, start: string, end: string | null = null): ProjectionPeriod {
  return { accountId: account, startsOn: start, endsOn: end };
}

function monthly(
  start: { year: number; month: number },
  end: { year: number; month: number },
  cents: number,
  label: string,
): ProjectionTransaction[] {
  const out: ProjectionTransaction[] = [];
  let y = start.year;
  let m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    out.push(tx(ymd(y, m, 15), cents, label));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const TODAY = '2026-09-21';
const FULL_12 = { year: 2025, month: 9 };
const AUG_2026 = { year: 2026, month: 8 };

/**
 * Fixture canônica da semântica de cards: Aluguel (contrato fixo) e
 * Supermercado (variável) com histórico de 12 meses (2025-09..2026-08) e
 * realizado de setembro/2026. Hoje = 2026-09-21 → fração do mês = 21/30.
 *
 * Aluguel: 12 × 184659 → média 184659; realizado setembro 192780; como
 * monthly_commitment a referência é a MÉDIA COMPLETA (184659), desvio +8121
 * (R$ 81,21 acima) — o proporcional 129261 (R$ 1.292,61) NUNCA entra no card.
 * Supermercado: 12 × 160130 → média 160130; realizado setembro 12398; como
 * variable_pace a referência é proporcional round(160130*21/30) = 112091
 * (R$ 1.120,91), desvio 12398 − 112091 = −99693 (R$ 996,93 abaixo do ritmo).
 */
function cardFixture(): ProjectionEngineInput {
  return {
    todayISO: TODAY,
    transactions: [
      ...monthly(FULL_12, AUG_2026, 184659, 'Aluguel'),
      ...monthly(FULL_12, AUG_2026, 160130, 'Supermercado'),
      tx(ymd(2026, 9, 20), 192780, 'Aluguel'),
      tx(ymd(2026, 9, 10), 12398, 'Supermercado'),
    ],
    periods: [period('ACCT-A', '2025-09-01')],
  };
}

type Raw = Record<string, unknown>;

function clonePayload(p: ProjectionPayloadV1): Raw {
  return JSON.parse(JSON.stringify(p)) as Raw;
}

function currentPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection(cardFixture());
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_categories') as ProjectionPayloadSuccessV1;
}

describe('PESSOAL-13C4A-E3.3 — projeçãoCategoryMode deriva do rótulo (reuso de classifySavingsCategory)', () => {
  it('fixed_contract/debt_commitment → monthly_commitment; asset_allocation → investment_allocation; resto → variable_pace', () => {
    expect(projectionCategoryMode('Aluguel')).toBe('monthly_commitment');
    expect(projectionCategoryMode('Moradia > Aluguel')).toBe('monthly_commitment');
    expect(projectionCategoryMode('Plano de Saúde')).toBe('monthly_commitment');
    expect(projectionCategoryMode('Empréstimo')).toBe('monthly_commitment');
    expect(projectionCategoryMode('Financiamento > Parcelamento')).toBe('monthly_commitment');
    expect(projectionCategoryMode('Investimentos')).toBe('investment_allocation');
    expect(projectionCategoryMode('Financeiro > Investimentos')).toBe('investment_allocation');
    expect(projectionCategoryMode('Poupança')).toBe('investment_allocation');
    expect(projectionCategoryMode('Alimentação > Supermercado')).toBe('variable_pace');
    expect(projectionCategoryMode('Farmácia')).toBe('variable_pace');
    expect(projectionCategoryMode('Transporte > Combustível')).toBe('variable_pace');
    expect(projectionCategoryMode('Sem classificação')).toBe('variable_pace');
  });
});

describe('PESSOAL-13C4A-E3.3 — semântica por categoria no motor (mês atual)', () => {
  it('Aluguel usa média completa (nunca o proporcional) e Supermercado usa referência proporcional', () => {
    const r = buildProjection(cardFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const [aluguel, supermercado] = r.categories;

    expect(aluguel.label).toBe('Aluguel');
    expect(aluguel.mode).toBe('monthly_commitment');
    expect(aluguel.referenceBasis).toBe('monthly_mean');
    expect(aluguel.monthlyMeanCents).toBe(184659);
    expect(aluguel.referenceCents).toBe(184659);
    expect(aluguel.referenceCents).not.toBe(129261);
    expect(aluguel.actualCents).toBe(192780);
    expect(aluguel.deviationCents).toBe(8121);
    expect(aluguel.deviation).toBe('above');

    expect(supermercado.label).toBe('Supermercado');
    expect(supermercado.mode).toBe('variable_pace');
    expect(supermercado.referenceBasis).toBe('expected_to_date');
    expect(supermercado.monthlyMeanCents).toBe(160130);
    expect(supermercado.referenceCents).toBe(112091);
    expect(supermercado.actualCents).toBe(12398);
    expect(supermercado.deviationCents).toBe(-99693);
    expect(supermercado.deviation).toBe('below');
  });
});

describe('PESSOAL-13C4A-E3.3 — matriz de modos (fixos, dívidas, investimentos, variáveis)', () => {
  function matrix(): ProjectionEngineInput {
    const labels = ['Aluguel', 'Empréstimo', 'Plano de Saúde', 'Investimentos', 'Farmácia', 'Supermercado'];
    return {
      todayISO: TODAY,
      transactions: labels.flatMap((label) => monthly(FULL_12, AUG_2026, 1000, label)),
      periods: [period('ACCT-A', '2025-09-01')],
    };
  }

  it('mês atual: commitments/investments usam monthly_mean; variáveis usam expected_to_date', () => {
    const r = buildProjection(matrix());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const byLabel = new Map(r.categories.map((c) => [c.label, c]));
    expect(byLabel.get('Aluguel')).toMatchObject({ mode: 'monthly_commitment', referenceBasis: 'monthly_mean' });
    expect(byLabel.get('Empréstimo')).toMatchObject({ mode: 'monthly_commitment', referenceBasis: 'monthly_mean' });
    expect(byLabel.get('Plano de Saúde')).toMatchObject({ mode: 'monthly_commitment', referenceBasis: 'monthly_mean' });
    expect(byLabel.get('Investimentos')).toMatchObject({ mode: 'investment_allocation', referenceBasis: 'monthly_mean' });
    expect(byLabel.get('Farmácia')).toMatchObject({ mode: 'variable_pace', referenceBasis: 'expected_to_date' });
    expect(byLabel.get('Supermercado')).toMatchObject({ mode: 'variable_pace', referenceBasis: 'expected_to_date' });
  });

  it('mês passado: TODAS as categorias usam monthly_mean, mesmo com modo preservado do rótulo', () => {
    const input = matrix();
    input.referenceMonth = { year: 2026, month: 8 };
    const r = buildProjection(input);
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    expect(r.categories.length).toBeGreaterThanOrEqual(6);
    for (const c of r.categories) {
      expect(c.referenceBasis).toBe('monthly_mean');
      expect(['variable_pace', 'monthly_commitment', 'investment_allocation']).toContain(c.mode);
    }
    const byLabel = new Map(r.categories.map((c) => [c.label, c]));
    expect(byLabel.get('Aluguel')?.mode).toBe('monthly_commitment');
    expect(byLabel.get('Investimentos')?.mode).toBe('investment_allocation');
    expect(byLabel.get('Supermercado')?.mode).toBe('variable_pace');
  });
});

describe('PESSOAL-13C4A-E3.3 — mapeador e sanitizador (mode/referenceBasis por categoria)', () => {
  it('payload do mapeador expõe mode/referenceBasis por categoria e sobrevive ao round-trip', () => {
    const p = currentPayload();
    expect(p.categories).toHaveLength(2);
    const aluguel = p.categories.find((c) => c.label === 'Aluguel') as ProjectionPayloadSuccessV1['categories'][number];
    const supermercado = p.categories.find((c) => c.label === 'Supermercado') as ProjectionPayloadSuccessV1['categories'][number];
    expect(aluguel).toEqual({
      label: 'Aluguel',
      monthlyMeanCents: 184659,
      annualScenarioCents: 2215908,
      realizedCents: 192780,
      referenceCents: 184659,
      deviationCents: 8121,
      deviation: 'above',
      referenceBasis: 'monthly_mean',
      mode: 'monthly_commitment',
    });
    expect(supermercado).toEqual({
      label: 'Supermercado',
      monthlyMeanCents: 160130,
      annualScenarioCents: 1921560,
      realizedCents: 12398,
      referenceCents: 112091,
      deviationCents: -99693,
      deviation: 'below',
      referenceBasis: 'expected_to_date',
      mode: 'variable_pace',
    });
    expect(sanitizeProjectionPayloadV1(clonePayload(p))).toEqual(p);
  });

  it('combinações inválidas de modo ↔ referenceBasis ↔ kind → payload undefined', () => {
    const invalidModes: Array<{
      kind: 'current' | 'past';
      basis: unknown;
      mode: unknown;
    }> = [
      // mês atual variável JAMAIS usa a média mensal completa na referência.
      { kind: 'current', basis: 'monthly_mean', mode: 'variable_pace' },
      // mês atual de compromisso fixo JAMAIS distribui proporcionalmente.
      { kind: 'current', basis: 'expected_to_date', mode: 'monthly_commitment' },
      // mês atual de aportes também distribui JAMAIS proporcionalmente.
      { kind: 'current', basis: 'expected_to_date', mode: 'investment_allocation' },
      // mês passado nunca carrega campos do mês atual.
      { kind: 'past', basis: 'expected_to_date', mode: 'variable_pace' },
      { kind: 'past', basis: 'expected_to_date', mode: 'monthly_commitment' },
      // modo fora da lista fechada.
      { kind: 'current', basis: 'expected_to_date', mode: 'monthly_pace' },
    ];
    for (const combo of invalidModes) {
      const raw = combo.kind === 'past' ? pastPayloadRaw() : clonePayload(currentPayload());
      const categories = raw.categories as Array<Record<string, unknown>>;
      const cat = categories[0];
      cat.referenceBasis = combo.basis;
      cat.mode = combo.mode;
      expect(sanitizeProjectionPayloadV1(raw), JSON.stringify(combo)).toBeUndefined();
    }
  });

  it('payload de mês passado com todas as categorias monthly_mean sobrevive ao round-trip', () => {
    const r = buildProjection({ ...cardFixture(), referenceMonth: { year: 2026, month: 8 } });
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const p = mapProjectionToPayloadV1(r, 'projection_month_comparison') as ProjectionPayloadSuccessV1;
    expect(p.reference.kind).toBe('past');
    for (const c of p.categories) {
      expect(c.referenceBasis).toBe('monthly_mean');
    }
    expect(sanitizeProjectionPayloadV1(clonePayload(p))).toEqual(p);
  });
});

function pastPayloadRaw(): Raw {
  const r = buildProjection({ ...cardFixture(), referenceMonth: { year: 2026, month: 8 } });
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  const p = mapProjectionToPayloadV1(r, 'projection_month_comparison') as ProjectionPayloadSuccessV1;
  return clonePayload(p);
}