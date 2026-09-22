// pessoal13c4aE3.7FullMonth.test.ts — PESSOAL-13C4A-E3.7 (aceitação): o mês
// ATUAL é avaliado pelo MÊS INTEIRO contra a média mensal dos 12 meses
// anteriores, em todas as camadas.
//
// Prova, com a mesma massa de dados de aceitação do smoke-real:
//   - categories de setembro/2026 (LANÇAMENTOS TODOS NO MÊS, inclusive os com
//     data posterior ao todayISO):
//       Supermercado 12.398 (10/09) + 19.503 (29/09) = 31.901  vs  160.130
//         → −128.229 below
//       Combustível 26.000 (15/09)                                        vs   77.342
//         → −51.342 below
//       Almoço 66.500 (05/09)                                             vs   46.583
//         → +19.917 above
//       Investimentos 74.000 (20/09)                                      vs   76.039
//         → −2.039 below
//       Aluguel 192.780 (20/09)                                           vs  184.659
//         → +8.121 above
//     comparison: realizado 391.181 (mês inteiro) vs média 544.753 → −153.572
//     below — o antigo "fechamento" por proração (que em 21/09 valia ~37.214)
//     NÃO existe mais;
//   - o texto do mês atual usou (exatamente) as frases de média mensal:
//       "No mês atual, o total lançado é de X, contra a média mensal de Y dos
//        12 meses anteriores (Z abaixo da média mensal)."
//       "Novos lançamentos ainda podem alterar o total do mês."
//     e NUNCA as palavras de ritmo/proração/futuros/comprometido do pré-E3.7;
//   - o mês atual independe do dia do todayISO (05/09 e 21/09 → resposta igual);
//   - mês passado permanece avaliado por mês inteiro (igual à média em 08/2026
//     porque todos os meses da base têm o mesmo valor);
//   - contrato: mapeador emite SEMPRE monthly_mean; sanitizador rejeita payload
//     novo com campos do legado injetados e aceita a leitura LEGADA
//     (expected_to_date com os quatro campos).
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
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import { addMonths } from '../lib/period';

const PAD2 = (v: number) => String(v).padStart(2, '0');

function ymd(y: number, m: number, d: number): string {
  return `${y}-${PAD2(m)}-${PAD2(d)}`;
}

