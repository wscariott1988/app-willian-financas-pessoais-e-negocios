// pessoal13c4aE6ProjectionForecast.test.ts — PESSOAL-13C4A-E6: projeção dos
// próximos 12 meses (12 cards mensais, zero Gemini).
//
// Provas NODE (sem DOM):
//   1. o motor calcula o forecast para QUALQUER success: horizonte exatamente
//      addMonths(currentMonth, 1)..addMonths(currentMonth, 12), meses
//      consecutivos sem duplicidade;
//   2. a fórmula híbrida mensal (por categoria): estimatedRemaining =
//      max(média mensal da base − registrado no mês, 0); projected =
//      registrado + estimado; e as somas do summary são byte-exatas dos 12
//      meses (sem novo arredondamento);
//   3. registros futuros dentro do horizonte entram; receitas/transferências/
//      deletadas e mês além do horizonte NÃO entram; a lente restringe todos
//      os agregados; o relógio é por MÊS (dia de todayISO não muda o forecast);
//   4. o mapeador expõe forecast SOMENTE em projection_base com reference.kind
//      'current'; categorias/mês atual/comparação/insufficient nunca carregam
//      forecast;
//   5. o sanitizador: idempotente, preserva o forecast em round-trip, aceita
//      payload legado SEM forecast (retrocompatível), e REJEITA forecast
//      inválido (11 meses, mês inicial errado, falhas de consecutividade,
//      invariante projected = registered + estimated violada, summary não
//      byte-exato, negativos, strings, intent não base ou referência passada);
//   6. a fronteira de persistência (sanitizeChatPayload do completeChatTurn)
//      preserva o forecast → fresh === cache === listMessages;
//   7. roteamento: previsão/projeção de 12 meses, previsão anualizada e o novo
//      "cenário de custos" → projection_base determinístico com germiniCallCount
//      0; não-projeções (total_expenses, comparação) e "E a projeção?"
//      continuam intocados;
//   8. o texto novo da base é derivado EXCLUSIVAMENTE do payload (cenário
//      projetado / já lançado / estimativa), sem 'melhor'/'pior', sem
//      'cenário anualizado';
//   9. o adapter consulta transações VIVAS até o fim do 12º mês do horizonte
//      (uma única janela para base + forecast).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../server/supabaseServer', () => {
  class AuthTokenError extends Error {
    constructor(message = 'Token inválido.') {
      super(message);
      this.name = 'AuthTokenError';
    }
  }
  const createUserSupabaseClient = vi.fn();
  return { createUserSupabaseClient, AuthTokenError };
});

import {
  addMonths,
  type PeriodSelection,
} from '../../src/lib/period';
import {
  buildProjection,
  type ProjectionPeriod,
  type ProjectionTransaction,
} from '../../src/lib/analyticsProjection';
import {
  mapProjectionToPayloadV1,
  sanitizeProjectionPayloadV1,
  type ProjectionPayloadSuccessV1,
} from '../../server/finance-ai/projectionPayloadV1';
import { sanitizeChatPayload } from '../../server/chat/payloadSanitize';
import { fetchProjection } from '../../server/finance-ai/projectionAdapter';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';

const TODAY = '2026-09-22';

const PAD2 = (v: number) => String(v).padStart(2, '0');
function keyOf(ym: PeriodSelection): string {
  return `${ym.year}-${PAD2(ym.month)}`;
}

// ── Fixtures do MOTOR (sem Supabase) ─────────────────────────────

const PERIOD_COVERING: ProjectionPeriod[] = [{ accountId: 'acc-a', startsOn: '2025-08-01', endsOn: null }];

function tx(
  occurredOn: string,
  amountCents: number,
  category: 'mercado' | 'transporte',
  over: Partial<ProjectionTransaction> = {},
): ProjectionTransaction {
  return {
    accountId: 'acc-a',
    occurredOn,
    amountCents,
    transactionKind: 'expense',
    categoryId: `c-${category}`,
    categoryLabel: category === 'mercado' ? 'Mercado' : 'Transporte',
    deletedAt: null,
    status: 'paid',
    ...over,
  };
}

/**
 * Base completa de set/2025..ago/2026 (12 meses, Mercado 1000 e Transporte 500
 * por mês → média mensal 1500) + registros DENTRO do horizonte (out/2026 e
 * nov/2026) e exclusões (além do horizonte, receita, transferência, deletada).
 */
