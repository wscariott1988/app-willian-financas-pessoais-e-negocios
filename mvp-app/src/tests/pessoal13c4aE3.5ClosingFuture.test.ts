// pessoal13c4aE3.5ClosingFuture.test.ts — PESSOAL-13C4A-E3.5: lançamentos
// futuros participam do fechamento do mês atual e são expostos POR CATEGORIA.
// No nível do motor + contrato:
//
//   1. comparison do mês atual: closingProjectionCents = ritmo do realizado
//      (round(realized*30/elapsed)) + futuros já registrados, com mínimo =
//      committedCents (realizado + futuros) — NUNCA abaixo dele;
//   2. antes do 7º dia, closing é null, MAS futuros/comprometido continuam
//      presentes no comparison;
//   3. dias completos (29): fechamento ≈ realizado (futuro já virou
//      realizado) e continua >= committed;
//   4. por categoria, no mês atual: futureRegisteredCents e committedCents
//      presentes — variáveis comparam o REALIZADO contra a referência
//      proporcional; compromissos fixos e aportes comparam o JÁ LANÇADO
//      (realizado + futuros) contra a média mensal completa;
//   5. mês passado: NENHUMA dessas informações existe (nem por categoria);
//   6. contrato: mapeador só as expõe no mês atual; sanitizador rejeita
//      payload de mês passado que as carregue e exige ambas no mês atual.
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
 * Fixture canônica da E3.5: Aluguel (monthly_commitment), Supermercado e
 * mercado (variable_pace, mesmos valores → empate de médias resolvido por
 * label, nunca por índice) com histórico de 12 meses (2025-09..2026-08).
 * Hoje = 2026-09-21 → fração do mês = 21/30.
 *
 * Realizado em setembro: Supermercado 10/09 12.398 + Aluguel 12/09 50.500.
 * Futuros registrados (após 21/09): Aluguel 22/09 180.000 + Supermercado
 * 22/09 77.500 + mercado 26/09 10.000 → 267.500.
 *
 * comparison: realizado 62.898, futuros 267.500, comprometido = 330.398;
 * média mensal = 504.919 → esperado 21/30 = 353.443;
 * ritmo = round(62.898*30/21) = 89.854 → fechamento 89.854 + 267.500 =
 * 357.354 (jamais < 330.398).
 *
 * Categorias: Aluguel comprometido 230.500 contra média 184.659 → +45.841
 * above; Supermercado realizado 12.398 contra proporcional round(160130*21/30)
 * = 112.091 → −99.693 below; mercado realizado 0 contra 112.091 → −112.091.
 */
function closingFutureFixture(): ProjectionEngineInput {
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
  const r = buildProjection(closingFutureFixture());
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_categories') as ProjectionPayloadSuccessV1;
}

function pastPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection({
    ...closingFutureFixture(),
    referenceMonth: { year: 2026, month: 8 },
  });
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_month_comparison') as ProjectionPayloadSuccessV1;
}

describe('PESSOAL-13C4A-E3.5 — fechamento soma lançamentos futuros (comparison)', () => {
  it('rumo do mês atual: realizado + futuros + ritmo → fechamento 357354 >= comprometido 330398', () => {
    const r = buildProjection(closingFutureFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'current') throw new Error('comparison deveria ser current');
    expect(c.kind).toBe('current');
    expect(c.realizedCents).toBe(62898);
    expect(c.futureCents).toBe(267500);
    expect(c.committedCents).toBe(330398);
    expect(c.expectedToDateCents).toBe(353443);
    // O ritmo (sem campo próprio) é formado INLINE no fechamento:
    // round(realizado*30/21) + futuros, com mínimo = comprometido.
    const paceInline = Math.round(c.realizedCents * 30 / 21);
    expect(c.closingProjectionCents).toBe(paceInline + c.futureCents);
    expect(c.closingProjectionCents).toBe(357354);
    expect((c.closingProjectionCents as number) >= c.committedCents).toBe(true);
  });

  it('antes do 7º dia o fechamento é null, MAS futuros e comprometido seguem presentes', () => {
    const r = buildProjection({ ...closingFutureFixture(), todayISO: '2026-09-03' });
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'current') throw new Error('comparison deveria ser current');
    expect(c.kind).toBe('current');
    // Nada foi realizado antes de 03/09; todo o conteúdo virou futuro.
    expect(c.realizedCents).toBe(0);
    expect(c.futureCents).toBe(330398);
    expect(c.committedCents).toBe(330398);
    expect(c.closingProjectionCents).toBeNull();
  });

  it('dia 29 (mês quase completo): futuro virou realizado e o fechamento nunca cai abaixo do comprometido', () => {
    const r = buildProjection({ ...closingFutureFixture(), todayISO: '2026-09-29' });
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'current') throw new Error('comparison deveria ser current');
    expect(c.kind).toBe('current');
    expect(c.realizedCents).toBe(330398);
    expect(c.futureCents).toBe(0);
    expect(c.committedCents).toBe(330398);
    expect((c.closingProjectionCents as number) >= c.committedCents).toBe(true);
    expect(c.closingProjectionCents).toBe(341791);
  });
});