function tx(
  date: string,
  cents: number,
  label: string,
  catId: string,
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
  catId: string,
): ProjectionTransaction[] {
  const out: ProjectionTransaction[] = [];
  let y = start.year;
  let m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    out.push(tx(ymd(y, m, 15), cents, label, catId));
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

// Médias mensais da base (2025-09..2026-08) — as mesmas do smoke-real de
// aceitação.
const CATS = [
  { label: 'Supermercado', id: 'c-supermercado', mean: 160130, day: 10, cents: 12398 },
  { label: 'Combustível', id: 'c-combustivel', mean: 77342, day: 15, cents: 26000 },
  { label: 'Almoço', id: 'c-almoco', mean: 46583, day: 5, cents: 66500 },
  { label: 'Investimentos', id: 'c-investimentos', mean: 76039, day: 20, cents: 74000 },
  { label: 'Aluguel', id: 'c-aluguel', mean: 184659, day: 20, cents: 192780 },
];

const TOTAL_MEAN = 544753; // 160130 + 77342 + 46583 + 76039 + 184659
const TOTAL_REALIZED = 391181; // 31901 + 26000 + 66500 + 74000 + 192780
const TOTAL_DEVIATION = -153572; // 391181 − 544753

/** Formata CENTAVOS como reais (o roteador fala reais; o contrato guarda centavos). */
function brlCentsOf(cents: number): string {
  return brlReais(cents / 100);
}

/** Massa de dados de aceitação: base de 12 meses + lançamentos de setembro. */
function monthFixture(): ProjectionEngineInput {
  const transactions = CATS.flatMap((c) => monthly(FULL_12, AUG_2026, c.mean, c.label, c.id));
  // Supermercado tem DOIS lançamentos no mês (10/09 e 29/09) = 31.901.
  transactions.push(tx('2026-09-10', 12398, 'Supermercado', 'c-supermercado'));
  transactions.push(tx('2026-09-29', 19503, 'Supermercado', 'c-supermercado'));
  // Demais categorias: um lançamento cada, todas no mês.
  transactions.push(tx('2026-09-15', 26000, 'Combustível', 'c-combustivel'));
  transactions.push(tx('2026-09-05', 66500, 'Almoço', 'c-almoco'));
  transactions.push(tx('2026-09-20', 74000, 'Investimentos', 'c-investimentos'));
  transactions.push(tx('2026-09-20', 192780, 'Aluguel', 'c-aluguel'));
  return {
    todayISO: '2026-09-21',
    transactions,
    periods: [period('ACCT-A', '2025-09-01')],
  };
}

type Raw = Record<string, unknown>;

function clonePayload(p: ProjectionPayloadV1): Raw {
  return JSON.parse(JSON.stringify(p)) as Raw;
}

function currentPayload(): ProjectionPayloadSuccessV1 {
  const r = buildProjection(monthFixture());
  if (r.status !== 'success') throw new Error('fixture deveria ser success');
  return mapProjectionToPayloadV1(r, 'projection_categories') as ProjectionPayloadSuccessV1;
}

describe('PESSOAL-13C4A-E3.7 — aceitação: mês atual pelo MÊS INTEIRO (nível motor)', () => {
  it('categories de setembro com os valores exatos do smoke-real, base sempre monthly_mean', () => {
    const r = buildProjection(monthFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const byLabel = new Map(r.categories.map((c) => [c.label, c]));

    const supermercado = byLabel.get('Supermercado');
    if (!supermercado) throw new Error('Supermercado não encontrado');
    expect(supermercado.actualCents).toBe(31901);
    expect(supermercado.referenceCents).toBe(160130);
    expect(supermercado.referenceBasis).toBe('monthly_mean');
    expect(supermercado.deviationCents).toBe(-128229);
    expect(supermercado.deviation).toBe('below');

    const combustivel = byLabel.get('Combustível');
    if (!combustivel) throw new Error('Combustível não encontrado');
    expect(combustivel.actualCents).toBe(26000);
    expect(combustivel.referenceCents).toBe(77342);
    expect(combustivel.deviationCents).toBe(-51342);
    expect(combustivel.deviation).toBe('below');

    const almoco = byLabel.get('Almoço');
    if (!almoco) throw new Error('Almoço não encontrado');
    expect(almoco.actualCents).toBe(66500);
    expect(almoco.referenceCents).toBe(46583);
    expect(almoco.deviationCents).toBe(19917);
    expect(almoco.deviation).toBe('above');

    const investimentos = byLabel.get('Investimentos');
    if (!investimentos) throw new Error('Investimentos não encontrado');
    expect(investimentos.actualCents).toBe(74000);
    expect(investimentos.referenceCents).toBe(76039);
    expect(investimentos.deviationCents).toBe(-2039);
    expect(investimentos.deviation).toBe('below');

    const aluguel = byLabel.get('Aluguel');
    if (!aluguel) throw new Error('Aluguel não encontrado');
    expect(aluguel.actualCents).toBe(192780);
    expect(aluguel.referenceCents).toBe(184659);
    expect(aluguel.referenceBasis).toBe('monthly_mean');
    expect(aluguel.deviationCents).toBe(8121);
    expect(aluguel.deviation).toBe('above');

    // Nenhum conceito de fechamento/futuro por categoria.
    for (const cat of r.categories) {
      expect('futureRegisteredCents' in cat).toBe(false);
      expect('committedCents' in cat).toBe(false);
    }
  });

  it('comparison: realizado 391181 (mês inteiro, inclusive lançamentos posteriores ao day 21) vs média 544753 → −153572', () => {
    const r = buildProjection(monthFixture());
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'current') throw new Error('comparison deveria ser current');
    expect(c.realizedCents).toBe(TOTAL_REALIZED);
    expect(c.referenceCents).toBe(TOTAL_MEAN);
    expect(c.deviationCents).toBe(TOTAL_DEVIATION);
    expect(c.deviation).toBe('below');
    expect('expectedToDateCents' in c).toBe(false);
    expect('futureCents' in c).toBe(false);
    expect('committedCents' in c).toBe(false);
    expect('closingProjectionCents' in c).toBe(false);
  });

  it('mês atual independe do dia do todayISO (05/09 e 21/09 → JSON idêntico); NUNCA vale o antigo fechamento 37.214', () => {
    const r5 = buildProjection({ ...monthFixture(), todayISO: '2026-09-05' });
    const r21 = buildProjection(monthFixture());
    if (r5.status !== 'success' || r21.status !== 'success') {
      throw new Error('fixture deveria ser success');
    }
    expect(JSON.stringify(r5)).toBe(JSON.stringify(r21));
    // O antigo fechamento por proração (21/30 da média) não existe mais.
    const serialized = JSON.stringify(r21);
    expect(serialized).not.toContain('closingProjectionCents');
    expect(serialized).not.toContain('37214');
  });

  it('mês passado (agosto/2026) continua mês inteiro: realizado = média → igual (sem campos do mês atual)', () => {
    const r = buildProjection({ ...monthFixture(), referenceMonth: { year: 2026, month: 8 } });
    if (r.status !== 'success') throw new Error('fixture deveria ser success');
    const c = r.comparison;
    if (c.kind !== 'past') throw new Error('comparison deveria ser past');
    expect(c.realizedCents).toBe(TOTAL_MEAN);
    expect(c.referenceCents).toBe(TOTAL_MEAN);
    expect(c.deviationCents).toBe(0);
    expect(c.deviation).toBe('equal');
    for (const cat of r.categories) {
      expect(cat.referenceBasis).toBe('monthly_mean');
      expect('futureRegisteredCents' in cat).toBe(false);
    }
  });
});

// Reaproveita o cliente Supabase determinístico dos testes de roteamento.
interface ProjRow {
  transaction_kind?: string | null;
  amount?: number | string | null;
  account_id?: string | null;
  category_id?: string | null;
  occurred_on?: string | null;
  status?: string | null;
  categories?: Array<{ display_name: string; canonical_path: string | null }> | null;
}

function catRow(label: string, id: string): Array<{ display_name: string; canonical_path: string | null }> {
  return [{ display_name: label, canonical_path: id }];
}

function expRow(occurredOn: string, amount: number, label: string, id: string): ProjRow {
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: id,
    occurred_on: occurredOn,
    status: 'paid',
    categories: catRow(label, id),
  };
}

