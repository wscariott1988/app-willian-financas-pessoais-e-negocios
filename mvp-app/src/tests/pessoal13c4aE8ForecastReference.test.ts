// pessoal13c4aE8ForecastReference.test.ts — PESSOAL-13C4A-E8: referência
// histórica da projeção CANÔNICA (fim do desvio de R$ 0,12).
//
// Histórico do defeito: a referência histórica mensal do forecast era a soma
// das médias REDONDADAS por categoria (round por bucket), o que, combinado com
// o round global de monthlyMeanCents, desviava +1 centavo por mês — R$ 0,12 no
// total anual. A correção (E8) usa a MESMA referência canônica da projeção
// geral (round(totalBaseCents/coveredMonths)) em cada um dos 12 meses.
//
// Este fixture REPRODUZ o desvio real: Cat A 'Aluguel' 13.870.806 centavos em
// 12 meses (11 × 1.155.900 + 1 × 1.155.906 → média/bucket 1.155.901 por causa
// do meio), Cat B 'Mercado' 246 centavos (→ média/bucket 21). A soma por
// categoria daria 1.155.922/mês (13.871.064/ano — o velho R$ 0,12 acima da
// verdade); a referência canônica é 13.871.052/12 = 1.155.921 exatos.
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

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

import { addMonths, type PeriodSelection } from '../../src/lib/period';
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

const TODAY = '2026-09-22';
const PAD2 = (v: number) => String(v).padStart(2, '0');

const PERIOD_COVERING: ProjectionPeriod[] = [{ accountId: 'acc-a', startsOn: '2025-08-01', endsOn: null }];

function tx(
  occurredOn: string,
  amountCents: number,
  category: 'aluguel' | 'mercado',
): ProjectionTransaction {
  return {
    accountId: 'acc-a',
    occurredOn,
    amountCents,
    transactionKind: 'expense',
    categoryId: `c-${category}`,
    categoryLabel: category === 'aluguel' ? 'Aluguel' : 'Mercado',
    deletedAt: null,
    status: 'paid',
  };
}

/**
 * Base completa set/2025..ago/2026 (12 meses):
 *   Aluguel: 11×1.155.900 + 1×1.155.906 = 13.870.806 (média/bucket 1.155.901)
 *   Mercado: 11×20 + 1×26 = 246                     (média/bucket 21)
 *   TOTAL = 13.871.052 → mean canônico = 13.871.052/12 = 1.155.921 exato.
 * A antiga soma por categoria produziria 1.155.922/mês (desvio real +R$ 0,12).
 */
function driftInput() {
  const transactions: ProjectionTransaction[] = [];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 9 }, i);
    const iso = `${ym.year}-${PAD2(ym.month)}-15`;
    const aluguel = i === 11 ? 1155906 : 1155900;
    const mercado = i === 11 ? 26 : 20;
    transactions.push(tx(iso, aluguel, 'aluguel'));
    transactions.push(tx(iso, mercado, 'mercado'));
  }
  return { todayISO: TODAY, transactions, periods: PERIOD_COVERING };
}

function forecastOf(r: ReturnType<typeof buildProjection>): Extract<typeof r, { status: 'success' }>['forecast'] {
  if (r.status !== 'success') throw new Error(`esperava success, veio ${r.status}`);
  return r.forecast;
}

