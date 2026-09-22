// analyticsProjection.test.ts — PESSOAL-13C4A-E1: motor puro de cobertura e
// projeção (analyticsProjection.ts).
//
// Fixtures 100% fictícias; nenhum Supabase, Gemini, JWT, banco ou perfil.
// Relógio SEMPRE injetado via todayISO. Nenhuma chamada ao Gemini ou ao banco.
// Cobre os 28 casos obrigatórios do motor puro.
import { describe, it, expect } from 'vitest';
import {
  buildProjection,
  UNCATEGORIZED_LABEL,
  TOP_CATEGORIES_LIMIT,
  type ProjectionEngineInput,
  type ProjectionPeriod,
  type ProjectionTransaction,
  type TransactionKind,
  type YearMonth,
} from '../lib/analyticsProjection';

const PAD2 = (v: number) => String(v).padStart(2, '0');

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

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

function monthKeyOf(r: { key: string }): string {
  return r.key;
}

// ============ 1..5. Qualidade pela cobertura ============

describe('PESSOAL-13C4A-E1 — qualidade pela cobertura', () => {
  it('1. 12 meses cobertos → full, janela exata e cálculos', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 100000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.quality).toBe('full');
    expect(r.basis.windowMonths).toBe(12);
    expect(r.basis.windowStart).toBe('2025-09-01');
    expect(r.basis.windowEnd).toBe('2026-08-31');
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.basis.totalBaseCents).toBe(1200000);
    expect(r.summary.monthlyMeanCents).toBe(100000);
    expect(r.summary.annualScenarioCents).toBe(1200000);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.referenceMonth).toEqual({ year: 2026, month: 9 });
    // PESSOAL-13C4A-E3.7: o mês atual compara o MÊS INTEIRO contra a média.
    expect(r.comparison.realizedCents).toBe(100000);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(0);
    expect(r.comparison.deviation).toBe('equal');
  });

  it('2. 6 meses cobertos → preliminary', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: monthlyExpenses({ year: 2026, month: 3 }, AUG_2026, 100000),
      periods: [period('ACCT-A', '2026-03-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.coveredMonths).toBe(6);
    expect(r.quality).toBe('preliminary');
  });

  it('3. 10 meses cobertos → preliminary', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: monthlyExpenses({ year: 2025, month: 11 }, AUG_2026, 100000),
      periods: [period('ACCT-A', '2025-11-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.coveredMonths).toBe(10);
    expect(r.quality).toBe('preliminary');
  });

  it('4. 11 meses cobertos → preliminary (não vira full)', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: monthlyExpenses({ year: 2025, month: 10 }, AUG_2026, 100000),
      periods: [period('ACCT-A', '2025-10-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.coveredMonths).toBe(11);
    expect(r.quality).toBe('preliminary');
  });

  it('5. 5 meses cobertos → insufficient, sem projeções', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses({ year: 2026, month: 4 }, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 50000),
      ],
      periods: [period('ACCT-A', '2026-04-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('insufficient');
    expect(r.quality).toBe('insufficient');
    if (r.status === 'success') {
      expect(false).toBe(true);
      return;
    }
    expect(r.basis.coveredMonths).toBe(5);
    expect(r.reason.code).toBe('covered_months_below_minimum');
    expect(r.reason.coveredMonths).toBe(5);
    expect(r.realizedCents).toBe(50000);
    expect('summary' in r).toBe(false);
    expect('categories' in r).toBe(false);
    expect('comparison' in r).toBe(false);
  });
});

// ============ 6..10. Regras de cobertura ============

describe('PESSOAL-13C4A-E1 — regras de cobertura', () => {
  it('6. O 13º mês nunca substitui lacuna', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: monthlyExpenses({ year: 2025, month: 9 }, { year: 2025, month: 12 }, 100000),
      periods: [
        period('ACCT-A', '2025-09-01', '2025-12-31'),
        period('ACCT-B', '2025-08-01', '2025-08-31'),
      ],
    };
    const r = buildProjection(input);
    expect(r.basis.windowMonths).toBe(12);
    expect(r.basis.months.map(monthKeyOf)).toEqual([
      '2025-09', '2025-10', '2025-11', '2025-12',
      '2026-01', '2026-02', '2026-03', '2026-04',
      '2026-05', '2026-06', '2026-07', '2026-08',
    ]);
    const coveredKeys = r.basis.months.filter((m) => m.covered).map(monthKeyOf);
    expect(coveredKeys).toEqual(['2025-09', '2025-10', '2025-11', '2025-12']);
    expect(r.basis.coveredMonths).toBe(4);
    expect(r.status).toBe('insufficient');
  });

  it('7. Mês coberto sem transação conta como zero', () => {
    const txs = monthlyExpenses(FULL_12, AUG_2026, 100000).filter(
      (t) => !t.occurredOn.startsWith('2026-03-'),
    );
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: txs,
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const mar = r.basis.months.find((m) => m.key === '2026-03');
    expect(mar?.covered).toBe(true);
    expect(mar?.cents).toBe(0);
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.basis.totalBaseCents).toBe(1100000);
    expect(r.summary.monthlyMeanCents).toBe(91667);
    expect(r.summary.annualScenarioCents).toBe(1100004);
  });

  it('8. Mês somente com receita conta como zero de despesa', () => {
    const monthly = monthlyExpenses(FULL_12, AUG_2026, 100000).filter(
      (t) => !t.occurredOn.startsWith('2026-04-'),
    );
    const incomeMonth = [
      tx(ymd(2026, 4, 10), 500000, { kind: 'income', category: null }),
      tx(ymd(2026, 4, 20), 250000, { kind: 'income', category: null }),
    ];
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [...monthly, ...incomeMonth],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const apr = r.basis.months.find((m) => m.key === '2026-04');
    expect(apr?.covered).toBe(true);
    expect(apr?.cents).toBe(0);
    expect(r.basis.totalBaseCents).toBe(1100000);
  });

  it('9. Primeiro mês parcial fica fora — fallback sem períodos', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        tx(ymd(2025, 10, 15), 100000),
        ...monthlyExpenses({ year: 2025, month: 11 }, AUG_2026, 100000),
      ],
      periods: [],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const sep = r.basis.months.find((m) => m.key === '2025-09');
    const oct = r.basis.months.find((m) => m.key === '2025-10');
    const nov = r.basis.months.find((m) => m.key === '2025-11');
    expect(sep?.covered).toBe(false);
    expect(oct?.covered).toBe(false);
    expect(nov?.covered).toBe(true);
    expect(r.basis.coveredMonths).toBe(10);
    expect(r.basis.totalBaseCents).toBe(1000000);
    expect(r.quality).toBe('preliminary');
  });

  it('10. Lacuna entre períodos fica fora (nunca preenchida)', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: monthlyExpenses({ year: 2025, month: 9 }, AUG_2026, 100000),
      periods: [
        period('ACCT-A', '2025-09-01', '2025-11-30'),
        period('ACCT-A', '2026-03-01'),
      ],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    for (const k of ['2025-12', '2026-01', '2026-02']) {
      expect(r.basis.months.find((m) => m.key === k)?.covered).toBe(false);
    }
    expect(r.basis.coveredMonths).toBe(9);
    expect(r.quality).toBe('preliminary');
  });
});