function projRows(): ProjRow[] {
  const rows: ProjRow[] = [];
  for (const c of CATS) {
    for (let i = 0; i < 12; i++) {
      const ym = addMonths(FULL_12, i);
      rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, c.mean / 100, c.label, c.id));
    }
  }
  rows.push(expRow('2026-09-10', 12398 / 100, 'Supermercado', 'c-supermercado'));
  rows.push(expRow('2026-09-29', 19503 / 100, 'Supermercado', 'c-supermercado'));
  rows.push(expRow('2026-09-15', 260, 'Combustível', 'c-combustivel'));
  rows.push(expRow('2026-09-05', 665, 'Almoço', 'c-almoco'));
  rows.push(expRow('2026-09-20', 740, 'Investimentos', 'c-investimentos'));
  rows.push(expRow('2026-09-20', 1927.8, 'Aluguel', 'c-aluguel'));
  return rows;
}

function projClient(rows: ProjRow[]) {
  const sourceOf = (table: string) => (table === 'transactions' ? rows : []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    for (const m of ['is', 'neq', 'gte', 'lte', 'eq', 'in', 'order', 'limit', 'ilike'] as const) {
      c[m] = () => c;
    }
    c.select = (sel?: string, _opts?: { count?: 'exact' }) => {
      void sel;
      return c;
    };
    c.range = (from: number, to: number) => {
      const ordered = [...sourceOf(table)].sort((a, b) =>
        (a.occurred_on ?? '').localeCompare(b.occurred_on ?? ''),
      );
      const page = ordered.slice(from, to + 1);
      return {
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, error: null, count: ordered.length }),
      };
    };
    c.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: sourceOf(table), error: null });
    return c;
  };
  return {
    fake: {
      from: (t: string) => base(t),
    },
  };
}

