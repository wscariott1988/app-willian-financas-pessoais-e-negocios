// @vitest-environment jsdom

// pessoal13c4aE3.3CardSemantics.ui.test.tsx — PESSOAL-13C4A-E3.3: os CARDS de
// projeção renderizam a semântica por categoria que o servidor já calculou.
// O navegador só formata (nunca recalcula média/desvio/fechamento).
//
// PESSOAL-13C4A-E3.7: a base de comparação é SEMPRE a média mensal completa
// (monthly_mean), no mês atual e no passado. O MODO da categoria (derivado do
// rótulo) muda SOMENTE a linguagem, nunca a base — nunca há "ritmo".
//
//   1. compromisso fixo (Aluguel, monthly_commitment): "Valor lançado no mês",
//      "Média mensal histórica" R$ 1.846,59 e "acima da média mensal" +R$ 81,21
//      — nunca o proporcional R$ 1.292,61, nunca "ritmo";
//   2. gasto variável (Supermercado, variable_pace): MESMA base — "Total lançado
//      no mês", "Média mensal histórica" R$ 1.601,30 e "abaixo da média mensal"
//      R$ 1.477,32 — nunca a referência proporcional R$ 1.120,91;
//   3. aportes (Investimentos, investment_allocation): rótulos próprios de
//      aportes e cenário de 12 meses de aportes — nunca gasto/consumo;
//   4. mês passado (kind past): rótulos genéricos "Realizado no mês" /
//      "Média histórica" / "Diferença", SEM ritmo e SEM notas por modo;
//   5. notas: apenas CURRENT_CHANGE_NOTICE no mês atual (deduplicada) para
//      categorias e para projection_current_month — nunca notas por modo.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectionCards } from '../components/ProjectionCards';
import type {
  ProjectionPayloadCategoryMode,
  ProjectionPayloadCategoryV1,
  ProjectionPayloadReferenceKind,
  ProjectionPayloadSuccessV1,
} from '../../server/finance-ai/projectionPayloadV1';

const CURRENT_CHANGE_NOTICE = 'Novos lançamentos ainda podem alterar o total do mês.';

let originalActEnv: unknown;

beforeAll(() => {
  originalActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (originalActEnv === undefined) {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  } else {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  }
});

afterEach(() => {
  cleanup();
});

function cat(
  label: string,
  mode: ProjectionPayloadCategoryMode,
  referenceBasis: 'expected_to_date' | 'monthly_mean',
  o: {
    monthlyMeanCents: number;
    realizedCents: number;
    referenceCents: number;
    deviationCents: number;
    deviation: 'above' | 'below' | 'equal';
  },
): ProjectionPayloadCategoryV1 {
  return {
    label,
    mode,
    referenceBasis,
    monthlyMeanCents: o.monthlyMeanCents,
    annualScenarioCents: o.monthlyMeanCents * 12,
    realizedCents: o.realizedCents,
    referenceCents: o.referenceCents,
    deviationCents: o.deviationCents,
    deviation: o.deviation,
  };
}

function success(parts: {
  intent: ProjectionPayloadSuccessV1['intent'];
  kind: ProjectionPayloadReferenceKind;
  month: string;
  categories: ProjectionPayloadCategoryV1[];
  comparison: ProjectionPayloadSuccessV1['comparison'];
  summary?: ProjectionPayloadSuccessV1['summary'];
  lens?: { label: string };
}): ProjectionPayloadSuccessV1 {
  const mean =
    parts.summary?.monthlyMeanCents ??
    parts.categories.reduce((acc, c) => acc + c.monthlyMeanCents, 0);
  return {
    version: 1,
    status: 'success',
    intent: parts.intent,
    quality: 'full',
    reference: { month: parts.month, kind: parts.kind },
    coverage: {
      windowMonths: 12,
      coveredMonths: 12,
      minimumCoverageMonths: 6,
      requiredFullCoverageMonths: 12,
      windowStart: '2025-09',
      windowEnd: '2026-08',
    },
    summary: {
      monthlyMeanCents: mean,
      annualScenarioCents: mean * 12,
      totalBaseCents: mean * 12,
      ...parts.summary,
    },
    comparison: parts.comparison,
    categories: parts.categories,
    ...(parts.lens ? { lens: parts.lens } : {}),
  };
}

const CURRENT_COMPARISON = {
  deviation: 'below' as const,
  deviationCents: -36174,
  referenceBasis: 'monthly_mean' as const,
  referenceCents: 241352,
  realizedCents: 205178,
};