// ============ 11..13. Múltiplas contas ============

describe('PESSOAL-13C4A-E1 — múltiplas contas', () => {
  it('11. Duas contas podem, juntas, cobrir o mês', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        tx(ymd(2025, 9, 10), 100000, { account: 'ACCT-A' }),
        ...monthlyExpenses({ year: 2025, month: 10 }, AUG_2026, 100000, { account: 'ACCT-B' }),
      ],
      periods: [
        period('ACCT-A', '2025-09-01', '2025-09-15'),
        period('ACCT-B', '2025-09-16'),
      ],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const sep = r.basis.months.find((m) => m.key === '2025-09');
    expect(sep?.covered).toBe(true);
    expect(sep?.cents).toBe(100000);
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.quality).toBe('full');
  });

  it('12. Conta nova não invalida meses cobertos por outra conta', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: monthlyExpenses(FULL_12, AUG_2026, 100000),
      periods: [
        period('ACCT-A', '2025-09-01'),
        period('ACCT-NOVA', '2026-08-16'),
      ],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.quality).toBe('full');
  });

  it('13. Transação fora do período da própria conta fica fora', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        tx(ymd(2025, 10, 15), 100000, { account: 'ACCT-A' }),
        tx(ymd(2025, 10, 15), 50000, { account: 'ACCT-B' }),
        ...monthlyExpenses({ year: 2025, month: 11 }, AUG_2026, 100000, { account: 'ACCT-A' }),
      ],
      periods: [
        period('ACCT-A', '2025-09-01'),
        period('ACCT-B', '2026-03-01'),
      ],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const oct = r.basis.months.find((m) => m.key === '2025-10');
    expect(oct?.covered).toBe(true);
    expect(oct?.cents).toBe(100000);
    expect(r.basis.totalBaseCents).toBe(1100000);
  });
});

