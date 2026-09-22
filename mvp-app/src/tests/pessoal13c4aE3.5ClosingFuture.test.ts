// pessoal13c4aE3.5ClosingFuture.test.ts — PESSOAL-13C4A-E3.5, revisto em
// PESSOAL-13C4A-E3.7: com o mês atual avaliado pelo MÊS INTEIRO contra a média
// mensal, os conceitos de "fechamento estimado por ritmo" e de
// "futuros/comprometido por categoria" deixaram de existir no motor e no
// contrato (ficando apenas como LEITURA LEGADA no sanitizador). Esta prova
// verifica, no nível motor + contrato:
//
//   1. comparison do mês atual: realizedCents soma o mês INTEIRO (inclusive os
//      lançamentos com data POSTERIOR ao todayISO) e referenceCents é a média
//      mensal completa — NENHUM campo de ritmo/fechamento/futuro existe;
//   2. o saldo do mês independe do dia do todayISO (03, 21 e 29 → idênticos);
//   3. por categoria: realizedCents = total do mês na categoria contra a média
//      mensal (mesma base monthly_mean em todos os modos);
//   4. mês passado: continua avaliado por mês inteiro, sem qualquer campo do
//      mês atual;
//   5. contrato: o mapeador emite SEMPRE monthly_mean (mês atual e passado); o
//      sanitizador rejeita payload com os campos do legado injetados e aceita a
//      leitura LEGADA (expected_to_date) com os quatro campos.
import { describe, it, expect } from 'vitest';
import {
  buildProjection,
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

const FULL_12 = { year: 2025, month: 9 };
const AUG_2026 = { year: 2026, month: 8 };

/**
 * Fixture canônica do E3.5/E3.7: Aluguel (monthly_commitment), Supermercado e
 * mercado (variable_pace, mesmos valores → empate de médias resolvido por
 * label) com histórico de 12 meses (2025-09..2026-08). Hoje = 2026-09-21.
 *
 * Lançamentos de setembro (TODOS no mês): Supermercado 10/09 12.398 + 22/09
 * 77.500; Aluguel 12/09 50.500 + 22/09 180.000; mercado 26/09 10.000.
 *
 * comparison: realizedCents = 330.398 (mês INTEIRO, inclusive os lançamentos
 * de 22/09 e 26/09, posteriores ao todayISO); média mensal = 504.919 →
 * −174.521 abaixo.
 *
 * Categorias (base monthly_mean): Aluguel 230.500 contra 184.659 → +45.841
 * above; Supermercado 89.898 contra 160.130 → −70.232 below; mercado 10.000
 * contra 160.130 → −150.130 below.
 */
function fullMonthFixture(): ProjectionEngineInput {
  return {
    todayISO: '2026-09-21',
    transactions: [
      ...monthly(FULL_12, AUG_2026, 184659, 'Aluguel'),
      ...monthly(FULL_12, AUG_2026, 160130, 'Supermercado'),
      ...monthly(FULL_12, AUG_2026, 160130, 'mercado'),
      tx(ymd(2026, 9, 10), 12398, 'Supermercado'),
      tx(ymd(2026, 9, 12), 50500, 'Aluguel'),
      tx(ymd(2026, 9, 22), 180000, 'Aluguel'),
      tx(ymd(2026, 9, 22), 77500, 'Supermercado'),
      tx(ymd(2026, 9, 26), 10000, 'mercado'),
    ],
    periods: [period('ACCT-A', '2025-09-01')],
  };
}

type Raw = Record<string, unknown>;

function clonePayload(p: ProjectionPayloadV1): Raw {
  return JSON.parse(JSON.stringify(p)) as Raw;
}

function currentPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection(fullMonthFixture());
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_categories') as ProjectionPayloadSuccessV1;
}

function pastPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection({
    ...fullMonthFixture(),
    referenceMonth: { year: 2026, month: 8 },
  });
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_month_comparison') as ProjectionPayloadSuccessV1;
}

describe('PESSOAL-13C4A-E3.5 — mês atual: total do mês inteiro vs média mensal', () => {
  it('comparison: realizado 330398 (mês inteiro) vs média 504919 → −174521 below', () => {
    const r = buildProjection(fullMonthFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'current') throw new Error('comparison deveria ser current');
    expect(c.kind).toBe('current');
    // Lançamentos de 22/09 e 26/09 (posteriores ao todayISO) entram no total.
    expect(c.realizedCents).toBe(330398);
    expect(c.referenceCents).toBe(504919);
    expect(c.deviationCents).toBe(-174521);
    expect(c.deviation).toBe('below');
    expect('closingProjectionCents' in c).toBe(false);
    expect('futureCents' in c).toBe(false);
    expect('committedCents' in c).toBe(false);
    expect('expectedToDateCents' in c).toBe(false);
  });

  it('o saldo do mês independe do dia do todayISO (03, 21 e 29 → idênticos)', () => {
    const r3 = buildProjection({ ...fullMonthFixture(), todayISO: '2026-09-03' });
    const r21 = buildProjection(fullMonthFixture());
    const r29 = buildProjection({ ...fullMonthFixture(), todayISO: '2026-09-29' });
    for (const r of [r3, r21, r29]) {
      expect(r.status).toBe('success');
      if (r.status !== 'success') continue;
      if (r.comparison.kind !== 'current') throw new Error('comparison deveria ser current');
      expect(r.comparison.realizedCents).toBe(330398);
      expect(r.comparison.deviation).toBe('below');
    }
    expect(JSON.stringify(r3)).toBe(JSON.stringify(r21));
    expect(JSON.stringify(r29)).toBe(JSON.stringify(r21));
  });
});

