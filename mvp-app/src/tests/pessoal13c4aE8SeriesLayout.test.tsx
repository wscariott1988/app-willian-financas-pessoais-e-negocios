// @vitest-environment jsdom

// pessoal13c4aE8SeriesLayout.test.tsx — PESSOAL-13C4A-E8: layout da seção
// "Parcelamentos e recorrências" (extraída para SeriesFinancials).
//
// Prova que:
//   1. os 3 cards-resumo (parcelamentos / recorrências / futuro comprometido)
//      estão na ordem de leitura desejada, com "futuro comprometido" por
//      último e marcado para ocupar a linha inteira no mobile (grid-column 1/-1)
//      — data/valor/moeda NUNCA quebram (nowrap + tabular-nums);
//   2. "Próximos compromissos": descrição/badge, data e valor são elementos
//      SEPARADOS na ordem correeta de leitura (label → meta → amount) em todas
//      as larguras (mobile usa grid-areas, não altera a ordem do DOM);
//   3. descrições longas quebram dentro do próprio label, sem invadir a coluna
//      de data/valor;
//   4. "Parcelas próximas de terminar": quantidade e valor em células distintas
//      (nada de "2 parcelasR$ 99,68");
//   5. o CSS do bloco não usa posicionamento absoluto/fixo para alinhar
//      conteúdo financeiro e o grid usa minmax(0,1fr) (sem rolagem horizontal).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, within } from '@testing-library/react';
import { SeriesFinancials } from '../components/SeriesFinancials';
import type { AnalyticsInsights } from '../lib/analyticsInsights';

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

/** Conteúdo do bloco `@media (max-width: <query>)` (reutiliza contador de chaves). */
function maxMediaBlock(cssSource: string, query: string): string {
  const needle = `@media (max-width: ${query})`;
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

function asInsights(value: object): AnalyticsInsights {
  return value as AnalyticsInsights;
}

/** Mesma formatação do componente (pt-BR, com espaço sem quebra do Intl). */
function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const LONG_DESC = 'Assinatura do plano de saúde e seguro familiar empresarial com odontologia inclusa';

function fixture() {
  return asInsights({
    summary: {},
    expensesByCategory: [],
    monthlyEvolution: [],
    paidVsForecast: {},
    topExpenses: [],
    installment: {
      count: 3,
      committed: 4149.83,
      items: [],
      finishingSoon: [
        { seriesId: 's-air-fryer', displayName: 'Air Fryer', remaining: 2, nextDate: '2026-10-05', amount: 99.68 },
        { seriesId: 's-celular', displayName: 'Celular', remaining: 1, nextDate: '2026-10-15', amount: 55 },
      ],
    },
    recurring: {
      count: 1,
      items: [],
    },
    upcoming: [
      { key: '2026-10-05-c1-0', occurredOn: '2026-10-05', amount: 35, displayName: 'Notebook', kindLabel: 'Parcela' },
      { key: '2026-10-10-c2-0', occurredOn: '2026-10-10', amount: 99.68, displayName: 'Academia', kindLabel: 'Recorrente' },
      { key: '2026-10-13-c3-1', occurredOn: '2026-10-13', amount: 550, displayName: LONG_DESC, kindLabel: 'Parcela' },
    ],
  });
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
});

function renderSeries() {
  const view = render(<SeriesFinancials insights={fixture()} seriesEmpty={false} />);
  return view.container;
}

