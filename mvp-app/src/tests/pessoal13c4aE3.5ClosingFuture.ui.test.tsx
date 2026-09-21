// @vitest-environment jsdom

// pessoal13c4aE3.5ClosingFuture.ui.test.tsx — PESSOAL-13C4A-E3.5: os cards do
// mês atual exibem lançamentos futuros e "já lançado" (realizado + futuros) por
// categoria, conforme o modo:
//
//   1. variable_pace: "Realizado até hoje", "Referência até hoje (média
//      proporcional)" e, quando há futuros, "Futuros registrados" e "Total já
//      lançado no mês";
//   2. monthly_commitment / investment_allocation: "Valor já lançado no mês" /
//      "Aportes já lançados no mês" (realizado + futuros) contra a média
//      mensal completa; "Futuros registrados" quando > 0;
//   3. sem futuros (future 0): linhas de futuros NÃO renderizam;
//   4. o navegador só formata os valores que o servidor calculou — nunca soma.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectionCards } from '../components/ProjectionCards';
import type {
  ProjectionPayloadCategoryMode,
  ProjectionPayloadCategoryV1,
  ProjectionPayloadReferenceKind,
  ProjectionPayloadSuccessV1,
} from '../../server/finance-ai/projectionPayloadV1';

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
    futureRegisteredCents?: number;
    committedCents?: number;
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
    ...(o.futureRegisteredCents !== undefined || o.committedCents !== undefined
      ? {
          futureRegisteredCents: o.futureRegisteredCents ?? 0,
          committedCents: o.committedCents ?? o.realizedCents,
        }
      : {}),
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
  referenceBasis: 'expected_to_date' as const,
  referenceCents: 353443,
  realizedCents: 62898,
  expectedToDateCents: 353443,
  futureRegisteredCents: 267500,
  committedCents: 330398,
  closingProjectionCents: 357354,
};

describe('PESSOAL-13C4A-E3.5 — cards com lançamentos futuros por categoria', () => {
  it('variable_pace com futuros: realizado, referência proporcional, futuros e total já lançado', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Supermercado', 'variable_pace', 'expected_to_date', {
          monthlyMeanCents: 160130,
          realizedCents: 12398,
          referenceCents: 112091,
          deviationCents: -99693,
          deviation: 'below',
          futureRegisteredCents: 77500,
          committedCents: 89898,
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Realizado até hoje')).toBeDefined();
    expect(screen.getAllByText('R$ 123,98').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Referência até hoje (média proporcional)')).toBeDefined();
    expect(screen.getByText('Futuros registrados')).toBeDefined();
    expect(screen.getByText('Total já lançado no mês')).toBeDefined();
    expect(screen.getByText(/775,00/)).toBeDefined();
    expect(screen.getByText(/898,98/)).toBeDefined();
  });

  it('monthly_commitment com futuros: "Valor já lançado no mês" = realizado + futuros e linha de futuros', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Aluguel', 'monthly_commitment', 'monthly_mean', {
          monthlyMeanCents: 184659,
          realizedCents: 50500,
          referenceCents: 184659,
          deviationCents: 45841,
          deviation: 'above',
          futureRegisteredCents: 180000,
          committedCents: 230500,
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Valor já lançado no mês')).toBeDefined();
    expect(screen.getByText(/2\.305,00/)).toBeDefined();
    expect(screen.getByText('Futuros registrados')).toBeDefined();
    expect(screen.getByText(/1\.800,00/)).toBeDefined();
    expect(screen.getByText('Diferença da média mensal até agora')).toBeDefined();
    expect(screen.getByText(/458,41/)).toBeDefined();
    expect(screen.getByText('acima da média mensal')).toBeDefined();
    expect(screen.queryByText('Total já lançado no mês')).toBeNull();
  });

  it('investment_allocation com futuros: "Aportes já lançados no mês" e linha de futuros', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: CURRENT_COMPARISON,
      categories: [
        cat('Investimentos', 'investment_allocation', 'monthly_mean', {
          monthlyMeanCents: 200000,
          realizedCents: 100000,
          referenceCents: 200000,
          deviationCents: 0,
          deviation: 'equal',
          futureRegisteredCents: 50000,
          committedCents: 150000,
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Aportes já lançados no mês')).toBeDefined();
    expect(screen.getByText('R$ 1.500,00')).toBeDefined();
    expect(screen.getByText('Futuros registrados')).toBeDefined();
    expect(screen.getByText('R$ 500,00')).toBeDefined();
  });

  it('sem futuros (0): linhas de futuros/total NÃO renderizam', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'current',
      month: '2026-09',
      comparison: { ...CURRENT_COMPARISON, futureRegisteredCents: 0, committedCents: 205178 },
      categories: [
        cat('Supermercado', 'variable_pace', 'expected_to_date', {
          monthlyMeanCents: 160130,
          realizedCents: 12398,
          referenceCents: 112091,
          deviationCents: -99693,
          deviation: 'below',
          futureRegisteredCents: 0,
          committedCents: 12398,
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Realizado até hoje')).toBeDefined();
    expect(screen.getByText('Referência até hoje (média proporcional)')).toBeDefined();
    expect(screen.queryByText('Futuros registrados')).toBeNull();
    expect(screen.queryByText('Total já lançado no mês')).toBeNull();
  });

  it('mês passado: sem "Futuros registrados" nem "Total já lançado no mês"', () => {
    const p = success({
      intent: 'projection_categories',
      kind: 'past',
      month: '2026-08',
      categories: [
        cat('Supermercado', 'variable_pace', 'monthly_mean', {
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
    expect(screen.queryByText('Valor já lançado no mês')).toBeNull();
  });
});