function forecastInput(): { todayISO: string; transactions: ProjectionTransaction[]; periods: ProjectionPeriod[] } {
  const transactions: ProjectionTransaction[] = [];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 9 }, i);
    const iso = `${ym.year}-${PAD2(ym.month)}-15`;
    transactions.push(tx(iso, 100000, 'mercado'));
    transactions.push(tx(iso, 50000, 'transporte'));
  }
  transactions.push(tx('2026-10-12', 120000, 'mercado'));
  transactions.push(tx('2026-11-18', 75000, 'transporte'));
  transactions.push(tx('2028-10-01', 99999, 'mercado'));
  transactions.push(tx('2026-10-20', 50000, 'mercado', { transactionKind: 'income' }));
  transactions.push(tx('2026-10-21', 50000, 'mercado', { transactionKind: 'transfer' as const }));
  transactions.push(tx('2026-11-05', 99999, 'mercado', { deletedAt: '2026-11-02' }));
  return { todayISO: TODAY, transactions, periods: PERIOD_COVERING };
}

function monthOf(forecast: ProjectionPayloadSuccessV1['forecast'], key: string) {
  return forecast?.months.find((m) => m.month === key);
}

describe('PESSOAL-13C4A-E6 — motor: forecast nos 12 meses seguintes (híbrido byte-exato)', () => {
  it('horizonte fixo: currentMonth+1..currentMonth+12, consecutivos e sem duplicidade', () => {
    const input = forecastInput();
    const r = buildProjection(input);
    expect(r.status).toBe('success');
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    expect(forecast.horizonStart).toBe('2026-10');
    expect(forecast.horizonEnd).toBe('2027-09');
    expect(forecast.months).toHaveLength(12);
    const keys = forecast.months.map((m) => m.month);
    let expected = addMonths({ year: 2026, month: 9 }, 1);
    for (const key of keys) {
      expect(key).toBe(keyOf(expected));
      expected = addMonths(expected, 1);
    }
    expect(new Set(keys).size).toBe(12);
  });

  it('fórmula híbrida mensal: out>mercado pago (est 0) + transporte média (est); nov>mercado média (est) + transporte maior (est 0)', () => {
    const input = forecastInput();
    const r = buildProjection(input);
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    const oct = monthOf(forecast, '2026-10');
    const nov = monthOf(forecast, '2026-11');
    const any = monthOf(forecast, '2026-12');
    expect(oct).toMatchObject({
      month: '2026-10',
      registeredCents: 120000,
      estimatedRemainingCents: 50000,
      projectedCents: 170000,
      historicalReferenceCents: 150000,
    });
    expect(nov).toMatchObject({
      month: '2026-11',
      registeredCents: 75000,
      estimatedRemainingCents: 100000,
      projectedCents: 175000,
      historicalReferenceCents: 150000,
    });
    expect(any).toMatchObject({
      month: '2026-12',
      registeredCents: 0,
      estimatedRemainingCents: 150000,
      projectedCents: 150000,
      historicalReferenceCents: 150000,
    });
  });

  it('leitura: receitas/transferências/deletadas e mês além do horizonte ficam FORA', () => {
    const input = forecastInput();
    const r = buildProjection(input);
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    const oct = monthOf(forecast, '2026-10');
    const nov = monthOf(forecast, '2026-11');
    expect(oct?.registeredCents).toBe(120000);
    expect(nov?.registeredCents).toBe(75000);
    expect(forecast.horizonEnd).toBe('2027-09');
  });

  it('summary é a soma BYTE-EXATA dos 12 meses (projected = registered + estimated também nos totais)', () => {
    const input = forecastInput();
    const r = buildProjection(input);
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    let registeredCents = 0;
    let estimatedRemainingCents = 0;
    let projectedCents = 0;
    let historicalReferenceCents = 0;
    for (const m of forecast.months) {
      expect(m.projectedCents).toBe(m.registeredCents + m.estimatedRemainingCents);
      registeredCents += m.registeredCents;
      estimatedRemainingCents += m.estimatedRemainingCents;
      projectedCents += m.projectedCents;
      historicalReferenceCents += m.historicalReferenceCents;
    }
    expect(forecast.summary.registeredCents).toBe(registeredCents);
    expect(forecast.summary.estimatedRemainingCents).toBe(estimatedRemainingCents);
    expect(forecast.summary.projectedCents).toBe(projectedCents);
    expect(forecast.summary.projectedCents).toBe(
      forecast.summary.registeredCents + forecast.summary.estimatedRemainingCents,
    );
    expect(forecast.summary.historicalReferenceCents).toBe(historicalReferenceCents);
  });

  it('lente de categoria restringe média, realizado, estimativa e referência do 12 meses', () => {
    const input = forecastInput();
    const r = buildProjection({ ...input, lens: { kind: 'category', categoryPath: 'Mercado' } });
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    const oct = monthOf(forecast, '2026-10');
    const nov = monthOf(forecast, '2026-11');
    expect(oct).toMatchObject({
      month: '2026-10',
      registeredCents: 120000,
      estimatedRemainingCents: 0,
      projectedCents: 120000,
      historicalReferenceCents: 100000,
    });
    expect(nov).toMatchObject({
      month: '2026-11',
      registeredCents: 0,
      estimatedRemainingCents: 100000,
      projectedCents: 100000,
      historicalReferenceCents: 100000,
    });
  });

  it('determinismo: mesmo input → mesmo JSON; o DIA de todayISO não muda o horizonte mês a mês', () => {
    const a = buildProjection(forecastInput());
    const b = buildProjection(forecastInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = buildProjection({ ...forecastInput(), todayISO: '2026-09-05' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });

  it('>8 categorias: TODAS as médias entram no forecast (a capa do payload só limita cards)', () => {
    const transactions: ProjectionTransaction[] = [];
    for (let i = 0; i < 12; i++) {
      const ym = addMonths({ year: 2025, month: 9 }, i);
      const iso = `${ym.year}-${PAD2(ym.month)}-15`;
      for (let c = 0; c < 10; c++) {
        transactions.push(tx(iso, 10000 + c, 'mercado', {
          categoryId: `c-cat${c}`,
          categoryLabel: `Cat ${c}`,
        }));
      }
    }
    const r = buildProjection({ todayISO: TODAY, transactions, periods: PERIOD_COVERING });
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    // 10 categorias × médias 10.000..10.009 = 100.045 por mês de referência;
    // cada mês do horizonte (sem registros) estima exatamente a referência,
    // sem teto de 8 categorias.
    expect(monthOf(forecast, '2026-10')?.estimatedRemainingCents).toBe(100045);
    expect(forecast.summary.projectedCents).toBe(100045 * 12);
  });

  it('status de pagamento NUNCA filtra: transação não-paga futura entra no forecast', () => {
    const transactions: ProjectionTransaction[] = [];
    for (let i = 0; i < 12; i++) {
      const ym = addMonths({ year: 2025, month: 9 }, i);
      const iso = `${ym.year}-${PAD2(ym.month)}-15`;
      transactions.push(tx(iso, 100000, 'mercado', { status: 'scheduled' }));
      transactions.push(tx(iso, 50000, 'transporte', { status: 'pending' }));
    }
    transactions.push(tx('2026-10-12', 120000, 'mercado', { status: 'scheduled' }));
    const r = buildProjection({ todayISO: TODAY, transactions, periods: PERIOD_COVERING });
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    const oct = monthOf(forecast, '2026-10');
    expect(oct?.registeredCents).toBe(120000);
    expect(oct?.projectedCents).toBe(170000);
  });

  it('mês mais distante do horizonte NÃO sai artificialmente baixo (igual à referência média)', () => {
    const r = buildProjection(forecastInput());
    const forecast = (r as Extract<typeof r, { status: 'success' }>).forecast;
    // out/2026 e nov/2026 têm registros (est. menor); os meses seguintes sem
    // registros estimam a referência média INTEGRA — inclusive o 12º mês.
    const clean = monthOf(forecast, '2026-12');
    const last = monthOf(forecast, '2027-09');
    expect(clean?.estimatedRemainingCents).toBe(150000);
    expect(last?.estimatedRemainingCents).toBe(150000);
    expect(last?.historicalReferenceCents).toBe(150000);
  });
});

describe('PESSOAL-13C4A-E6 — mapeador: forecast só em projection_base do mês atual', () => {
  it('base + current → forecast presente com 12 meses e números do motor', () => {
    const r = buildProjection(forecastInput());
    const p = mapProjectionToPayloadV1(r, 'projection_base');
    expect(p.status).toBe('success');
    const success = p as ProjectionPayloadSuccessV1;
    expect(success.forecast).toBeDefined();
    const forecast = success.forecast as NonNullable<ProjectionPayloadSuccessV1['forecast']>;
    expect(forecast.horizonStart).toBe('2026-10');
    expect(forecast.horizonEnd).toBe('2027-09');
    expect(forecast.months).toHaveLength(12);
    expect(forecast.summary.projectedCents).toBe(1845000);
    expect(forecast.summary.registeredCents).toBe(195000);
    expect(forecast.summary.estimatedRemainingCents).toBe(1650000);
    expect(forecast.summary.historicalReferenceCents).toBe(1800000);
  });

  it.each([
    ['projection_categories', 'projection_categories'],
    ['projection_current_month', 'projection_current_month'],
  ] as const)('%s → nunca forecast', (_name, intent) => {
    const r = buildProjection(forecastInput());
    const p = mapProjectionToPayloadV1(r, intent);
    expect(p.status).toBe('success');
    expect('forecast' in (p as ProjectionPayloadSuccessV1)).toBe(false);
  });

  it('mês passado (comparação) → forecast ausente mesmo com intent base', () => {
    const r = buildProjection({ ...forecastInput(), referenceMonth: { year: 2026, month: 7 } });
    const p = mapProjectionToPayloadV1(r, 'projection_base');
    expect(p.status).toBe('success');
    expect('forecast' in (p as ProjectionPayloadSuccessV1)).toBe(false);
  });

  it('insufficient → continua sem forecast', () => {
    const r = buildProjection({ todayISO: TODAY, transactions: [], periods: [] });
    // Sem transações e sem períodos → cobertura 0 → insufficient.
    expect(r.status).toBe('insufficient');
    const p = mapProjectionToPayloadV1(r, 'projection_base');
    expect(p.status).toBe('insufficient');
    expect('forecast' in p).toBe(false);
  });
});

describe('PESSOAL-13C4A-E6 — sanitizador: idempotente, estrito e retrocompatível', () => {
  function mapped(): ProjectionPayloadSuccessV1 {
    const r = buildProjection(forecastInput());
    return mapProjectionToPayloadV1(r, 'projection_base') as ProjectionPayloadSuccessV1;
  }

  it('round-trip preserva o forecast e é idempotente', () => {
    const p = mapped();
    const json = JSON.parse(JSON.stringify(p));
    const once = sanitizeProjectionPayloadV1(json);
    expect(once).toBeDefined();
    expect(once).toStrictEqual(p);
    expect(sanitizeProjectionPayloadV1(once)).toStrictEqual(once);
  });

  it('payload legado (base+current SEM forecast) continua VÁLIDO', () => {
    const p = mapped();
    delete (p as unknown as Record<string, unknown>).forecast;
    const cleaned = sanitizeProjectionPayloadV1(JSON.parse(JSON.stringify(p)));
    expect(cleaned).toStrictEqual(p);
  });

  it.each([
    ['11 meses', (raw: Record<string, unknown>) => { (raw.forecast as Record<string, unknown>).months = ((raw.forecast as Record<string, unknown>).months as unknown[]).slice(0, 11); }],
    ['13 meses', (raw: Record<string, unknown>) => { const m = (raw.forecast as Record<string, unknown>).months as unknown[]; (raw.forecast as Record<string, unknown>).months = [...m, { ...((m[11] as Record<string, unknown>) ?? {}), month: '2027-10' }]; }],
    ['mês inicial errado', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).months as Record<string, unknown>[])[0].month = '2026-11'; }],
    ['mês não consecutivo', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).months as Record<string, unknown>[])[5].month = '2027-01'; }],
    ['horizonEnd diverge do último mês', (raw: Record<string, unknown>) => { (raw.forecast as Record<string, unknown>).horizonEnd = '2027-08'; }],
    ['invariante mensal violada', (raw: Record<string, unknown>) => { const m = ((raw.forecast as Record<string, unknown>).months as Record<string, unknown>[])[0]; m.projectedCents = ((m.projectedCents as number) ?? 0) + 1; }],
    ['summary projetado diverge', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).summary as Record<string, unknown>).projectedCents = 1; }],
    ['summary registrado diverge', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).summary as Record<string, unknown>).registeredCents = 1; }],
    ['summary referência diverge', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).summary as Record<string, unknown>).historicalReferenceCents = 1; }],
    ['valor negativo', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).months as Record<string, unknown>[])[0].estimatedRemainingCents = -1; }],
    ['valor string', (raw: Record<string, unknown>) => { ((raw.forecast as Record<string, unknown>).months as Record<string, unknown>[])[0].registeredCents = '100'; }],
  ])('forecast presente mas inválido (%s) → payload inteiro rejeitado (undefined)', (_name, mutate) => {
    const p = mapped();
    const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    mutate(raw);
    expect(sanitizeProjectionPayloadV1(raw)).toBeUndefined();
  });

  it.each([
    ['forecast em projection_categories', 'projection_categories'],
    ['forecast em projection_current_month', 'projection_current_month'],
    ['forecast em projection_month_comparison', 'projection_month_comparison'],
  ] as const)('%s → rejeitado mesmo com forecast perfeitamente válido', (_name, intent) => {
    const p = mapped();
    p.intent = intent;
    expect(sanitizeProjectionPayloadV1(JSON.parse(JSON.stringify(p)))).toBeUndefined();
  });

  it('forecast em referência PASSADA (kind past) → rejeitado', () => {
    const p = mapped();
    p.reference = { month: '2026-07', kind: 'past' };
    expect(sanitizeProjectionPayloadV1(JSON.parse(JSON.stringify(p)))).toBeUndefined();
  });

  it('forecast injetado em payload INSUFFICIENT → payload inteiro rejeitado (undefined)', () => {
    const insufficient = sanitizeProjectionPayloadV1({
      version: 1,
      status: 'insufficient',
      intent: 'projection_base',
      quality: 'insufficient',
      reference: { month: '2026-09', kind: 'current' },
      coverage: {
        windowMonths: 12,
        coveredMonths: 0,
        minimumCoverageMonths: 6,
        requiredFullCoverageMonths: 12,
        windowStart: '2025-10',
        windowEnd: '2026-09',
      },
      realizedCents: 0,
      reason: { code: 'covered_months_below_minimum', coveredMonths: 0, minimumCoveredMonths: 6 },
      forecast: { _injected: true },
    });
    expect(insufficient).toBeUndefined();
  });

  it('fronteira de persistência: sanitizeChatPayload preserva o forecast e remove lixo injetado', () => {
    const p = mapped();
    const payload = {
      engine: 'deterministic',
      geminiCallCount: 0,
      toolsUsed: ['projection'],
      projection: JSON.parse(JSON.stringify({ ...p, id: 'uuid-fake', transactions: [{ amount: 1 }] })),
    };
    const once = sanitizeChatPayload(payload);
    expect(once.projection).toStrictEqual(p);
    expect(sanitizeChatPayload(once)).toStrictEqual(once);
  });
});