function brlReais(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const BANNED_TOKENS = [
  'Realizado até hoje',
  'Valor lançado até hoje',
  'Esperado até hoje',
  'Referência até hoje',
  'até hoje',
  'média proporcional',
  'ritmo',
  'Futuros registrados',
  'comprometido',
  'fechamento estimado do mês é de',
  'Ainda é cedo',
  '7º dia',
];

describe('PESSOAL-13C4A-E3.7 — aceitação: texto e invariância no nível do roteador', () => {
  it('"Quanto vou fechar o mês?": frase mensal exata, com a média e o aviso de alteração, sem nenhum token banido', async () => {
    const ans = await runDeterministicAsk({
      supabase: projClient(projRows()).fake as never,
      question: 'Quanto vou fechar o mês?',
      nowISO: '2026-09-21',
    });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_current_month');
    const answer = ans?.response.answer ?? '';
    expect(answer).toContain('No mês atual, o total lançado é de ' + brlCentsOf(TOTAL_REALIZED));
    expect(answer).toContain(
      'contra a média mensal de ' + brlCentsOf(TOTAL_MEAN) + ' dos 12 meses anteriores',
    );
    expect(answer).toContain(brlCentsOf(Math.abs(TOTAL_DEVIATION)) + ' abaixo da média mensal');
    expect(answer).toContain('Novos lançamentos ainda podem alterar o total do mês.');
    for (const token of BANNED_TOKENS) {
      expect(answer).not.toContain(token);
    }
  });

  it('o texto do mês atual independe do day do todayISO (05/09 e 21/09 → idêntico)', async () => {
    const a5 = await runDeterministicAsk({
      supabase: projClient(projRows()).fake as never,
      question: 'Quanto vou fechar o mês?',
      nowISO: '2026-09-05',
    });
    const a21 = await runDeterministicAsk({
      supabase: projClient(projRows()).fake as never,
      question: 'Quanto vou fechar o mês?',
      nowISO: '2026-09-21',
    });
    expect(a5).not.toBeNull();
    expect(a21).not.toBeNull();
    expect(a5?.response.answer).toBe(a21?.response.answer);
    expect(a5?.response.answer).toContain('contra a média mensal de ' + brlCentsOf(TOTAL_MEAN));
  });

  it('mês passado: texto de comparação mensal fala de média (igual à média mensal), nunca ritmo', async () => {
    const ans = await runDeterministicAsk({
      supabase: projClient(projRows()).fake as never,
      question: 'Qual a previsão para agosto de 2026 comparada à média dos 12 meses anteriores?',
      nowISO: '2026-09-21',
    });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_month_comparison');
    const answer = ans?.response.answer ?? '';
    expect(answer).toContain('média mensal');
    expect(answer).toContain('igual à referência');
    for (const token of BANNED_TOKENS) {
      expect(answer).not.toContain(token);
    }
  });
});

describe('PESSOAL-13C4A-E3.7 — aceitação: contrato (mapeador e sanitizador)', () => {
  it('item 1: mapeador emite monthly_mean no mês atual; round-trip idempotente', () => {
    const p = currentPayload();
    expect(p.reference.kind).toBe('current');
    expect(p.comparison).toEqual({
      deviation: 'below',
      deviationCents: TOTAL_DEVIATION,
      referenceBasis: 'monthly_mean',
      referenceCents: TOTAL_MEAN,
      realizedCents: TOTAL_REALIZED,
    });
    for (const c of p.categories) {
      expect(c.referenceBasis).toBe('monthly_mean');
      expect('futureRegisteredCents' in c).toBe(false);
      expect('committedCents' in c).toBe(false);
    }
    expect(sanitizeProjectionPayloadV1(clonePayload(p))).toEqual(p);
  });

  it('item 2: payload novo com campos do legado injetados → undefined (comparison e categoria)', () => {
    const raw = clonePayload(currentPayload());
    (raw.comparison as Record<string, unknown>).expectedToDateCents = 241352;
    expect(sanitizeProjectionPayloadV1(raw)).toBeUndefined();
    const raw2 = clonePayload(currentPayload());
    (raw2.categories as Array<Record<string, unknown>>)[0].committedCents = 1;
    expect(sanitizeProjectionPayloadV1(raw2)).toBeUndefined();
  });

  it('item 3: leitura LEGADA (expected_to_date com os quatro campos) é aceita no sanitizador', () => {
    // Payload no FORMADO pré-E3.7: comparison expected_to_date com os quatro
    // campos e categorias com future/committed + coerência modo ↔ base antiga.
    const legacy: Raw = {
      version: 1,
      status: 'success',
      intent: 'projection_categories',
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
      summary: {
        monthlyMeanCents: TOTAL_MEAN,
        annualScenarioCents: TOTAL_MEAN * 12,
        totalBaseCents: TOTAL_MEAN * 12,
      },
      comparison: {
        deviation: 'below',
        deviationCents: -278545,
        referenceBasis: 'expected_to_date',
        referenceCents: 341443,
        realizedCents: 62898,
        expectedToDateCents: 241352,
        futureRegisteredCents: 267500,
        committedCents: 330398,
        closingProjectionCents: 357354,
      },
      categories: [
        {
          label: 'Supermercado',
          monthlyMeanCents: 160130,
          annualScenarioCents: 1921560,
          realizedCents: 12398,
          referenceBasis: 'expected_to_date',
          mode: 'variable_pace',
          referenceCents: 112091,
          deviationCents: -99693,
          deviation: 'below',
          futureRegisteredCents: 77500,
          committedCents: 89898,
        },
        {
          label: 'Aluguel',
          monthlyMeanCents: 184659,
          annualScenarioCents: 2215908,
          realizedCents: 50500,
          referenceBasis: 'monthly_mean',
          mode: 'monthly_commitment',
          referenceCents: 184659,
          deviationCents: 8121,
          deviation: 'above',
          futureRegisteredCents: 180000,
          committedCents: 230500,
        },
      ],
    };
    const out = sanitizeProjectionPayloadV1(legacy);
    expect(out).toBeDefined();
    if (!out || out.status !== 'success') throw new Error('legado deveria ser success');
    expect(out.comparison.referenceBasis).toBe('expected_to_date');
    expect(out.comparison).toHaveProperty('expectedToDateCents', 241352);
    expect(out.comparison).toHaveProperty('futureRegisteredCents', 267500);
    expect(out.comparison).toHaveProperty('committedCents', 330398);
    expect(out.comparison).toHaveProperty('closingProjectionCents', 357354);
    const supermercado = out.categories.find((c) => c.label === 'Supermercado');
    expect(supermercado?.futureRegisteredCents).toBe(77500);
    expect(supermercado?.committedCents).toBe(89898);
  });
});