describe('PESSOAL-13C4A-E3.5 — futuros por categoria no mês atual', () => {
  it('Aluguel (monthly_commitment) compara o JÁ LANÇADO contra a média completa: +45841 above', () => {
    const aluguel = buildProjection(closingFutureFixture());
    if (aluguel.status !== 'success') throw new Error('fixture deveria ser success');
    const c = aluguel.categories.find((x) => x.label === 'Aluguel');
    if (!c) throw new Error('Aluguel não encontrado');
    expect(c.actualCents).toBe(50500);
    expect(c.futureRegisteredCents).toBe(180000);
    expect(c.committedCents).toBe(230500);
    expect(c.referenceCents).toBe(184659);
    expect(c.deviationCents).toBe(45841);
    expect(c.deviation).toBe('above');
  });

  it('variáveis comparam o REALIZADO: Supermercado −99693 e mercado −112091, com futuros expostos', () => {
    const r = buildProjection(closingFutureFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const supermercado = r.categories.find((x) => x.label === 'Supermercado');
    const mercado = r.categories.find((x) => x.label === 'mercado');
    if (!supermercado || !mercado) throw new Error('categorias variáveis não encontradas');
    expect(supermercado.actualCents).toBe(12398);
    expect(supermercado.futureRegisteredCents).toBe(77500);
    expect(supermercado.committedCents).toBe(89898);
    expect(supermercado.referenceCents).toBe(112091);
    expect(supermercado.deviationCents).toBe(-99693);
    expect(supermercado.deviation).toBe('below');
    expect(mercado.actualCents).toBe(0);
    expect(mercado.futureRegisteredCents).toBe(10000);
    expect(mercado.committedCents).toBe(10000);
    expect(mercado.referenceCents).toBe(112091);
    expect(mercado.deviationCents).toBe(-112091);
    expect(mercado.deviation).toBe('below');
  });

  it('empate de médias (Supermercado × mercado): `.find` por rótulo, nunca por índice', () => {
    const r = buildProjection(closingFutureFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    expect(r.categories.length).toBe(3);
    expect(r.categories[0].monthlyMeanCents).toBe(184659);
  });
});

describe('PESSOAL-13C4A-E3.5 — mês passado NÃO guarda futuros por categoria', () => {
  it('categorias de agosto/2026 sem futureRegisteredCents/committedCents e sem comparação com fechamento', () => {
    const r = buildProjection({
      ...closingFutureFixture(),
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

describe('PESSOAL-13C4A-E3.5 — contrato: mapeador e sanitizador por categoria', () => {
  it('payload do mês atual expõe futuros/comprometido por categoria e sobrevive ao round-trip', () => {
    const p = currentPayload();
    expect(p.reference.kind).toBe('current');
    const aluguel = p.categories.find((c) => c.label === 'Aluguel') as ProjectionPayloadSuccessV1['categories'][number];
    const supermercado = p.categories.find((c) => c.label === 'Supermercado') as ProjectionPayloadSuccessV1['categories'][number];
    expect(aluguel.futureRegisteredCents).toBe(180000);
    expect(aluguel.committedCents).toBe(230500);
    expect(supermercado.futureRegisteredCents).toBe(77500);
    expect(supermercado.committedCents).toBe(89898);
    expect(p.comparison).toMatchObject({
      futureRegisteredCents: 267500,
      committedCents: 330398,
      closingProjectionCents: 357354,
    });
    expect(sanitizeProjectionPayloadV1(clonePayload(p))).toEqual(p);
  });

  it('payload do mês passado sem os campos de mês atual sobrevive ao round-trip', () => {
    const p = pastPayload();
    expect(p.reference.kind).toBe('past');
    for (const c of p.categories) {
      expect('futureRegisteredCents' in c).toBe(false);
      expect('committedCents' in c).toBe(false);
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

  it('mês atual exige AMBAS as novas por categoria: faltando uma → payload undefined', () => {
    const raw = clonePayload(currentPayload());
    const categories = raw.categories as Array<Record<string, unknown>>;
    delete categories[0].committedCents;
    expect(sanitizeProjectionPayloadV1(raw)).toBeUndefined();
    const raw2 = clonePayload(currentPayload());
    const categories2 = raw2.categories as Array<Record<string, unknown>>;
    delete categories2[1].futureRegisteredCents;
    expect(sanitizeProjectionPayloadV1(raw2)).toBeUndefined();
  });
});