describe('PESSOAL-13C4A-E6 — roteamento determinístico (zero Gemini) e texto novo', () => {
  interface ProjRow {
    transaction_kind?: string | null;
    amount?: number | string | null;
    account_id?: string | null;
    category_id?: string | null;
    occurred_on?: string | null;
    status?: string | null;
    categories?:
      | { display_name: string; canonical_path: string | null }
      | Array<{ display_name: string; canonical_path: string | null }>
      | null;
  }

  function cat(label: string): Array<{ display_name: string; canonical_path: string | null }> {
    return [{ display_name: label, canonical_path: null }];
  }

  function expRow(
    occurred_on: string,
    amount: number,
    category: 'mercado' | 'transporte' | 'anchor',
  ): ProjRow {
    const alias = category === 'mercado' ? 'c-mercado' : category === 'transporte' ? 'c-transporte' : 'c-anchor';
    const label = category === 'mercado' ? 'Mercado' : category === 'transporte' ? 'Transporte' : 'Anchor';
    return {
      transaction_kind: 'expense',
      amount,
      account_id: 'acc-a',
      category_id: alias,
      occurred_on,
      status: 'paid',
      categories: cat(label),
    };
  }

  /** Base completa set/2025..ago/2026 (média mensal R$ 1.000) para TODAY=2026-09-22. */
  function forecastRows(): ProjRow[] {
    const rows: ProjRow[] = [expRow('2025-07-01', 1000, 'anchor')];
    for (let i = 0; i < 12; i++) {
      const ym = addMonths({ year: 2025, month: 9 }, i);
      rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1000, 'mercado'));
    }
    return rows;
  }

  function projClient(rows: ProjRow[]): { fake: unknown; tables: string[] } {
    const tables: string[] = [];
    const base = (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: Record<string, any> = {};
      for (const m of ['is', 'neq', 'gte', 'lte', 'eq', 'in', 'order', 'limit', 'ilike'] as const) {
        c[m] = () => c;
      }
      c.select = () => c;
      c.range = (from: number, to: number) => {
        const ordered = [...rows].sort((a, b) => (a.occurred_on ?? '').localeCompare(b.occurred_on ?? ''));
        const page = ordered.slice(from, to + 1);
        return {
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: page, error: null, count: ordered.length }),
        };
      };
      c.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
      void table;
      return c;
    };
    return {
      fake: {
        from: (t: string) => {
          tables.push(t);
          return base(t);
        },
      },
      tables,
    };
  }

  function brlReais(v: number): string {
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  it.each([
    'Qual a previsão de gastos para os próximos 12 meses?',
    'Qual a projeção de despesas para os próximos 12 meses?',
    'Mostre a projeção de despesas para os próximos 12 meses.',
    'Qual a previsão anualizada?',
    'Qual o cenário de custos para os próximos 12 meses?',
    'Qual o cenário de custo para o próximo ano?',
  ])('"%s" → projection_base determinístico com forecast no payload', async (q) => {
    const { fake, tables } = projClient(forecastRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: TODAY });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_base');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(tables).toContain('transactions');
    expect(tables).toContain('account_profile_periods');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proj = (ans?.response as any)?.projection as ProjectionPayloadSuccessV1;
    expect(proj.forecast).toBeDefined();
    expect(proj.forecast?.months).toHaveLength(12);
  });

  it('texto novo da base: projetado/já lançado/estimativa + base histórica, sem "cenário anualizado"', async () => {
    const { fake, tables } = projClient(forecastRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Qual a previsão de gastos para os próximos 12 meses?',
      nowISO: TODAY,
    });
    expect(ans).not.toBeNull();
    const answer = ans?.response.answer ?? '';
    expect(answer).toContain(brlReais(12000));
    expect(answer).toContain(brlReais(0));
    expect(answer).toContain(brlReais(1000));
    expect(answer).toContain('12 meses cobertos');
    expect(answer).toContain('cenário projetado');
    expect(answer).not.toContain('cenário anualizado');
    expect(answer).not.toContain('melhor');
    expect(answer).not.toContain('pior');
    expect(answer).toContain('sem garantia nem recomendação');
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(['Quanto gastei este mês?', 'Qual a previsão para o mês passado comparada à média dos 12 anteriores?'])(
    'não-projeção "%s" continua nos fluxos existentes (regressão)',
    async (q) => {
      const { fake } = projClient(forecastRows());
      const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: TODAY });
      expect(ans).not.toBeNull();
      expect(ans?.intent).toBe(
        q.startsWith('Quanto gastei') ? 'total_expenses' : 'projection_month_comparison',
      );
    },
  );

  it('ambiguidade "E a projeção?" → esclarecimento sem forecast e sem consulta (regressão)', async () => {
    const { fake, tables } = projClient(forecastRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'E a projeção?', nowISO: TODAY });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_clarification');
    expect(ans?.response.projection).toBeUndefined();
    expect(tables).toHaveLength(0);
  });
});