describe('PESSOAL-13C4A-E3.5 — categorias: total do mês vs média mensal', () => {
  it('Aluguel (monthly_commitment): 230500 contra 184659 → +45841 above', () => {
    const aluguel = buildProjection(fullMonthFixture());
    if (aluguel.status !== 'success') throw new Error('fixture deveria ser success');
    const c = aluguel.categories.find((x) => x.label === 'Aluguel');
    if (!c) throw new Error('Aluguel não encontrado');
    expect(c.actualCents).toBe(230500);
    expect(c.referenceCents).toBe(184659);
    expect(c.referenceBasis).toBe('monthly_mean');
    expect(c.deviationCents).toBe(45841);
    expect(c.deviation).toBe('above');
    expect('futureRegisteredCents' in c).toBe(false);
    expect('committedCents' in c).toBe(false);
  });

  it('variáveis usam a mesma base mensal: Supermercado −70232 e mercado −150130', () => {
    const r = buildProjection(fullMonthFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const supermercado = r.categories.find((x) => x.label === 'Supermercado');
    const mercado = r.categories.find((x) => x.label === 'mercado');
    if (!supermercado || !mercado) throw new Error('categorias variáveis não encontradas');
    expect(supermercado.actualCents).toBe(89898);
    expect(supermercado.referenceCents).toBe(160130);
    expect(supermercado.deviationCents).toBe(-70232);
    expect(supermercado.deviation).toBe('below');
    expect(mercado.actualCents).toBe(10000);
    expect(mercado.referenceCents).toBe(160130);
    expect(mercado.deviationCents).toBe(-150130);
    expect(mercado.deviation).toBe('below');
  });

  it('empate de médias (Supermercado × mercado): `.find` por rótulo, nunca por índice', () => {
    const r = buildProjection(fullMonthFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    expect(r.categories.length).toBe(3);
    expect(r.categories[0].monthlyMeanCents).toBe(184659);
  });
});

describe('PESSOAL-13C4A-E3.5 — mês passado NÃO guarda campos do mês atual', () => {
  it('categorias de agosto/2026 sem futureRegisteredCents/committedCents e sem fechamento', () => {
    const r = buildProjection({
      ...fullMonthFixture(),
      referenceMonth: { year: 2026, month: 8 },
    });
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'past') throw new Error('comparison deveria ser past');
    expect(c.kind).toBe('past');
    expect(c.realizedCents).toBe(504919);
    expect('closingProjectionCents' in c).toBe(false);
    expect('futureCents' in c).toBe(false);
    expect('committedCents' in c).toBe(false);
    for (const cat of r.categories) {
      expect('futureRegisteredCents' in cat).toBe(false);
      expect('committedCents' in cat).toBe(false);
      expect(cat.referenceBasis).toBe('monthly_mean');
    }
  });
});

describe('PESSOAL-13C4A-E3.5 — contrato: mapeador e sanitizador', () => {
  it('payload do mês atual é monthly_mean (sem futuros/comprometido) e sobrevive ao round-trip', () => {
    const p = currentPayload();
    expect(p.reference.kind).toBe('current');
    const aluguel = p.categories.find((c) => c.label === 'Aluguel') as ProjectionPayloadSuccessV1['categories'][number];
    const supermercado = p.categories.find((c) => c.label === 'Supermercado') as ProjectionPayloadSuccessV1['categories'][number];
    expect(aluguel.referenceBasis).toBe('monthly_mean');
    expect(supermercado.referenceBasis).toBe('monthly_mean');
    expect('futureRegisteredCents' in aluguel).toBe(false);
    expect('committedCents' in aluguel).toBe(false);
    expect('futureRegisteredCents' in supermercado).toBe(false);
    expect('committedCents' in supermercado).toBe(false);
    expect(p.comparison).toEqual({
      deviation: 'below',
      deviationCents: -174521,
      referenceBasis: 'monthly_mean',
      referenceCents: 504919,
      realizedCents: 330398,
    });
    expect(sanitizeProjectionPayloadV1(clonePayload(p))).toEqual(p);
  });

  it('payload do mês passado sem os campos de mês atual sobrevive ao round-trip', () => {
    const p = pastPayload();
    expect(p.reference.kind).toBe('past');
    for (const c of p.categories) {
      expect('futureRegisteredCents' in c).toBe(false);
      expect('committedCents' in c).toBe(false);
      expect(c.referenceBasis).toBe('monthly_mean');
    }
    expect(sanitizeProjectionPayloadV1(clonePayload(p))).toEqual(p);
  });

  it('mês passado com future/committed injetados por categoria → payload undefined', () => {
    const raw = clonePayload(pastPayload());
    const categories = raw.categories as Array<Record<string, unknown>>;
    categories[0].futureRegisteredCents = 1;
    expect(sanitizeProjectionPayloadV1(raw)).toBeUndefined();
    const raw2 = clonePayload(pastPayload());
    const categories2 = raw2.categories as Array<Record<string, unknown>>;
    categories2[0].committedCents = 1;
    expect(sanitizeProjectionPayloadV1(raw2)).toBeUndefined();
  });

  it('mês atual novo com campos do legado injetados (comparison ou categoria) → payload undefined', () => {
    const raw = clonePayload(currentPayload());
    (raw.comparison as Record<string, unknown>).futureRegisteredCents = 267500;
    expect(sanitizeProjectionPayloadV1(raw)).toBeUndefined();
    const raw2 = clonePayload(currentPayload());
    const categories2 = raw2.categories as Array<Record<string, unknown>>;
    categories2[0].committedCents = 1;
    expect(sanitizeProjectionPayloadV1(raw2)).toBeUndefined();
  });
});