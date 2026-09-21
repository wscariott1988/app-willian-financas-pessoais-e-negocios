// pessoal13c4aE2ProjectionPayload.test.ts — PESSOAL-13C4A (Fase 4A): contrato
// versionado ProjectionPayloadV1, mapeador único e sanitizador idempotente.
//
// Nenhum Supabase/Gemini/banco/perfil; os resultados do motor vêm de
// buildProjection (fixtures fictícias com relógio injetado). A fronteira
// fechada NÃO está conectada a resposta fresca, cache, listMessages, UI nem
// follow-ups — prova apenas o contrato novo.
//
// Prova que:
//   1. mapeamento full/current: quality 'full', mês corrente, cobertura,
//      resumo e comparação 'expected_to_date' (união discriminada): esperado
//      até o dia + futuros + comprometido + fechamento, e categorias com média
//      + realizado + referência + desvio; sem remaining quando count = 0;
//   2. mapeamento preliminary → união 'expected_to_date';
//   3. mapeamento full/past: reference.kind 'past', união 'monthly_mean' SEM
//      expectedToDateCents/futuros/comprometido/fechamento;
//   4. mapeamento insufficient: só contexto seguro, cobertura, motivo e
//      realizado — nunca summary/comparação/categorias/remaining;
//   5. no máximo oito categorias (com comparativos diretos do motor) +
//      remaining agregado SEM comparativos (o motor não os fornece);
//   6. fechamento: dia < 7 → null; dia ≥ 7 → inteiro seguro (inclusive 0
//      com realizado zero);
//   7. coerência cruzada do sanitizador: current exige 'expected_to_date', past
//      exige 'monthly_mean'; combinações trocadas ou campos atuais injetados no
//      passado → undefined;
//   8. zeros legítimos (inclusive closingProjectionCents 0) são preservados;
//   9. NaN/Infinity/não inteiro/inteiro inseguro → undefined;
//  10. enums fora da allowlist (intent/quality/deviation/referenceBasis/reason)
//      → undefined;
//  11. HTML e caracteres de controle removidos dos rótulos + truncamento;
//  12. IDs/propriedades injetadas removidas recursivamente (campo a campo);
//  13. version ≠ 1 → undefined;
//  14. estruturalmente inválido → undefined (nunca objeto parcial enganoso);
//  15. idempotência e determinismo (sanitize e JSON.stringify estáveis),
//      preservando null e 0 no round-trip.
import { describe, it, expect } from 'vitest';
import {
  buildProjection,
  type ProjectionEngineInput,
  type ProjectionPeriod,
  type ProjectionTransaction,
  type TransactionKind,
} from '../lib/analyticsProjection';
import {
  mapProjectionToPayloadV1,
  sanitizeProjectionPayloadV1,
  PROJECTION_LABEL_MAX,
  type ProjectionPayloadCurrentComparisonV1,
  type ProjectionPayloadInsufficientV1,
  type ProjectionPayloadSuccessV1,
  type ProjectionPayloadV1,
} from '../../server/finance-ai/projectionPayloadV1';

const PAD2 = (v: number) => String(v).padStart(2, '0');

function ymd(y: number, m: number, d: number): string {
  return `${y}-${PAD2(m)}-${PAD2(d)}`;
}

interface Cat {
  id: string | null;
  label: string | null;
}

interface TxOptions {
  account?: string;
  kind?: TransactionKind;
  category?: Cat | null;
  deleted?: string | null;
  status?: string | null;
}

function tx(date: string, cents: number, opts: TxOptions = {}): ProjectionTransaction {
  const cat = opts.category === undefined ? { id: 'c-mercado', label: 'Mercado' } : opts.category;
  return {
    accountId: opts.account ?? 'ACCT-A',
    occurredOn: date,
    amountCents: cents,
    transactionKind: opts.kind ?? 'expense',
    categoryId: cat?.id ?? null,
    categoryLabel: cat?.label ?? null,
    deletedAt: opts.deleted ?? null,
    status: opts.status ?? 'posted',
  };
}

function period(account: string, start: string, end: string | null = null): ProjectionPeriod {
  return { accountId: account, startsOn: start, endsOn: end };
}