describe('PESSOAL-13C4A-E6 — adapter: janela do forecast e regressão dos demais intents', () => {
  function capturingFake(): { fake: unknown; until: () => string | null } {
    let capturedUntil: string | null = null;
    const build = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: Record<string, any> = {};
      for (const m of ['is', 'neq', 'gte', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
      c.lte = (col: string, v: string) => {
        if (col === 'occurred_on') capturedUntil = v;
        return c;
      };
      c.select = () => c;
      c.range = () => ({ then: (r: (v: unknown) => unknown) => r({ data: [], error: null, count: 0 }) });
      c.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
      return c;
    };
    return { fake: { from: () => build() }, until: () => capturedUntil };
  }

  it('includeForecastWindow (projection_base) → transações VIVAS até o fim de addMonths(currentMonth, 12)', async () => {
    const { fake, until } = capturingFake();
    const r = await fetchProjection(fake as never, { todayISO: TODAY, includeForecastWindow: true });
    expect(until()).toBe('2027-09-30');
    // Sem transações → covered 0 → insufficient (a janela ainda é a correta).
    expect(r.status).toBe('insufficient');
  });

  it('SEM includeForecastWindow (demais intents) → janela ANTIGA: fim do mês de referência', async () => {
    const { fake, until } = capturingFake();
    const r = await fetchProjection(fake as never, { todayISO: TODAY });
    expect(until()).toBe('2026-09-30');
    expect(r.status).toBe('insufficient');
  });

  it('SEM includeForecastWindow com mês de referência passado → janela ANTIGA: fim daquele mês', async () => {
    const { fake, until } = capturingFake();
    const r = await fetchProjection(fake as never, {
      todayISO: TODAY,
      referenceMonth: { year: 2026, month: 7 },
    });
    expect(until()).toBe('2026-07-31');
    expect(r.status).toBe('insufficient');
  });
});