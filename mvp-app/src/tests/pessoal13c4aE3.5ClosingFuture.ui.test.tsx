// @vitest-environment jsdom

// pessoal13c4aE3.5ClosingFuture.ui.test.tsx — PESSOAL-13C4A-E3.5/E3.7: os cards
// do mês atual usam a MESMA forma do mês passado — total lançado no MÊS INTEIRO,
// média mensal histórica e diferença. Nunca futuros/comprometido/ritmo.
//
//   1. variable_pace (Supermercado): "Total lançado no mês" + "Média mensal
//      histórica" + "Diferença para a média mensal"; nunca "Realizado até hoje"
//      nem "Referência até hoje (média proporcional)";
//   2. monthly_commitment (Aluguel): "Valor lançado no mês" contra a média
//      mensal completa — nunca "Valor já lançado" com futuros;
//   3. investment_allocation (Investimentos): "Aportes lançados no mês";
//   4. lançamentos futuros (futuros/comprometido) NUNCA aparecem no card — o
//      mapeador novo nem os emite; o navegador nunca soma nada;
//   5. o navegador só formata os valores que o servidor calculou — nunca soma.
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
    referenceBasis: 'monthly_mean',
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
}): ProjectionPayloadSuccessV1 {
  const mean = parts.categories.reduce((acc, c) => acc + c.monthlyMeanCents, 0);
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
    },
    comparison: parts.comparison,
    categories: parts.categories,
  };
}

const CURRENT_COMPARISON = {
  deviation: 'below' as const,
  deviationCents: -278545,
  referenceBasis: 'monthly_mean' as const,
  referenceCents: 341443,
  realizedCents: 62898,
};

describe('PESSOAL-13C4A-E3.5 — cards do mês atual pelo mês inteiro (E3.7), sem futuros', () => {
  it('variable_pace: total lançado no mês vs média mensal completa (nunca o proporcional/ritmo)', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Supermercado', 'variable_pace', {
          monthlyMeanCents: 160130,
          realizedCents: 12398,
          referenceCents: 160130,
          deviationCents: -147732,
          deviation: 'below',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Total lançado no mês')).toBeDefined();
    expect(screen.getAllByText('R$ 123,98').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Média mensal histórica')).toBeDefined();
    expect(screen.getByText(/1\.601,30/)).toBeDefined();
    expect(screen.getByText('Diferença para a média mensal')).toBeDefined();
    expect(screen.getByText(/1\.477,32/)).toBeDefined();
    expect(screen.getByText('abaixo da média mensal')).toBeDefined();
    expect(screen.queryByText('Realizado até hoje')).toBeNull();
    expect(screen.queryByText('Referência até hoje (média proporcional)')).toBeNull();
    expect(screen.queryByText(/ritmo/)).toBeNull();
    expect(screen.getByText(CURRENT_CHANGE_NOTICE)).toBeDefined();
  });

  it('monthly_commitment: "Valor lançado no mês" contra a média mensal completa (nunca futuros)', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Aluguel', 'monthly_commitment', {
          monthlyMeanCents: 184659,
          realizedCents: 50500,
          referenceCents: 184659,
          deviationCents: -134159,
          deviation: 'below',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Valor lançado no mês')).toBeDefined();
    expect(screen.getAllByText('R$ 505,00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Média mensal histórica')).toBeDefined();
    expect(screen.getByText(/1\.846,59/)).toBeDefined();
    expect(screen.getByText('Diferença para a média mensal')).toBeDefined();
    expect(screen.getByText(/1\.341,59/)).toBeDefined();
    expect(screen.getByText('abaixo da média mensal')).toBeDefined();
    expect(screen.queryByText('Futuros registrados')).toBeNull();
    expect(screen.queryByText('Total já lançado no mês')).toBeNull();
    expect(screen.queryByText('Valor já lançado no mês')).toBeNull();
  });

  it('investment_allocation: "Aportes lançados no mês" e rótulos de aportes', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Investimentos', 'investment_allocation', {
          monthlyMeanCents: 200000,
          realizedCents: 100000,
          referenceCents: 200000,
          deviationCents: -100000,
          deviation: 'below',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Aportes lançados no mês')).toBeDefined();
    expect(screen.getAllByText('R$ 1.000,00').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Média mensal histórica de aportes')).toBeDefined();
    expect(screen.getByText('Diferença para a média de aportes')).toBeDefined();
    expect(screen.queryByText('Futuros registrados')).toBeNull();
    expect(screen.queryByText('Comprometido')).toBeNull();
  });

  it('futuros/comprometido jamais aparecem no card do mês atual (E3.7)', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Supermercado', 'variable_pace', {
          monthlyMeanCents: 160130,
          realizedCents: 12398,
          referenceCents: 160130,
          deviationCents: -147732,
          deviation: 'below',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.queryByText('Futuros registrados')).toBeNull();
    expect(screen.queryByText('Total já lançado no mês')).toBeNull();
    expect(screen.queryByText('Comprometido')).toBeNull();
    expect(screen.queryByText('Fechamento estimado')).toBeNull();
    expect(screen.queryByText('Esperado até hoje')).toBeNull();
  });

  it('mês passado: sem futuros e sem rótulos do mês atual', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'past',
      month: '2026-08',
      categories: [
        cat('Supermercado', 'variable_pace', {
          monthlyMeanCents: 160130,
          realizedCents: 150000,
          referenceCents: 160130,
          deviationCents: -10130,
          deviation: 'below',
        }),
      ],
      comparison: {
        deviation: 'below',
        deviationCents: -10130,
        referenceBasis: 'monthly_mean',
        referenceCents: 160130,
        realizedCents: 150000,
      },
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Realizado no mês')).toBeDefined();
    expect(screen.queryByText('Futuros registrados')).toBeNull();
    expect(screen.queryByText('Total já lançado no mês')).toBeNull();
    expect(screen.queryByText('Valor lançado no mês')).toBeNull();
    expect(screen.queryByText(CURRENT_CHANGE_NOTICE)).toBeNull();
  });
});