function monthlyExpenses(
  start: { year: number; month: number },
  end: { year: number; month: number },
  cents: number,
  opts: TxOptions = {},
): ProjectionTransaction[] {
  const out: ProjectionTransaction[] = [];
  let y = start.year;
  let m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    out.push(tx(ymd(y, m, 15), cents, opts));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const TODAY = '2026-09-16';
const FULL_12 = { year: 2025, month: 9 };
const AUG_2026 = { year: 2026, month: 8 };

type Raw = Record<string, unknown>;

function clonePayload(p: ProjectionPayloadV1): Raw {
  return JSON.parse(JSON.stringify(p)) as Raw;
}

const engineInputs = {
  fullCurrent(): ProjectionEngineInput {
    return {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 100000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
  },
  preliminary(): ProjectionEngineInput {
    return {
      todayISO: TODAY,
      transactions: monthlyExpenses({ year: 2026, month: 3 }, AUG_2026, 100000),
      periods: [period('ACCT-A', '2026-03-01')],
    };
  },
  past(): ProjectionEngineInput {
    return {
      todayISO: TODAY,
      referenceMonth: { year: 2026, month: 7 },
      transactions: [
        ...monthlyExpenses({ year: 2025, month: 7 }, { year: 2026, month: 6 }, 100000),
        tx(ymd(2026, 7, 10), 50000),
        tx(ymd(2026, 8, 10), 999999),
        tx(ymd(2026, 9, 5), 44444),
      ],
      periods: [period('ACCT-A', '2025-07-01')],
    };
  },
  insufficient(): ProjectionEngineInput {
    return {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses({ year: 2026, month: 4 }, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 75000),
      ],
      periods: [period('ACCT-A', '2026-04-01')],
    };
  },
  tenCategories(): ProjectionEngineInput {
    const cats: Cat[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c-${i}`,
      label: `Categoria ${PAD2(i)}`,
    }));
    return {
      todayISO: TODAY,
      transactions: cats.flatMap((c) => monthlyExpenses(FULL_12, AUG_2026, 100000, { category: c })),
      periods: [period('ACCT-A', '2025-09-01')],
    };
  },
  day6(): ProjectionEngineInput {
    return {
      todayISO: '2026-09-06',
      transactions: monthlyExpenses(FULL_12, AUG_2026, 100000),
      periods: [period('ACCT-A', '2025-09-01')],
    };
  },
  day7Zero(): ProjectionEngineInput {
    return {
      todayISO: '2026-09-07',
      transactions: monthlyExpenses(FULL_12, AUG_2026, 100000),
      periods: [period('ACCT-A', '2025-09-01')],
    };
  },
};

function fullPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection(engineInputs.fullCurrent());
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_base') as ProjectionPayloadSuccessV1;
}

function insufficientPayload(): ProjectionPayloadInsufficientV1 {
  const r = buildProjection(engineInputs.insufficient());
  if (r.status !== 'insufficient') throw new Error('fixture deveria ser insufficient');
  return mapProjectionToPayloadV1(r, 'projection_current_month') as ProjectionPayloadInsufficientV1;
}

function pastPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection(engineInputs.past());
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_month_comparison') as ProjectionPayloadSuccessV1;
}

function currentComparison(p: ProjectionPayloadSuccessV1): ProjectionPayloadCurrentComparisonV1 {
  if (p.comparison.referenceBasis !== 'expected_to_date') {
    throw new Error('fixture deveria ser comparação do mês atual');
  }
  return p.comparison;
}

// ============ 1..5. Mapeador único ============

describe('PESSOAL-13C4A Fase 4A — mapeador (mapProjectionToPayloadV1)', () => {
  it('1. full: mês corrente, cobertura, resumo, comparação e categorias; sem remaining', () => {
    const p = fullPayload();
    expect(p.version).toBe(1);
    expect(p.status).toBe('success');
    expect(p.intent).toBe('projection_base');
    expect(p.quality).toBe('full');
    expect(p.reference).toEqual({ month: '2026-09', kind: 'current' });
    expect(p.coverage).toEqual({
      windowMonths: 12,
      coveredMonths: 12,
      minimumCoverageMonths: 6,
      requiredFullCoverageMonths: 12,
      windowStart: '2025-09',
      windowEnd: '2026-08',
    });
    expect(p.summary).toEqual({
      monthlyMeanCents: 100000,
      annualScenarioCents: 1200000,
      totalBaseCents: 1200000,
    });
    expect(p.comparison).toEqual({
      deviation: 'above',
      deviationCents: 46667,
      referenceBasis: 'expected_to_date',
      referenceCents: 53333,
      realizedCents: 100000,
      expectedToDateCents: 53333,
      futureRegisteredCents: 0,
      committedCents: 100000,
      closingProjectionCents: 187500,
    });
    expect(Object.keys(p.comparison).sort()).toEqual([
      'closingProjectionCents',
      'committedCents',
      'deviation',
      'deviationCents',
      'expectedToDateCents',
      'futureRegisteredCents',
      'realizedCents',
      'referenceBasis',
      'referenceCents',
    ]);
    expect(p.categories).toHaveLength(1);
    expect(p.categories[0]).toEqual({
      label: 'Mercado',
      monthlyMeanCents: 100000,
      annualScenarioCents: 1200000,
      realizedCents: 100000,
      referenceCents: 53333,
      deviationCents: 46667,
      deviation: 'above',
      referenceBasis: 'expected_to_date',
      mode: 'variable_pace',
      futureRegisteredCents: 0,
      committedCents: 100000,
    });
    expect(Object.keys(p.categories[0]).sort()).toEqual([
      'annualScenarioCents',
      'committedCents',
      'deviation',
      'deviationCents',
      'futureRegisteredCents',
      'label',
      'mode',
      'monthlyMeanCents',
      'realizedCents',
      'referenceBasis',
      'referenceCents',
    ]);
    expect('remaining' in p).toBe(false);
  });

  it('2. preliminary: quality preliminary, cobertura de 6 meses e base expected_to_date', () => {
    const r = buildProjection(engineInputs.preliminary());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const p = mapProjectionToPayloadV1(r, 'projection_base');
    expect(p.status).toBe('success');
    if (p.status !== 'success') return;
    expect(p.quality).toBe('preliminary');
    expect(p.coverage.coveredMonths).toBe(6);
    expect(p.coverage.windowMonths).toBe(12);
    expect(p.reference.month).toBe('2026-09');
    const cmp = currentComparison(p);
    expect(cmp.referenceBasis).toBe('expected_to_date');
    expect(cmp.expectedToDateCents).toBe(53333);
    expect(cmp.referenceCents).toBe(53333);
    expect(cmp.realizedCents).toBe(0);
    expect(cmp.deviation).toBe('below');
    expect(cmp.deviationCents).toBe(-53333);
    expect(cmp.closingProjectionCents).toBe(0);
  });

  it('3b. fechamento mapeado do motor: dia 6 → null; dia 7 com realizado zero → 0', () => {
    const mk = (input: ProjectionEngineInput) => {
      const r = buildProjection(input);
      if (r.status !== 'success') throw new Error('fixture deveria ser success');
      return mapProjectionToPayloadV1(r, 'projection_base') as ProjectionPayloadSuccessV1;
    };
    const d6 = mk(engineInputs.day6());
    const cmp6 = currentComparison(d6);
    expect(d6.reference.kind).toBe('current');
    expect(cmp6.referenceBasis).toBe('expected_to_date');
    expect(cmp6.closingProjectionCents).toBeNull();
    expect('closingProjectionCents' in cmp6).toBe(true);
    expect(cmp6.expectedToDateCents).toBe(20000);
    expect(cmp6.futureRegisteredCents).toBe(0);
    expect(cmp6.committedCents).toBe(0);

    const d7 = mk(engineInputs.day7Zero());
    const cmp7 = currentComparison(d7);
    expect(d7.reference.kind).toBe('current');
    expect(cmp7.closingProjectionCents).toBe(0);
    expect(cmp7.realizedCents).toBe(0);
    expect(cmp7.expectedToDateCents).toBe(23333);
  });

  it('3. mês passado: reference.kind past e comparação sem futuros/comprometido/fechamento', () => {
    const r = buildProjection(engineInputs.past());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const p = mapProjectionToPayloadV1(r, 'projection_month_comparison');
    expect(p.status).toBe('success');
    if (p.status !== 'success') return;
    expect(p.quality).toBe('full');
    expect(p.reference).toEqual({ month: '2026-07', kind: 'past' });
    expect(p.comparison).toEqual({
      deviation: 'below',
      deviationCents: -50000,
      referenceBasis: 'monthly_mean',
      referenceCents: 100000,
      realizedCents: 50000,
    });
    expect('futureRegisteredCents' in p.comparison).toBe(false);
    expect('committedCents' in p.comparison).toBe(false);
    expect('closingProjectionCents' in p.comparison).toBe(false);
    expect('expectedToDateCents' in p.comparison).toBe(false);
  });

  it('4. insufficient: apenas contexto seguro, cobertura, motivo e realizado', () => {
    const p = insufficientPayload();
    expect(p.version).toBe(1);
    expect(p.status).toBe('insufficient');
    expect(p.intent).toBe('projection_current_month');
    expect(p.quality).toBe('insufficient');
    expect(p.reference).toEqual({ month: '2026-09', kind: 'current' });
    expect(p.coverage.coveredMonths).toBe(5);
    expect(p.coverage.minimumCoverageMonths).toBe(6);
    expect(p.realizedCents).toBe(75000);
    expect(p.reason).toEqual({
      code: 'covered_months_below_minimum',
      coveredMonths: 5,
      minimumCoveredMonths: 6,
    });
    expect('summary' in p).toBe(false);
    expect('comparison' in p).toBe(false);
    expect('categories' in p).toBe(false);
    expect('remaining' in p).toBe(false);
    expect('monthlyMeanCents' in p).toBe(false);
    expect('annualScenarioCents' in p).toBe(false);
    expect('closingProjectionCents' in p).toBe(false);
  });

  it('5. no máximo oito categorias + remaining agregado', () => {
    const r = buildProjection(engineInputs.tenCategories());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const p = mapProjectionToPayloadV1(r, 'projection_categories');
    expect(p.status).toBe('success');
    if (p.status !== 'success') return;
    expect(p.categories).toHaveLength(8);
    expect(p.categories.map((c) => c.label)).toEqual([
      'Categoria 00', 'Categoria 01', 'Categoria 02', 'Categoria 03',
      'Categoria 04', 'Categoria 05', 'Categoria 06', 'Categoria 07',
    ]);
    for (const c of p.categories) {
      expect(Object.keys(c).sort()).toEqual([
        'annualScenarioCents',
        'committedCents',
        'deviation',
        'deviationCents',
        'futureRegisteredCents',
        'label',
        'mode',
        'monthlyMeanCents',
        'realizedCents',
        'referenceBasis',
        'referenceCents',
      ]);
      expect(c.monthlyMeanCents).toBe(100000);
      expect(c.annualScenarioCents).toBe(1200000);
      expect(c.realizedCents).toBe(0);
      expect(c.referenceCents).toBe(53333);
      expect(c.referenceBasis).toBe('expected_to_date');
      expect(c.mode).toBe('variable_pace');
      expect(c.deviationCents).toBe(-53333);
      expect(c.deviation).toBe('below');
      expect(c.futureRegisteredCents).toBe(0);
      expect(c.committedCents).toBe(0);
    }
    expect(p.remaining).toEqual({
      categoriesCount: 2,
      monthlyMeanCents: 200000,
      annualScenarioCents: 2400000,
    });
    expect(p.remaining).not.toHaveProperty('realizedCents');
    expect(p.remaining).not.toHaveProperty('referenceCents');
    expect(p.remaining).not.toHaveProperty('deviationCents');
    expect(p.remaining).not.toHaveProperty('deviation');
  });
});

// ============ 6..13. Sanitizador idempotente ============

describe('PESSOAL-13C4A Fase 4A — sanitizador (sanitizeProjectionPayloadV1)', () => {
  it('6. mapeado full sobrevive ao round-trip sem perda', () => {
    const raw = clonePayload(fullPayload());
    const cleaned = sanitizeProjectionPayloadV1(raw);
    expect(cleaned).toStrictEqual(fullPayload());
  });

  it('7. zeros legítimos são preservados (sucesso e insufficient)', () => {
    const zeroSuccess: Raw = {
      version: 1,
      status: 'success',
      intent: 'projection_base',
      quality: 'full',
      reference: { month: '2026-09', kind: 'current' },
      coverage: {
        windowMonths: 12,
        coveredMonths: 12,
        minimumCoverageMonths: 6,
        requiredFullCoverageMonths: 12,
        windowStart: '2025-09',
        windowEnd: '2026-08',
      },
      summary: { monthlyMeanCents: 0, annualScenarioCents: 0, totalBaseCents: 0 },
      comparison: {
        deviation: 'equal',
        deviationCents: 0,
        referenceBasis: 'expected_to_date',
        referenceCents: 0,
        realizedCents: 0,
        expectedToDateCents: 0,
        futureRegisteredCents: 0,
        committedCents: 0,
        closingProjectionCents: 0,
      },
      categories: [
        {
          label: 'Mercado',
          monthlyMeanCents: 0,
          annualScenarioCents: 0,
          realizedCents: 0,
          referenceBasis: 'expected_to_date',
          mode: 'variable_pace',
          referenceCents: 0,
          deviationCents: 0,
          deviation: 'equal',
          futureRegisteredCents: 0,
          committedCents: 0,
        },
      ],
    };
    const s = sanitizeProjectionPayloadV1(zeroSuccess);
    expect(s).toBeDefined();
    if (s === undefined || s.status !== 'success') return;
    const cmp = currentComparison(s);
    expect(s.summary.monthlyMeanCents).toBe(0);
    expect(cmp.realizedCents).toBe(0);
    expect(cmp.closingProjectionCents).toBe(0);
    expect('closingProjectionCents' in cmp).toBe(true);
    expect(cmp.referenceBasis).toBe('expected_to_date');
    expect(cmp.expectedToDateCents).toBe(0);
    expect('expectedToDateCents' in cmp).toBe(true);
    expect(s.categories[0]?.realizedCents).toBe(0);
    expect(s.categories[0]?.referenceCents).toBe(0);
    expect(s.categories[0]?.deviation).toBe('equal');

    const zeroInsufficient: Raw = {
      version: 1,
      status: 'insufficient',
      intent: 'projection_current_month',
      quality: 'insufficient',
      reference: { month: '2026-09', kind: 'current' },
      coverage: {
        windowMonths: 12,
        coveredMonths: 5,
        minimumCoverageMonths: 6,
        requiredFullCoverageMonths: 12,
        windowStart: '2025-09',
        windowEnd: '2026-08',
      },
      realizedCents: 0,
      reason: {
        code: 'covered_months_below_minimum',
        coveredMonths: 5,
        minimumCoveredMonths: 6,
      },
    };
    const si = sanitizeProjectionPayloadV1(zeroInsufficient);
    expect(si).toBeDefined();
    if (si === undefined || si.status !== 'insufficient') return;
    expect(si.realizedCents).toBe(0);
  });

  it('8. coerência cruzada: current exige expected_to_date; past exige monthly_mean', () => {
    const currentWithMonthlyMean = clonePayload(fullPayload());
    (currentWithMonthlyMean.comparison as Raw).referenceBasis = 'monthly_mean';
    expect(sanitizeProjectionPayloadV1(currentWithMonthlyMean)).toBeUndefined();

    const pastWithExpectedToDate = clonePayload(pastPayload());
    (pastWithExpectedToDate.comparison as Raw).referenceBasis = 'expected_to_date';
    expect(sanitizeProjectionPayloadV1(pastWithExpectedToDate)).toBeUndefined();
  });

  it('9. campos exclusivos do mês atual injetados no passado → undefined', () => {
    const injections: Array<{ key: string; value: unknown }> = [
      { key: 'expectedToDateCents', value: 1 },
      { key: 'futureRegisteredCents', value: 0 },
      { key: 'committedCents', value: 1 },
      { key: 'closingProjectionCents', value: null },
    ];
    for (const inj of injections) {
      const raw = clonePayload(pastPayload());
      (raw.comparison as Raw)[inj.key] = inj.value;
      expect(sanitizeProjectionPayloadV1(raw), inj.key).toBeUndefined();
    }
  });

  it('10. round-trip/idempotência preservando closingProjectionCents null e 0', () => {
    const r6 = buildProjection(engineInputs.day6());
    const r7 = buildProjection(engineInputs.day7Zero());
    if (r6.status !== 'success' || r7.status !== 'success') {
      throw new Error('fixtures deveriam ser success');
    }
    const mapped6 = mapProjectionToPayloadV1(r6, 'projection_base');
    const mapped7 = mapProjectionToPayloadV1(r7, 'projection_base');
    const s6 = sanitizeProjectionPayloadV1(mapped6);
    const s7 = sanitizeProjectionPayloadV1(mapped7);
    expect(s6).toBeDefined();
    expect(s7).toBeDefined();
    expect(s6).toStrictEqual(mapped6);
    expect(s7).toStrictEqual(mapped7);
    if (!s6 || s6.status !== 'success' || !s7 || s7.status !== 'success') return;
    const cmp6 = currentComparison(s6);
    const cmp7 = currentComparison(s7);
    expect(cmp6.closingProjectionCents).toBeNull();
    expect(cmp7.closingProjectionCents).toBe(0);
    expect(JSON.stringify(sanitizeProjectionPayloadV1(s6))).toBe(JSON.stringify(s6));
    expect(JSON.stringify(sanitizeProjectionPayloadV1(s7))).toBe(JSON.stringify(s7));
  });

  it('11. NaN/Infinity/não inteiro/inteiro inseguro → undefined', () => {
    const cases: Array<{ mutate: (raw: Raw) => void; reason: string }> = [
      { reason: 'summary.monthlyMeanCents NaN', mutate: (raw) => { (raw.summary as Raw).monthlyMeanCents = NaN; } },
      { reason: 'summary.annualScenarioCents Infinity', mutate: (raw) => { (raw.summary as Raw).annualScenarioCents = Infinity; } },
      { reason: 'summary.totalBaseCents float', mutate: (raw) => { (raw.summary as Raw).totalBaseCents = 100.5; } },
      { reason: 'summary.monthlyMeanCents inseguro', mutate: (raw) => { (raw.summary as Raw).monthlyMeanCents = Number.MAX_SAFE_INTEGER + 1; } },
      { reason: 'comparison.realizedCents string', mutate: (raw) => { (raw.comparison as Raw).realizedCents = '0'; } },
      { reason: 'comparison.deviationCents NaN', mutate: (raw) => { (raw.comparison as Raw).deviationCents = NaN; } },
      { reason: 'comparison.expectedToDateCents string', mutate: (raw) => { (raw.comparison as Raw).expectedToDateCents = 'x'; } },
      { reason: 'comparison.closingProjectionCents string', mutate: (raw) => { (raw.comparison as Raw).closingProjectionCents = '7'; } },
      { reason: 'comparison.closingProjectionCents float', mutate: (raw) => { (raw.comparison as Raw).closingProjectionCents = 7.5; } },
      { reason: 'comparison.closingProjectionCents negativo', mutate: (raw) => { (raw.comparison as Raw).closingProjectionCents = -1; } },
      { reason: 'comparison.closingProjectionCents inseguro', mutate: (raw) => { (raw.comparison as Raw).closingProjectionCents = Number.MAX_SAFE_INTEGER + 1; } },
      { reason: 'categoria.realizedCents NaN', mutate: (raw) => { ((raw.categories as Raw[])[0] as Raw).realizedCents = NaN; } },
      { reason: 'categoria.referenceCents inseguro', mutate: (raw) => { ((raw.categories as Raw[])[0] as Raw).referenceCents = Number.MAX_SAFE_INTEGER + 1; } },
      { reason: 'coverage.windowMonths negativo', mutate: (raw) => { (raw.coverage as Raw).windowMonths = -1; } },
      { reason: 'coverage.coveredMonths maior que a janela', mutate: (raw) => { (raw.coverage as Raw).coveredMonths = 99; } },
      { reason: 'reference.month malformado', mutate: (raw) => { (raw.reference as Raw).month = '2026-9'; } },
    ];
    for (const c of cases) {
      const raw = clonePayload(fullPayload());
      c.mutate(raw);
      expect(sanitizeProjectionPayloadV1(raw), c.reason).toBeUndefined();
    }
    // Desvio negativo é legítimo (delta); precisa sobreviver.
    const okDelta = clonePayload(fullPayload());
    (okDelta.comparison as Raw).deviationCents = -50000;
    expect(sanitizeProjectionPayloadV1(okDelta)).toBeDefined();
  });

  it('12. enums fora da allowlist (intent/quality/deviation/referenceBasis/reason) → undefined', () => {
    const withIntent = clonePayload(fullPayload());
    withIntent.intent = 'projection_clarification';
    expect(sanitizeProjectionPayloadV1(withIntent)).toBeUndefined();

    const withQuality = clonePayload(fullPayload());
    withQuality.quality = 'weird';
    expect(sanitizeProjectionPayloadV1(withQuality)).toBeUndefined();

    const withDeviation = clonePayload(fullPayload());
    (withDeviation.comparison as Raw).deviation = 'sideways';
    expect(sanitizeProjectionPayloadV1(withDeviation)).toBeUndefined();

    const withBasis = clonePayload(fullPayload());
    (withBasis.comparison as Raw).referenceBasis = 'monthly_projected';
    expect(sanitizeProjectionPayloadV1(withBasis)).toBeUndefined();

    const withCategoryDeviation = clonePayload(fullPayload());
    ((withCategoryDeviation.categories as Raw[])[0] as Raw).deviation = 'sideways';
    expect(sanitizeProjectionPayloadV1(withCategoryDeviation)).toBeUndefined();

    const unknownStatus = clonePayload(fullPayload());
    unknownStatus.status = 'mystery';
    expect(sanitizeProjectionPayloadV1(unknownStatus)).toBeUndefined();

    const badInsufficient = clonePayload(insufficientPayload());
    (badInsufficient.reason as Raw).code = 'invented_reason';
    expect(sanitizeProjectionPayloadV1(badInsufficient)).toBeUndefined();

    const wrongQualityKind = clonePayload(insufficientPayload());
    wrongQualityKind.quality = 'full';
    expect(sanitizeProjectionPayloadV1(wrongQualityKind)).toBeUndefined();
  });

  it('13. HTML e caracteres de controle removidos; rótulo truncado; rótulo vazio → undefined', () => {
    const rawDirty = clonePayload(fullPayload());
    ((rawDirty.categories as unknown[])[0] as Raw).label = '<i>Mercado</i>\u0000\u0007 <script>alert(1)</script>';
    const cleaned = sanitizeProjectionPayloadV1(rawDirty);
    expect(cleaned).toBeDefined();
    if (!cleaned || cleaned.status !== 'success') return;
    expect(cleaned.categories[0]?.label).toBe('Mercado alert(1)');
    expect(cleaned.categories[0]?.label).not.toMatch(/[<>\u0000-\u001f\u007f]/);

    const rawLong = clonePayload(fullPayload());
    ((rawLong.categories as unknown[])[0] as Raw).label = 'A'.repeat(PROJECTION_LABEL_MAX + 10);
    const long = sanitizeProjectionPayloadV1(rawLong);
    expect(long).toBeDefined();
    if (!long || long.status !== 'success') return;
    expect(long.categories[0]?.label).toBe('A'.repeat(PROJECTION_LABEL_MAX));
    expect(long.categories[0]?.label).toHaveLength(PROJECTION_LABEL_MAX);

    const rawEmpty = clonePayload(fullPayload());
    ((rawEmpty.categories as unknown[])[0] as Raw).label = '<b></b>   ';
    expect(sanitizeProjectionPayloadV1(rawEmpty)).toBeUndefined();
  });

  it('14. IDs e propriedades injetadas removidas em todos os níveis (campo a campo)', () => {
    const raw = clonePayload(fullPayload());
    raw.id = 'msg-001';
    raw.profile_id = 'profile-x';
    raw.supabase = { access_token: 'x', user: { id: 'u' } };
    (raw.reference as Raw).referenceMonth = { year: 1, month: 2 };
    (raw.coverage as Raw).months = [1, 2, 3];
    (raw.coverage as Raw).accountId = 'acc-supabase';
    (raw.summary as Raw).coveredMonths = 12;
    (raw.comparison as Raw).kind = 'current';
    (raw.comparison as Raw).row = { description: 'sensível' };
    const cat0 = (raw.categories as unknown[])[0] as Raw;
    cat0.categoryId = 'c-mercado';
    cat0.shareBps = 1200;
    cat0.actualCents = 5;
    cat0.expectedMonthActual = 7;
    cat0.transactions = [{ id: 't-9', description: 'desc' }];
    cat0.answers = ['quanto gastei?', 'sim'];
    cat0.accounts = [{ supabase_obj: { created_at: 'x' } }];

    const cleaned = sanitizeProjectionPayloadV1(raw);
    expect(cleaned).toBeDefined();
    if (cleaned === undefined || cleaned.status !== 'success') return;
    expect(cleaned).toStrictEqual(fullPayload());
    expect(cleaned).not.toHaveProperty('id');
    expect(cleaned).not.toHaveProperty('profile_id');
    expect(cleaned).not.toHaveProperty('supabase');
    expect('transactions' in cleaned.categories[0]).toBe(false);
    expect('answers' in cleaned.categories[0]).toBe(false);
    expect('accounts' in cleaned.categories[0]).toBe(false);
    expect('shareBps' in cleaned.categories[0]).toBe(false);
  });

  it('15. version ≠ 1 (número, string ou ausência) → undefined', () => {
    const v2 = clonePayload(fullPayload());
    v2.version = 2;
    expect(sanitizeProjectionPayloadV1(v2)).toBeUndefined();

    const vStr = clonePayload(fullPayload());
    vStr.version = '1';
    expect(sanitizeProjectionPayloadV1(vStr)).toBeUndefined();

    const noVersion = clonePayload(fullPayload());
    delete noVersion.version;
    expect(sanitizeProjectionPayloadV1(noVersion)).toBeUndefined();
  });

  it('16. estruturalmente inválido → undefined (nunca objeto parcial enganoso)', () => {
    const noCategories = clonePayload(fullPayload());
    delete noCategories.categories;
    expect(sanitizeProjectionPayloadV1(noCategories)).toBeUndefined();

    const objectCategories = clonePayload(fullPayload());
    objectCategories.categories = 'nope';
    expect(sanitizeProjectionPayloadV1(objectCategories)).toBeUndefined();

    const badCategoryItem = clonePayload(fullPayload());
    (badCategoryItem.categories as Raw[])[0] = { label: 'X' };
    expect(sanitizeProjectionPayloadV1(badCategoryItem)).toBeUndefined();

    const noComparison = clonePayload(fullPayload());
    delete noComparison.comparison;
    expect(sanitizeProjectionPayloadV1(noComparison)).toBeUndefined();

    const missingDeviationDelta = clonePayload(fullPayload());
    delete (missingDeviationDelta.comparison as Raw).deviationCents;
    expect(sanitizeProjectionPayloadV1(missingDeviationDelta)).toBeUndefined();

    const missingBasis = clonePayload(fullPayload());
    delete (missingBasis.comparison as Raw).referenceBasis;
    expect(sanitizeProjectionPayloadV1(missingBasis)).toBeUndefined();

    const missingExpectedToDate = clonePayload(fullPayload());
    delete (missingExpectedToDate.comparison as Raw).expectedToDateCents;
    expect(sanitizeProjectionPayloadV1(missingExpectedToDate)).toBeUndefined();

    const missingFuture = clonePayload(fullPayload());
    delete (missingFuture.comparison as Raw).futureRegisteredCents;
    expect(sanitizeProjectionPayloadV1(missingFuture)).toBeUndefined();

    const missingCommitted = clonePayload(fullPayload());
    delete (missingCommitted.comparison as Raw).committedCents;
    expect(sanitizeProjectionPayloadV1(missingCommitted)).toBeUndefined();

    const missingClosing = clonePayload(fullPayload());
    delete (missingClosing.comparison as Raw).closingProjectionCents;
    expect(sanitizeProjectionPayloadV1(missingClosing)).toBeUndefined();

    const missingCategoryRealized = clonePayload(fullPayload());
    delete ((missingCategoryRealized.categories as Raw[])[0] as Raw).realizedCents;
    expect(sanitizeProjectionPayloadV1(missingCategoryRealized)).toBeUndefined();

    const missingCategoryFuture = clonePayload(fullPayload());
    delete ((missingCategoryFuture.categories as Raw[])[0] as Raw).futureRegisteredCents;
    expect(sanitizeProjectionPayloadV1(missingCategoryFuture)).toBeUndefined();

    const missingCategoryCommitted = clonePayload(fullPayload());
    delete ((missingCategoryCommitted.categories as Raw[])[0] as Raw).committedCents;
    expect(sanitizeProjectionPayloadV1(missingCategoryCommitted)).toBeUndefined();

    const badWindowStart = clonePayload(fullPayload());
    (badWindowStart.coverage as Raw).windowStart = '2026/09';
    expect(sanitizeProjectionPayloadV1(badWindowStart)).toBeUndefined();

    const badReason = clonePayload(insufficientPayload());
    delete badReason.reason;
    expect(sanitizeProjectionPayloadV1(badReason)).toBeUndefined();

    const badRemaining = clonePayload(fullPayload());
    badRemaining.remaining = { categoriesCount: 'muitas', monthlyMeanCents: 1, annualScenarioCents: 2 };
    expect(sanitizeProjectionPayloadV1(badRemaining)).toBeUndefined();
  });

  it('17. idempotência e determinismo (sanitize estável e JSON round-trip estável)', () => {
    const mapped = fullPayload();
    expect(JSON.stringify(mapProjectionToPayloadV1(buildProjection(engineInputs.fullCurrent()), 'projection_base'))).toBe(
      JSON.stringify(mapped),
    );

    const rawDirty = clonePayload(mapped);
    rawDirty.id = 'msg-001';
    (rawDirty.categories as unknown[])[0] = { ...(rawDirty.categories as unknown[])[0] as Raw, shareBps: 1111 };

    const s1 = sanitizeProjectionPayloadV1(rawDirty);
    const s2 = sanitizeProjectionPayloadV1(s1);
    expect(s1).toBeDefined();
    expect(s2).toStrictEqual(s1);
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
    expect(JSON.stringify(s1)).toBe(JSON.stringify(mapped));
  });
});