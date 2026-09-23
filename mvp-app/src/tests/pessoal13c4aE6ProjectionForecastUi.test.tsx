// @vitest-environment jsdom

// pessoal13c4aE6ProjectionForecastUi.test.tsx — PESSOAL-13C4A-E6: cards dos
// próximos 12 meses no navegador.
//
// Prova que (renderização EXCLUSIVAMENTE a partir do ProjectionPayloadV1 — o
// cliente só formata, nunca recalcula):
//   1. projection_base COM forecast renderiza o card "Horizonte projetado"
//      (resumo: cenário projetado / já lançado / estimativa ainda não lançada /
//      referência histórica) + EXATAMENTE 12 cards de mês, um por mês do
//      horizonte, com 4 linhas cada e sem rolagem horizontal;
//   2. projection_base SEM forecast continua renderizando o SummaryCard
//      legado (retrocompatibilidade do E2);
//   3. badges e nota explicativa (como a projeção evita contar o mesmo gasto
//      duas vezes) estão presentes;
//   4. o grid responsivo usa 1 coluna no mobile e 2/3 colunas nos breakpoints;
//   5. os valores exibidos batem byte-a-byte com o payload (pt-BR).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ProjectionCards } from '../components/ProjectionCards';
import type { ProjectionPayloadSuccessV1 } from '../../server/finance-ai/projectionPayloadV1';

const here = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const css = readSource('index.css');

function ruleBlock(cssSource: string, selector: string): string | null {
  let idx = -1;
  for (;;) {
    idx = cssSource.indexOf(selector, idx + 1);
    if (idx === -1) return null;
    const before = idx === 0 ? ' ' : cssSource[idx - 1];
    if (!/[\s;})]/.test(before)) continue;
    const rest = cssSource.slice(idx + selector.length);
    if (!rest.trimStart().startsWith('{')) continue;
    const open = idx + selector.length + (rest.length - rest.trimStart().length);
    let depth = 0;
    for (let i = open; i < cssSource.length; i++) {
      if (cssSource[i] === '{') depth += 1;
      else if (cssSource[i] === '}') {
        depth -= 1;
        if (depth === 0) return cssSource.slice(open + 1, i);
      }
    }
    return null;
  }
}

/** Junta o conteúdo de TODOS os block `@media (min-width: <query>)`. */
function mediaBlock(cssSource: string, query: string): string {
  const needle = `@media (min-width: ${query})`;
  const out: string[] = [];
  let idx = cssSource.indexOf(needle);
  while (idx >= 0) {
    const rest = cssSource.slice(idx + needle.length);
    if (rest.trimStart().startsWith('{')) {
      const open = idx + needle.length + (rest.length - rest.trimStart().length);
      let depth = 0;
      for (let i = open; i < cssSource.length; i++) {
        if (cssSource[i] === '{') depth += 1;
        else if (cssSource[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            out.push(cssSource.slice(open + 1, i));
            break;
          }
        }
      }
    }
    idx = cssSource.indexOf(needle, idx + needle.length);
  }
  return out.join('\n');
}

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
  cleanup();
});

const brl = (cents: number) =>
  (cents / 100)
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    .replace(/\s+/g, ' ');

const MONTHS_RANGE: Array<{ key: string; title: string }> = [
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
  '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09',
].map((key) => ({ key, title: `${monthTitle(key)}` }));

function monthTitle(key: string): string {
  const names = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];
  const m = Number(key.slice(5, 7));
  return `${names[m - 1]} de ${key.slice(0, 4)}`;
}