describe('PESSOAL-13C4A-E3.3 — cards por modo de categoria (base sempre monthly_mean — E3.7)', () => {
  it('Aluguel (monthly_commitment) e Supermercado (variable_pace) usam a MESMA média mensal completa', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Aluguel', 'monthly_commitment', 'monthly_mean', {
          monthlyMeanCents: 184659,
          realizedCents: 192780,
          referenceCents: 184659,
          deviationCents: 8121,
          deviation: 'above',
        }),
        cat('Supermercado', 'variable_pace', 'monthly_mean', {
          monthlyMeanCents: 160130,
          realizedCents: 12398,
          referenceCents: 160130,
          deviationCents: -147732,
          deviation: 'below',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);

    // Aluguel: rótulos de compromisso fixo + valores da média (nunca o proporcional).
    expect(screen.getByText('Valor lançado no mês')).toBeDefined();
    expect(screen.getAllByText('Média mensal histórica').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Diferença para a média mensal').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('acima da média mensal')).toBeDefined();
    expect(screen.getByText(/1\.927,80/)).toBeDefined();
    expect(screen.getByText(/1\.846,59/)).toBeDefined();
    expect(screen.getByText(/81,21/)).toBeDefined();
    expect(screen.queryByText(/1\.292,61/)).toBeNull();

    // Supermercado: MESMA base — nenhum rótulo proporcional/ritmo.
    expect(screen.getByText('Total lançado no mês')).toBeDefined();
    expect(screen.getByText(/1\.601,30/)).toBeDefined();
    expect(screen.getByText(/123,98/)).toBeDefined();
    expect(screen.getByText(/1\.477,32/)).toBeDefined();
    expect(screen.getByText('abaixo da média mensal')).toBeDefined();
    expect(screen.queryByText('Referência até hoje (média proporcional)')).toBeNull();
    expect(screen.queryByText('Realizado até hoje')).toBeNull();
    expect(screen.queryByText(/ritmo/)).toBeNull();
    expect(screen.queryByText(/até hoje/)).toBeNull();

    // Apenas o aviso unificado do mês atual (deduplicado); sem notas por modo,
    // sem fechamento em categorias.
    expect(screen.getAllByText(CURRENT_CHANGE_NOTICE).length).toBe(1);
    expect(screen.queryByText(/distribuição diária/)).toBeNull();
    expect(screen.queryByText(/dias já transcorridos/)).toBeNull();
    expect(screen.queryByText(/conta do fechamento/)).toBeNull();
  });

  it('Investimentos (investment_allocation) usa rótulos de aportes e o cenário de 12 meses de aportes', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Investimentos', 'investment_allocation', 'monthly_mean', {
          monthlyMeanCents: 200000,
          realizedCents: 205000,
          referenceCents: 200000,
          deviationCents: 5000,
          deviation: 'above',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Aportes lançados no mês')).toBeDefined();
    expect(screen.getByText('Média mensal histórica de aportes')).toBeDefined();
    expect(screen.getByText('Diferença para a média de aportes')).toBeDefined();
    expect(screen.getByText('acima da média de aportes')).toBeDefined();
    expect(screen.getByText(/2\.050,00/)).toBeDefined();
    expect(
      screen.getByText('Cenário se a média de aportes se repetir por 12 meses'),
    ).toBeDefined();
    expect(screen.queryByText('Total lançado no mês')).toBeNull();
    expect(screen.queryByText(/Cenário se a média se repetir por 12 meses/)).toBeNull();
    expect(screen.queryByText(/ritmo/)).toBeNull();
  });

  it('mês passado: rótulos genéricos (Realizado no mês / Média histórica / Diferença), sem ritmo e sem notas', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'past',
      month: '2026-08',
      categories: [
        cat('Aluguel', 'monthly_commitment', 'monthly_mean', {
          monthlyMeanCents: 184659,
          realizedCents: 150000,
          referenceCents: 184659,
          deviationCents: -34659,
          deviation: 'below',
        }),
      ],
      comparison: {
        deviation: 'below',
        deviationCents: -34659,
        referenceBasis: 'monthly_mean',
        referenceCents: 184659,
        realizedCents: 150000,
      },
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Realizado no mês')).toBeDefined();
    expect(screen.getAllByText('Média histórica').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Diferença')).toBeDefined();
    expect(screen.getByText('abaixo da referência')).toBeDefined();
    expect(screen.queryByText('Valor lançado no mês')).toBeNull();
    expect(screen.queryByText('Diferença para a média mensal')).toBeNull();
    expect(screen.queryByText(/ritmo/)).toBeNull();
    expect(screen.queryByText(/até hoje/)).toBeNull();
    expect(screen.queryByText(CURRENT_CHANGE_NOTICE)).toBeNull();
  });

  it('fechamento do mês atual (projection_current_month) exibe a forma unificada e o aviso de alteração', () => {
    const p = success({
      intent: 'projection_current_month',
      kind: 'current',
      month: '2026-09',
      categories: [],
      comparison: CURRENT_COMPARISON,
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Realizado no mês')).toBeDefined();
    expect(screen.getByText('Média mensal histórica')).toBeDefined();
    expect(screen.getByText('Diferença')).toBeDefined();
    expect(screen.getByText('abaixo da média mensal')).toBeDefined();
    expect(screen.getByText(CURRENT_CHANGE_NOTICE)).toBeDefined();
    expect(screen.queryByText('Realizado até hoje')).toBeNull();
    expect(screen.queryByText('Esperado até hoje')).toBeNull();
    expect(screen.queryByText('Fechamento estimado')).toBeNull();
  });
});