describe('PESSOAL-13C4A-E8 — SeriesFinancials: cards-resumo e ordem de leitura', () => {
  it('renderiza os 3 cards com "futuro comprometido" por ÚLTIMO e marcado para linha inteira no mobile', () => {
    const container = renderSeries();
    const metrics = container.querySelectorAll('.series-metric');
    expect(metrics).toHaveLength(3);
    const labels = [...metrics].map((m) => m.querySelector('.series-metric-label')?.textContent);
    expect(labels).toEqual(['parcelamentos ativos', 'recorrências ativas', 'futuro comprometido']);
    const committed = metrics[2];
    expect(committed.classList.contains('series-metric--committed')).toBe(true);
  });

  it('a moeda do card-resumo é um texto único dentro do PRÓPRIO span (nunca se funde ao label)', () => {
    const container = renderSeries();
    const value = container.querySelector('.series-metric--committed .series-metric-value');
    expect(value?.textContent).toBe(brl(4149.83));
    const label = container.querySelector('.series-metric--committed .series-metric-label');
    expect(label?.textContent).toBe('futuro comprometido');
  });

  it('CSS: valores nowrap + tabular-nums; committed ocupa a linha inteira em ≤480px e grid 2 colunas', () => {
    const valueRule = ruleBlock(css, '.series-metric-value');
    expect(valueRule).toContain('white-space: nowrap');
    expect(valueRule).toContain('font-variant-numeric: tabular-nums');
    const small = maxMediaBlock(css, '480px');
    expect(small).toContain('.series-metrics');
    expect(small).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(small).toContain('.series-metric--committed');
    expect(small).toMatch(/\.series-metric--committed\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*\}/);
  });
});

describe('PESSOAL-13C4A-E8 — SeriesFinancials: linhas com células separadas', () => {
  it('"Próximos compromissos": cada linha tem label / data / valor como elementos DISTINTOS na ordem de leitura', () => {
    const container = renderSeries();
    const subs = [...container.querySelectorAll('.series-sub')];
    const subtitles = subs.map((s) => s.querySelector('.analytics-section-subtitle')?.textContent);
    const upcoming = subs[subtitles.indexOf('Próximos compromissos')];
    const rows = upcoming.querySelectorAll('.series-row');
    expect(rows).toHaveLength(3);
    const row1 = rows[0];
    const [labelEl, metaEl, amountEl] = row1.children;
    expect(labelEl.classList.contains('series-row-label')).toBe(true);
    expect(metaEl.classList.contains('series-row-meta')).toBe(true);
    expect(amountEl.classList.contains('series-row-amount')).toBe(true);

    expect(within(labelEl as HTMLElement).getByText('Parcela')).toBeTruthy();
    expect(metaEl.textContent).toBe('05/10/2026');
    expect(amountEl.textContent).toBe(brl(35));

    // Data e moeda nunca compartilham célula nem se colam no mesmo nó de texto.
    expect(metaEl.textContent).not.toContain('R$');
    expect(amountEl.textContent).not.toContain('2026');
    expect(row1.textContent).toContain('Notebook');
    expect(row1.textContent).toContain('05/10/2026');
    expect(row1.textContent).toContain(brl(35));

    const row2 = rows[1];
    expect(row2.querySelector('.series-row-meta')?.textContent).toBe('10/10/2026');
    expect(row2.querySelector('.series-row-amount')?.textContent).toBe(brl(99.68));
    const badge = row2.querySelector('.badge-pill');
    expect(badge?.textContent).toBe('Recorrente');
    expect(within(row2.querySelector('.series-row-label') as HTMLElement).getByText('Academia')).toBeTruthy();
  });

  it('descrição LONGA quebra dentro do próprio label sem tocar nas células de data/valor', () => {
    const container = renderSeries();
    const row = [...container.querySelectorAll('.series-row')].find((r) =>
      r.textContent?.includes(LONG_DESC),
    );
    expect(row).toBeDefined();
    const label = row!.querySelector('.series-row-label');
    expect(label?.textContent).toContain(LONG_DESC);
    // A descrição fica ÍNTEGRA no label; data e valor continuam intactos.
    expect(row!.querySelector('.series-row-meta')?.textContent).toBe('13/10/2026');
    expect(row!.querySelector('.series-row-amount')?.textContent).toBe(brl(550));
    expect(label?.querySelector('.series-row-amount')).toBeNull();
  });

  it('"Parcelas próximas de terminar": quantidade e valor em células separadas ("2 parcelas restantes" ≠ "R$ 99,68")', () => {
    const container = renderSeries();
    const subtitles = [...container.querySelectorAll('.analytics-section-subtitle')];
    const finishingIndex = subtitles.findIndex((s) => s.textContent === 'Parcelas próximas de terminar');
    const subs = container.querySelectorAll('.series-sub');
    const finishing = subs[finishingIndex];
    const rows = finishing.querySelectorAll('.series-row');
    expect(rows).toHaveLength(2);

    const [labelEl, metaEl, amountEl] = rows[0].children;
    expect(labelEl.textContent).toBe('Air Fryer');
    expect(metaEl.textContent).toBe('2 parcelas restantes');
    expect(amountEl.textContent).toBe(brl(99.68));
    expect(metaEl.textContent).not.toContain('R$');

    const [labelEl2, metaEl2, amountEl2] = rows[1].children;
    expect(labelEl2.textContent).toBe('Celular');
    expect(metaEl2.textContent).toBe('1 parcela restante');
    expect(amountEl2.textContent).toBe(brl(55));
  });

  it('ordem de leitura (DOM) preservada: label → meta → amount em TODA linha', () => {
    const container = renderSeries();
    for (const row of container.querySelectorAll('.series-row')) {
      expect(row.children[0].classList.contains('series-row-label')).toBe(true);
      expect(row.children[1].classList.contains('series-row-meta')).toBe(true);
      expect(row.children[2].classList.contains('series-row-amount')).toBe(true);
    }
    // E a seção anuncia o nome para leitores de tela.
    expect(container.querySelector('section[aria-label="Parcelamentos e recorrências"]')).toBeTruthy();
  });
});