// ============ 14..17. Filtros canônicos ============

describe('PESSOAL-13C4A-E1 — filtros canônicos', () => {
  function baseInput(extra: ProjectionTransaction[] = []): ProjectionEngineInput {
    return {
      todayISO: TODAY,
      transactions: [...monthlyExpenses(FULL_12, AUG_2026, 100000), ...extra],
      periods: [period('ACCT-A', '2025-09-01')],
    };
  }

  it('14. Soft-deleted fica fora', () => {
    const deleted = tx(ymd(2025, 12, 10), 99000, { deleted: '2026-01-05' });
    const r = buildProjection(baseInput([deleted]));
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.totalBaseCents).toBe(1200000);
  });

  it('15. Status ignored não é filtrado', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000).filter(
          (t) => !t.occurredOn.startsWith('2026-06-'),
        ),
        tx(ymd(2026, 6, 15), 100000, { status: 'ignored' }),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.totalBaseCents).toBe(1200000);
    expect(r.summary.monthlyMeanCents).toBe(100000);
  });

  it('16. Transferência fica fora', () => {
    const transfer = tx(ymd(2025, 10, 15), 50000, { kind: 'transfer', category: null });
    const r = buildProjection(baseInput([transfer]));
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.totalBaseCents).toBe(1200000);
  });

  it('17. Receita fica fora', () => {
    const income = tx(ymd(2025, 10, 15), 30000, { kind: 'income', category: null });
    const r = buildProjection(baseInput([income]));
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.totalBaseCents).toBe(1200000);
  });
});

// ============ 18..21. Mês atual: mês inteiro vs média mensal ============

describe('PESSOAL-13C4A-E1 — mês atual (PESSOAL-13C4A-E3.7)', () => {
  it('18. Mês atual soma o mês inteiro; somente expense ativa entra', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 1000),
        tx(ymd(2026, 9, 20), 50000),
        tx(ymd(2026, 9, 21), 90000, { kind: 'income', category: null }),
        tx(ymd(2026, 9, 22), 70000, { kind: 'transfer', category: null }),
        tx(ymd(2026, 9, 23), 60000, { deleted: '2026-09-24' }),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    // Lançamento de 09-20 (após o todayISO 09-16) entra no total do mês.
    expect(r.comparison.realizedCents).toBe(51000);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(-49000);
    expect(r.comparison.deviation).toBe('below');
  });

  it('19. Mês inteiro independe do dia do todayISO', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 16), 100000),
        tx(ymd(2026, 9, 20), 50000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(150000);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(50000);
    expect(r.comparison.deviation).toBe('above');
    expect('expectedToDateCents' in r.comparison).toBe(false);
    expect('closingProjectionCents' in r.comparison).toBe(false);
  });

  it('20. Mês atual em 05-09: total do mês inteiro, sem proração', () => {
    const input: ProjectionEngineInput = {
      todayISO: '2026-09-05',
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 3), 100000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(100000);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(0);
    expect(r.comparison.deviation).toBe('equal');
    expect('closingProjectionCents' in r.comparison).toBe(false);
    expect('expectedToDateCents' in r.comparison).toBe(false);
  });

  it('21. Mês atual em 07-09: mesmo saldo, comparação vs média mensal', () => {
    const input: ProjectionEngineInput = {
      todayISO: '2026-09-07',
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 7), 70000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(70000);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(-30000);
    expect(r.comparison.deviation).toBe('below');
  });
});

// ============ 22. Mês passado ============