describe('PESSOAL-13C4A-E8 — referência histórica canônica (fim do R$ 0,12)', () => {
  it('cada um dos 12 meses usa a MESMA referência canônica do resumo geral', () => {
    const projection = buildProjection(driftInput());
    expect(projection.status).toBe('success');
    if (projection.status !== 'success') return;

    const { summary, forecast } = projection;
    expect(summary.monthlyMeanCents).toBe(1_155_921);
    expect(summary.annualScenarioCents).toBe(13_871_052);

    for (const m of forecast.months) {
      expect(m.historicalReferenceCents).toBe(1_155_921);
    }
    const sumOfMonths = forecast.months.reduce((acc, m) => acc + m.historicalReferenceCents, 0);
    expect(sumOfMonths).toBe(13_871_052);
    expect(forecast.summary.historicalReferenceCents).toBe(13_871_052);
    expect(forecast.summary.historicalReferenceCents).toBe(summary.annualScenarioCents);
  });

  it('a estimativa híbrida por categoria permanece INTACTA (projeção projetada não muda)', () => {
    const projection = buildProjection(driftInput());
    if (projection.status !== 'success') throw new Error('esperava success');
    const forecast = projection.forecast;

    // Estimativa do mês LIMPO = 1.155.901 (Aluguel) + 21 (Mercado) = 1.155.922
    // (nada foi registrado no horizonte → estima a referência per-categoria).
    const first = forecast.months[0];
    expect(first.estimatedRemainingCents).toBe(1_155_922);
    expect(first.projectedCents).toBe(1_155_922);
    // …enquanto a referência é canônica (1.155.921): os DOIS números coexistindo
    // documenta que só a REFERÊNCIA mudou, não o cenário projetado.
    expect(first.historicalReferenceCents).toBe(1_155_921);

    expect(forecast.summary.estimatedRemainingCents).toBe(1_155_922 * 12);
    expect(forecast.summary.projectedCents).toBe(1_155_922 * 12);
    expect(forecast.summary.historicalReferenceCents).toBe(1_155_921 * 12);
  });

  it('invariantes byte-exatas: projected = registered + estimated e summary = soma dos meses', () => {
    const projection = buildProjection(driftInput());
    if (projection.status !== 'success') throw new Error('esperava success');
    const forecast = projection.forecast;

    let reg = 0;
    let est = 0;
    let proj = 0;
    let ref = 0;
    for (const m of forecast.months) {
      expect(m.projectedCents).toBe(m.registeredCents + m.estimatedRemainingCents);
      reg += m.registeredCents;
      est += m.estimatedRemainingCents;
      proj += m.projectedCents;
      ref += m.historicalReferenceCents;
    }
    expect(forecast.summary.registeredCents).toBe(reg);
    expect(forecast.summary.estimatedRemainingCents).toBe(est);
    expect(forecast.summary.projectedCents).toBe(proj);
    expect(forecast.summary.historicalReferenceCents).toBe(ref);
  });

  it('payload + sanitizer: referência canônica preservada no round-trip; inválida → rejeitada', () => {
    const projection = buildProjection(driftInput());
    if (projection.status !== 'success') throw new Error('esperava success');
    const p = mapProjectionToPayloadV1(projection, 'projection_base') as ProjectionPayloadSuccessV1;

    expect(p.forecast).toBeDefined();
    expect(p.forecast?.summary.historicalReferenceCents).toBe(13_871_052);
    expect(p.forecast?.months).toHaveLength(12);
    expect(p.forecast?.months.every((m) => m.historicalReferenceCents === 1_155_921)).toBe(true);

    const once = sanitizeProjectionPayloadV1(JSON.parse(JSON.stringify(p)));
    expect(once).toStrictEqual(p);
    expect(sanitizeProjectionPayloadV1(once as ProjectionPayloadSuccessV1)).toStrictEqual(
      once as ProjectionPayloadSuccessV1,
    );
  });

  it('sanitizador rejeita referência histórica fora do invariante (resumo ≠ soma dos meses)', () => {
    const projection = buildProjection(driftInput());
    if (projection.status !== 'success') throw new Error('esperava success');
    const p = mapProjectionToPayloadV1(projection, 'projection_base') as ProjectionPayloadSuccessV1;
    const rawA = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    const rawB = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;

    (rawA.forecast as Record<string, unknown>).summary = {
      ...((rawA.forecast as Record<string, unknown>).summary as Record<string, unknown>),
      historicalReferenceCents: 13_871_053,
    };
    expect(sanitizeProjectionPayloadV1(rawA)).toBeUndefined();

    (((rawB.forecast as Record<string, unknown>).months as Record<string, unknown>[])[0]
      .historicalReferenceCents as number) += 1;
    expect(sanitizeProjectionPayloadV1(rawB)).toBeUndefined();
  });
});