function forecastSuccess(): ProjectionPayloadSuccessV1 {
  const month = (key: string, projectedCents: number) => ({
    month: key,
    registeredCents: Math.floor(projectedCents / 2),
    estimatedRemainingCents: projectedCents - Math.floor(projectedCents / 2),
    projectedCents,
    historicalReferenceCents: 200000,
  });
  const months = MONTHS_RANGE.map(({ key }) => month(key, 200000));
  return {
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
    summary: { monthlyMeanCents: 200000, annualScenarioCents: 2400000, totalBaseCents: 2400000 },
    comparison: {
      deviation: 'equal',
      deviationCents: 0,
      referenceBasis: 'monthly_mean',
      referenceCents: 200000,
      realizedCents: 200000,
    },
    categories: [],
    forecast: {
      horizonStart: '2026-10',
      horizonEnd: '2027-09',
      summary: {
        historicalReferenceCents: 2400000,
        registeredCents: 1200000,
        estimatedRemainingCents: 1200000,
        projectedCents: 2400000,
      },
      months,
    },
  };
}

describe('PESSOAL-13C4A-E6 — cards dos próximos 12 meses', () => {
  function rowValue(article: HTMLElement, label: string): string | null {
    const dt = within(article).getByText(label);
    const row = dt.closest('.finance-ai-card-row');
    return row?.querySelector('dd')?.textContent?.trim().replace(/\s+/g, ' ') ?? null;
  }

  it('base com forecast: card resumo "Horizonte projetado" com os quatro totais byte-exatos', () => {
    const p = forecastSuccess();
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Horizonte projetado')).toBeTruthy();
    const card = screen.getByText('Horizonte projetado').closest('article');
    expect(card).not.toBeNull();
    const article = card as HTMLElement;
    expect(rowValue(article, 'Cenário projetado')).toBe(brl(2400000));
    expect(rowValue(article, 'Já lançado')).toBe(brl(1200000));
    expect(rowValue(article, 'Estimativa ainda não lançada')).toBe(brl(1200000));
    expect(rowValue(article, 'Referência histórica anualizada')).toBe(brl(2400000));
    cleanup();
  });

  it('base com forecast: EXATAMENTE 12 cards de mês, um por mês do horizonte, cada um com 4 linhas', () => {
    const p = forecastSuccess();
    render(<ProjectionCards projection={p} />);
    for (const { title } of MONTHS_RANGE) {
      const heading = screen.getByText(title);
      expect(heading).toBeTruthy();
      const article = heading.closest('article');
      expect(article).not.toBeNull();
      const dl = article?.querySelector('dl');
      expect(dl).not.toBeNull();
      expect(dl?.querySelectorAll('dt').length).toBe(4);
      expect(dl?.querySelectorAll('dd').length).toBe(4);
    }
    cleanup();
  });

  it('nota explicativa presente (evita contar o mesmo gasto duas vezes) e badge de base completa', () => {
    render(<ProjectionCards projection={forecastSuccess()} />);
    expect(
      screen.getByText(/maior valor entre o que já está lançado e a média histórica/i),
    ).toBeTruthy();
    expect(screen.getByText(/Base completa · 12\/12 meses/)).toBeTruthy();
    cleanup();
  });

  it('base SEM forecast → SummaryCard legado do E2 (retrocompatibilidade)', () => {
    const p = forecastSuccess();
    delete (p as unknown as Record<string, unknown>).forecast;
    render(<ProjectionCards projection={p} />);
    expect(screen.getByText('Visão geral')).toBeTruthy();
    expect(screen.getByText('Média mensal histórica')).toBeTruthy();
    expect(screen.getByText(brl(200000))).toBeTruthy();
    expect(screen.queryByText('Horizonte projetado')).toBeNull();
    cleanup();
  });

  it('grid responsivo: 1 coluna no mobile e 2 e 3 colunas nos breakpoints', () => {
    const grid = ruleBlock(css, '.finance-ai-proj-forecast-grid');
    expect(grid).not.toBeNull();
    expect(grid).toContain('grid-template-columns: 1fr');
    const media600 = mediaBlock(css, '600px');
    const media960 = mediaBlock(css, '960px');
    expect(media600).not.toBeNull();
    expect(media960).not.toBeNull();
    expect(media600).toContain('.finance-ai-proj-forecast-grid');
    expect(media600).toContain('1fr 1fr');
    expect(media960).toContain('.finance-ai-proj-forecast-grid');
    expect(media960).toContain('1fr 1fr 1fr');
  });
});