describe('PESSOAL-13C4A-E8 — SeriesFinancials: grid responsivo e proibições de layout', () => {
  it('desktop: 3 colunas minmax(0,1fr) para descrição + data + valor, com min-width:0 (sem overflow)', () => {
    const rowRule = ruleBlock(css, '.series-row');
    expect(rowRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/);
    expect(rowRule).toContain('min-width: 0');
    const labelRule = ruleBlock(css, '.series-row-label');
    expect(labelRule).toContain('min-width: 0');
    expect(labelRule).toContain('overflow-wrap: anywhere');
    expect(labelRule).not.toContain('white-space: nowrap');
    const metaRule = ruleBlock(css, '.series-row-meta');
    expect(metaRule).toContain('white-space: nowrap');
    expect(metaRule).toContain('font-variant-numeric: tabular-nums');
    const amountRule = ruleBlock(css, '.series-row-amount');
    expect(amountRule).toContain('white-space: nowrap');
    expect(amountRule).toContain('font-variant-numeric: tabular-nums');
  });

  it('mobile ≤640px: duas linhas por grid-areas (label no topo; meta+valor embaixo)', () => {
    const small = maxMediaBlock(css, '640px');
    expect(small).toContain('.series-row-label');
    expect(small).toMatch(/grid-template-areas:\s*['"]label\s+label['"]\s+['"]meta\s+amt['"]/);
    // A ordem do DOM continua label → meta → amount (sem trocar células).
    expect(small).toMatch(/\.series-row-label\s*\{\s*grid-area:\s*label;/);
    expect(small).toMatch(/\.series-row-meta\s*\{\s*grid-area:\s*meta;/);
    expect(small).toMatch(/\.series-row-amount\s*\{\s*grid-area:\s*amt;/);
  });

  it('bloco da seção NÃO usa posicionamento absoluto/fixo para conteúdo financeiro', () => {
    const start = css.indexOf('/* Parcelamentos e recorrências */');
    const end = css.indexOf('/* Maiores despesas */');
    const section = css.slice(start, end);
    expect(section).not.toContain('position: absolute');
    expect(section).not.toContain('position: fixed');
  });
});