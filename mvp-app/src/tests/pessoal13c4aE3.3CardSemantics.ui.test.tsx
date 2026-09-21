// @vitest-environment jsdom

// pessoal13c4aE3.3CardSemantics.ui.test.tsx — PESSOAL-13C4A-E3.3: os CARDS de
// projeção renderizam a semântica por categoria que o servidor já calculou.
// O navegador só formata (nunca recalcula média/desvio/fechamento).
//
//   1. compromisso fixo (Aluguel, monthly_commitment): "Valor já lançado no
//      mês", média mensal completa "R$ 1.846,59" e "+R$ 81,21" — NUNCA o
//      proporcional "R$ 1.292,61", nunca "ritmo";
//   2. gasto variável (Supermercado, variable_pace): "Referência até hoje
//      (média proporcional)" "R$ 1.120,91" e "R$ 996,93" abaixo do ritmo;
//   3. aportes (Investimentos, investment_allocation): rótulos próprios de
//      aportes e cenário de 12 meses de aportes — nunca gasto/consumo;
//   4. mês passado (kind past): rótulos genéricos "Realizado no mês" /
//      "Média histórica" / "Diferença", SEM ritmo e SEM notas por modo;
//   5. notas: VARIABLE_PACE_NOTICE/MONTHLY_COMMITMENT_NOTICE por modo presente
//      (deduplicadas) só no mês atual; CLOSING_NOTICE apenas em
//      projection_current_month.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectionCards } from '../components/ProjectionCards';
import type {
  ProjectionPayloadCategoryMode,
  ProjectionPayloadCategoryV1,
  ProjectionPayloadReferenceKind,
  ProjectionPayloadSuccessV1,
} from '../../server/finance-ai/projectionPayloadV1';

const VARIABLE_PACE_NOTICE =
  'A referência até hoje compara o realizado com a parcela da média histórica correspondente aos dias já transcorridos.';
const MONTHLY_COMMITMENT_NOTICE =
  'Esta categoria costuma ser paga em uma ou poucas datas. Por isso, a comparação usa a média mensal completa, e não uma distribuição diária.';
const CLOSING_NOTICE =
  'O fechamento soma o ritmo do realizado aos lançamentos futuros já registrados e pode oscilar quando contas mensais são pagas no início do mês.';

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
  referenceBasis: 'expected_to_date' as const,
  referenceCents: 241352,
  realizedCents: 205178,
  expectedToDateCents: 241352,
  futureRegisteredCents: 0,
  committedCents: 205178,
  closingProjectionCents: 293111,
};

describe('PESSOAL-13C4A-E3.3 — cards por modo de categoria', () => {
  it('Aluguel (monthly_commitment) usa a média mensal completa e Supermercado (variable_pace) a referência proporcional', () => {
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
        cat('Supermercado', 'variable_pace', 'expected_to_date', {
          monthlyMeanCents: 160130,
          realizedCents: 12398,
          referenceCents: 112091,
          deviationCents: -99693,
          deviation: 'below',
        }),
      ],
    });
    render(<ProjectionCards projection={p} />);

    // Aluguel: rótulos de compromisso fixo + valores da média (nunca o proporcional).
    expect(screen.getByText('Valor já lançado no mês')).toBeDefined();
    expect(screen.getAllByText('Média mensal histórica').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Diferença da média mensal até agora')).toBeDefined();
    expect(screen.getByText('acima da média mensal')).toBeDefined();
    expect(screen.getByText(/1\.927,80/)).toBeDefined();
    expect(screen.getByText(/1\.846,59/)).toBeDefined();
    expect(screen.getByText(/81,21/)).toBeDefined();
    expect(screen.queryByText(/1\.292,61/)).toBeNull();

    // Supermercado: rótulos de ritmo proporcional.
    expect(screen.getAllByText('Realizado até hoje').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Referência até hoje (média proporcional)')).toBeDefined();
    expect(screen.getByText('Diferença no ritmo até hoje')).toBeDefined();
    expect(screen.getByText('abaixo do ritmo até hoje')).toBeDefined();
    expect(screen.getByText(/1\.120,91/)).toBeDefined();
    expect(screen.getByText(/123,98/)).toBeDefined();
    expect(screen.getByText(/996,93/)).toBeDefined();
    expect(screen.getByText(/1\.601,30/)).toBeDefined();

    // Ambas as notas por modo, deduplicadas; fechamento NÃO cabe em categorias.
    expect(screen.getByText(MONTHLY_COMMITMENT_NOTICE)).toBeDefined();
    expect(screen.getByText(VARIABLE_PACE_NOTICE)).toBeDefined();
    expect(screen.queryByText(CLOSING_NOTICE)).toBeNull();
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
    expect(screen.getByText('Aportes já lançados no mês')).toBeDefined();
    expect(screen.getByText('Média mensal histórica de aportes')).toBeDefined();
    expect(screen.getByText('Diferença da média de aportes')).toBeDefined();
    expect(screen.getByText('acima da média de aportes')).toBeDefined();
    expect(screen.getByText(/2\.050,00/)).toBeDefined();
    expect(
      screen.getByText('Cenário se a média de aportes se repetir por 12 meses'),
    ).toBeDefined();
    expect(screen.queryByText('Realizado até hoje')).toBeNull();
    expect(screen.queryByText(/Cenário se a média se repetir por 12 meses/)).toBeNull();
    expect(screen.queryByText(VARIABLE_PACE_NOTICE)).toBeNull();
    expect(screen.queryByText(MONTHLY_COMMITMENT_NOTICE)).toBeNull();
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
    expect(screen.queryByText('Valor já lançado no mês')).toBeNull();
    expect(screen.queryByText('Diferença da média mensal até agora')).toBeNull();
    expect(screen.queryByText(/ritmo/)).toBeNull();
    expect(screen.queryByText(/até hoje/)).toBeNull();
    expect(screen.queryByText(VARIABLE_PACE_NOTICE)).toBeNull();
    expect(screen.queryByText(MONTHLY_COMMITMENT_NOTICE)).toBeNull();
    expect(screen.queryByText(CLOSING_NOTICE)).toBeNull();
  });

  it('fechamento do mês atual (projection_current_month) exibe o CLOSING_NOTICE', () => {
    const p = success({
      intent: 'projection_current_month',
      kind: 'current',
      month: '2026-09',
      categories: [],
      comparison: CURRENT_COMPARISON,
    });
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Realizado até hoje')).toBeDefined();
    expect(screen.getByText('Esperado até hoje')).toBeDefined();
    expect(screen.getByText(CLOSING_NOTICE)).toBeDefined();
  });
});