describe('PESSOAL-13C4A-E1 — mês passado selecionado', () => {
  it('22. Mês passado não usa dados posteriores', () => {
    const input: ProjectionEngineInput = {
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
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.quality).toBe('full');
    expect(r.basis.windowStart).toBe('2025-07-01');
    expect(r.basis.windowEnd).toBe('2026-06-30');
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.basis.totalBaseCents).toBe(1200000);
    expect(r.comparison.kind).toBe('past');
    if (r.comparison.kind !== 'past') return;
    expect(r.comparison.referenceMonth).toEqual({ year: 2026, month: 7 });
    expect(r.comparison.realizedCents).toBe(50000);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(-50000);
    expect(r.comparison.deviation).toBe('below');
  });

  it('22b. Mês passado não calcula esperado/proração (kind past, sem closing)', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      referenceMonth: { year: 2026, month: 6 },
      transactions: [
        ...monthlyExpenses({ year: 2025, month: 6 }, { year: 2026, month: 5 }, 100000),
        tx(ymd(2026, 6, 10), 120000),
      ],
      periods: [period('ACCT-A', '2025-06-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.comparison.kind).toBe('past');
    if (r.comparison.kind !== 'past') return;
    expect('expectedToDateCents' in r.comparison).toBe(false);
    expect('closingProjectionCents' in r.comparison).toBe(false);
    expect(r.comparison.realizedCents).toBe(120000);
    expect(r.comparison.deviation).toBe('above');
  });
});

// ============ 23..25. Categorias ============

describe('PESSOAL-13C4A-E1 — categorias', () => {
  it('23. Categoria usa o denominador do perfil', () => {
    const aluguel = { id: 'c-aluguel', label: 'Aluguel' };
    const mercado = { id: 'c-mercado', label: 'Mercado' };
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000, { category: aluguel }),
        ...monthlyExpenses(FULL_12, AUG_2026, 20000, { category: mercado }),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const aluguelRow = r.categories.find((c) => c.label === 'Aluguel');
    const mercadoRow = r.categories.find((c) => c.label === 'Mercado');
    expect(aluguelRow?.monthlyMeanCents).toBe(100000);
    expect(aluguelRow?.annualScenarioCents).toBe(1200000);
    expect(aluguelRow?.shareBps).toBe(8333);
    expect(mercadoRow?.monthlyMeanCents).toBe(20000);
    expect(mercadoRow?.shareBps).toBe(1667);
    expect(r.summary.monthlyMeanCents).toBe(120000);
    const sumShares =
      (r.categories.reduce((acc, c) => acc + c.shareBps, 0) +
        r.remainingCategories.remainingShareBps);
    expect(sumShares).toBe(10000);
  });

  it('24. "Sem categoria" permanece separado', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 40000, { category: null }),
        ...monthlyExpenses(FULL_12, AUG_2026, 60000, {
          category: { id: 'c-aluguel', label: 'Aluguel' },
        }),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    const semCategoria = r.categories.find((c) => c.label === UNCATEGORIZED_LABEL);
    const aluguelRow = r.categories.find((c) => c.label === 'Aluguel');
    expect(semCategoria).toBeDefined();
    expect(aluguelRow).toBeDefined();
    expect(semCategoria?.monthlyMeanCents).toBe(40000);
    expect(aluguelRow?.monthlyMeanCents).toBe(60000);
    expect(semCategoria?.label).not.toBe(aluguelRow?.label);
    expect(r.categories.length).toBeGreaterThanOrEqual(2);
  });

  it('25. Top 8 e agregado restante (sem somar médias arredondadas)', () => {
    const cats: Cat[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c-${i}`,
      label: `Categoria ${PAD2(i)}`,
    }));
    const extra = monthlyExpenses(FULL_12, AUG_2026, 0);
    const txs = cats.flatMap((c) => {
      const base = monthlyExpenses(FULL_12, AUG_2026, 100000, { category: c });
      void extra;
      return base;
    });
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: txs,
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.categories).toHaveLength(TOP_CATEGORIES_LIMIT);
    expect(r.categories.map((c) => c.label)).toEqual([
      'Categoria 00', 'Categoria 01', 'Categoria 02', 'Categoria 03',
      'Categoria 04', 'Categoria 05', 'Categoria 06', 'Categoria 07',
    ]);
    expect(r.remainingCategories.remainingCategoriesCount).toBe(2);
    expect(r.remainingCategories.remainingMonthlyMeanCents).toBe(200000);
    expect(r.remainingCategories.remainingAnnualScenarioCents).toBe(2400000);
    expect(r.remainingCategories.remainingShareBps).toBe(2000);
    const sumShares =
      r.categories.reduce((acc, c) => acc + c.shareBps, 0) +
      r.remainingCategories.remainingShareBps;
    expect(sumShares).toBe(10000);
  });
});

// ============ 26..27. Determinismo e insuficiência ============

describe('PESSOAL-13C4A-E1 — determinismo e insuficiência', () => {
  it('26. Cálculos determinísticos e idempotentes', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses({ year: 2025, month: 9 }, { year: 2026, month: 2 }, 83332),
        ...monthlyExpenses({ year: 2026, month: 3 }, AUG_2026, 83334),
        tx(ymd(2026, 9, 10), 30000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.totalBaseCents).toBe(999996);
    expect(r.summary.monthlyMeanCents).toBe(83333);
    expect(r.summary.annualScenarioCents).toBe(999996);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(30000);
    expect(r.comparison.referenceCents).toBe(83333);
    expect(r.comparison.deviationCents).toBe(-53333);
    const first = JSON.stringify(r);
    const second = JSON.stringify(buildProjection(input));
    expect(second).toBe(first);
  });

  it('27. Insuficiente não inventa projeções nem valores zero', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses({ year: 2026, month: 4 }, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 75000),
      ],
      periods: [period('ACCT-A', '2026-04-01')],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('insufficient');
    if (r.status === 'success') {
      expect(false).toBe(true);
      return;
    }
    expect('summary' in r).toBe(false);
    expect('categories' in r).toBe(false);
    expect('comparison' in r).toBe(false);
    expect('closingProjectionCents' in r).toBe(false);
    expect('monthlyMeanCents' in r).toBe(false);
    expect('annualScenarioCents' in r).toBe(false);
    expect(r.realizedCents).toBe(75000);
    expect(r.basis.coveredMonths).toBe(5);
    expect(r.reason.coveredMonths).toBe(5);
  });
});

// ============ 28. Relógio e validação de entrada ============

describe('PESSOAL-13C4A-E1 — relógio injetado e validação', () => {
  it('28. todayISO controla a janela e o mês de referência', () => {
    const agos2026: ProjectionEngineInput = {
      todayISO: '2026-08-10',
      transactions: [
        ...monthlyExpenses({ year: 2025, month: 8 }, { year: 2026, month: 7 }, 100000),
        tx(ymd(2026, 8, 5), 100000),
      ],
      periods: [period('ACCT-A', '2025-08-01')],
    };
    const rAug = buildProjection(agos2026);
    expect(rAug.status).toBe('success');
    if (rAug.status !== 'success') return;
    expect(rAug.quality).toBe('full');
    expect(rAug.basis.windowStart).toBe('2025-08-01');
    expect(rAug.basis.windowEnd).toBe('2026-07-31');
    expect(rAug.comparison.kind).toBe('current');
    if (rAug.comparison.kind !== 'current') return;
    expect(rAug.comparison.referenceMonth).toEqual({ year: 2026, month: 8 });
    expect(rAug.comparison.realizedCents).toBe(100000);

    const set2026: ProjectionEngineInput = {
      todayISO: '2026-09-10',
      transactions: [
        ...monthlyExpenses({ year: 2025, month: 9 }, { year: 2026, month: 8 }, 100000),
        tx(ymd(2026, 9, 5), 100000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    };
    const rSet = buildProjection(set2026);
    expect(rSet.status).toBe('success');
    if (rSet.status !== 'success') return;
    expect(rSet.quality).toBe('full');
    expect(rSet.basis.windowStart).toBe('2025-09-01');
    expect(rSet.basis.windowEnd).toBe('2026-08-31');
    expect(rSet.comparison.kind).toBe('current');
    if (rSet.comparison.kind !== 'current') return;
    expect(rSet.comparison.referenceMonth).toEqual({ year: 2026, month: 9 });
    expect(rSet.comparison.realizedCents).toBe(100000);

    expect(rAug.basis.windowStart).not.toBe(rSet.basis.windowStart);
  });

  it('28b. todayISO inválido lança RangeError', () => {
    expect(() =>
      buildProjection({
        todayISO: '2026-13-40',
        transactions: [],
        periods: [],
      }),
    ).toThrow(RangeError);
  });

  it('28c. referenceMonth futuro lança RangeError', () => {
    expect(() =>
      buildProjection({
        todayISO: '2026-09-16',
        referenceMonth: { year: 2026, month: 10 },
        transactions: [],
        periods: [],
      }),
    ).toThrow(RangeError);
  });

  it('28d. referenceMonth no futuro distante lança RangeError', () => {
    expect(() =>
      buildProjection({
        todayISO: '2026-09-16',
        referenceMonth: { year: 2027, month: 1 },
        transactions: [],
        periods: [],
      }),
    ).toThrow(RangeError);
  });
});

// ============ 29..33. Grupos permanentes (PESSOAL-13C4A-E1) ============

describe('PESSOAL-13C4A-E1 — períodos persistidos prevalecem sobre fallback', () => {
  it('com período persistido, o fallback nunca estende a cobertura', () => {
    const txs = [
      tx(ymd(2025, 10, 1), 100000),
      ...monthlyExpenses({ year: 2025, month: 11 }, AUG_2026, 100000),
    ];
    const persisted = buildProjection({
      todayISO: TODAY,
      transactions: txs,
      periods: [period('ACCT-A', '2025-11-01')],
    });
    expect(persisted.status).toBe('success');
    if (persisted.status !== 'success') return;
    expect(persisted.basis.months.find((m) => m.key === '2025-10')?.covered).toBe(false);
    expect(persisted.basis.coveredMonths).toBe(10);
    expect(persisted.basis.totalBaseCents).toBe(1000000);
    expect(persisted.quality).toBe('preliminary');

    const fallback = buildProjection({
      todayISO: TODAY,
      transactions: txs,
      periods: [],
    });
    expect(fallback.status).toBe('success');
    if (fallback.status !== 'success') return;
    expect(fallback.basis.months.find((m) => m.key === '2025-10')?.covered).toBe(true);
    expect(fallback.basis.coveredMonths).toBe(11);
    expect(fallback.basis.totalBaseCents).toBe(1100000);
  });
});

describe('PESSOAL-13C4A-E1 — fallback ignora transação deletada ao determinar o início', () => {
  it('soft-deleted não vira ponto de início do fallback', () => {
    const input: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        tx(ymd(2025, 9, 15), 99000, { deleted: '2025-10-20' }),
        ...monthlyExpenses({ year: 2025, month: 10 }, AUG_2026, 100000),
      ],
      periods: [],
    };
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.basis.months.find((m) => m.key === '2025-09')?.covered).toBe(false);
    expect(r.basis.months.find((m) => m.key === '2025-10')?.covered).toBe(false);
    expect(r.basis.coveredMonths).toBe(10);
    expect(r.basis.totalBaseCents).toBe(1000000);
    expect(r.quality).toBe('preliminary');
  });
});

describe('PESSOAL-13C4A-E1 — 7, 8 e 9 meses resultam em preliminary', () => {
  it('cobertura de 7, 8 e 9 meses → preliminary (não full)', () => {
    const startOf = (count: number): YearMonth => {
      const idx = 2026 * 12 + 7 - (count - 1);
      return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
    };
    for (const count of [7, 8, 9]) {
      const start = startOf(count);
      const r = buildProjection({
        todayISO: TODAY,
        transactions: monthlyExpenses(start, AUG_2026, 100000),
        periods: [period('ACCT-A', ymd(start.year, start.month, 1))],
      });
      expect(r.status).toBe('success');
      if (r.status !== 'success') continue;
      expect(r.basis.coveredMonths).toBe(count);
      expect(r.quality).toBe('preliminary');
    }
  });
});

describe('PESSOAL-13C4A-E1 — inputs profundamente congelados não são modificados', () => {
  it('deep-freeze não quebra e o resultado é idêntico ao não congelado', () => {
    const build = (): ProjectionEngineInput => ({
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 100000),
        tx(ymd(2026, 9, 10), 1000),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
    });
    const base = build();
    const frozen = deepFreeze(build());
    expect(() => buildProjection(frozen)).not.toThrow();
    const r = buildProjection(frozen);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(JSON.stringify(buildProjection(base))).toBe(JSON.stringify(r));
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.quality).toBe('full');
  });
});

describe('PESSOAL-13C4A-E1 — mês atual sem lançamentos retorna 0, não null', () => {
  it('realizado zero no mês atual → realizedCents 0 vs média 100000 (below)', () => {
    const r = buildProjection({
      todayISO: '2026-09-07',
      transactions: monthlyExpenses(FULL_12, AUG_2026, 100000),
      periods: [period('ACCT-A', '2025-09-01')],
    });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(0);
    expect(r.comparison.referenceCents).toBe(100000);
    expect(r.comparison.deviationCents).toBe(-100000);
    expect(r.comparison.deviation).toBe('below');
    expect(r.comparison.referenceCents).not.toBeNull();
  });
});

// ============ PESSOAL-13C4A-E3: motor com lente ============

describe('PESSOAL-13C4A-E3 — motor: lente de categoria restringe todos os agregados', () => {
  const SUPER = { id: 'c-super', label: 'Alimentação > Supermercado' };
  const TRANSP = { id: 'c-transp', label: 'Transporte' };

  const input = (lens: unknown): ProjectionEngineInput => ({
    todayISO: TODAY,
    transactions: [
      ...monthlyExpenses(FULL_12, AUG_2026, 60000, { category: SUPER }),
      ...monthlyExpenses(FULL_12, AUG_2026, 40000, { category: TRANSP }),
      tx(ymd(2026, 9, 10), 60000, { category: SUPER }),
      tx(ymd(2026, 9, 10), 40000, { category: TRANSP }),
    ],
    periods: [period('ACCT-A', '2025-09-01')],
    ...(lens ? { lens: lens as ProjectionEngineInput['lens'] } : {}),
  });

  it('sem lente: média 100000 e realizado 100000 (linha de base)', () => {
    const r = buildProjection(input(undefined));
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.summary.monthlyMeanCents).toBe(100000);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(100000);
  });

  it('lente de categoria: média/cenário/realizado só da categoria, qualidade intacta (full)', () => {
    const r = buildProjection(input({ kind: 'category', categoryPath: 'Alimentação > Supermercado' }));
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.quality).toBe('full');
    expect(r.basis.windowMonths).toBe(12);
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.basis.totalBaseCents).toBe(720000);
    expect(r.summary.monthlyMeanCents).toBe(60000);
    expect(r.summary.annualScenarioCents).toBe(720000);
    expect(r.summary.totalBaseCents).toBe(720000);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(60000);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0].label).toBe('Alimentação > Supermercado');
    expect(r.categories[0].monthlyMeanCents).toBe(60000);
  });

  it('lente de segmento inclui descendentes canônicos e exclui irmãos', () => {
    const desc = { id: 'c-emb', label: 'Alimentação > Supermercado > Embalagens' };
    const hortifruti = { id: 'c-hort', label: 'Alimentação > Hortifruti' };
    const input2: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 60000, { category: SUPER }),
        ...monthlyExpenses(FULL_12, AUG_2026, 20000, { category: desc }),
        ...monthlyExpenses(FULL_12, AUG_2026, 10000, { category: hortifruti }),
        tx(ymd(2026, 9, 10), 60000, { category: SUPER }),
        tx(ymd(2026, 9, 10), 20000, { category: desc }),
        tx(ymd(2026, 9, 10), 10000, { category: hortifruti }),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
      lens: { kind: 'category', categoryPath: 'Alimentação > Supermercado' },
    };
    const r = buildProjection(input2);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.summary.monthlyMeanCents).toBe(80000);
    expect(r.summary.annualScenarioCents).toBe(960000);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(80000);
    const labels = r.categories.map((c) => c.label).sort();
    expect(labels).toEqual(['Alimentação > Supermercado', 'Alimentação > Supermercado > Embalagens']);
    expect(labels.join(',')).not.toMatch(/Hortifruti/);
  });
});

describe('PESSOAL-13C4A-E3 — motor: lente "sem categoria" restringe a despesas sem categoria', () => {
  it('uncategorized: só entram despesas com categoryId nulo (média/cenário/realizado/categorias)', () => {
    const SUPER = { id: 'c-super', label: 'Alimentação > Supermercado' };
    const input2: ProjectionEngineInput = {
      todayISO: TODAY,
      transactions: [
        ...monthlyExpenses(FULL_12, AUG_2026, 60000, { category: SUPER }),
        ...monthlyExpenses(FULL_12, AUG_2026, 30000, { category: null }),
        tx(ymd(2026, 9, 10), 60000, { category: SUPER }),
        tx(ymd(2026, 9, 10), 30000, { category: null }),
      ],
      periods: [period('ACCT-A', '2025-09-01')],
      lens: { kind: 'uncategorized' },
    };
    const r = buildProjection(input2);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.quality).toBe('full');
    expect(r.summary.monthlyMeanCents).toBe(30000);
    expect(r.summary.annualScenarioCents).toBe(360000);
    expect(r.basis.totalBaseCents).toBe(360000);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind !== 'current') return;
    expect(r.comparison.realizedCents).toBe(30000);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0].label).toBe(UNCATEGORIZED_LABEL);
    expect(r.categories[0].monthlyMeanCents).toBe(30000);
  });
});