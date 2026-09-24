// pessoal12.test.ts — PESSOAL-12: Análises financeiras determinísticas.
// Cobre os 6 blocos: resumo, evolução mensal, categorias, pago x previsto,
// parcelamentos/recorrências e maiores despesas — incluindo transferências fora,
// isolamento por período, estados vazios e responsividade mobile.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  summaryByPeriod,
  expensesByCategory,
  buildEvolutionWindow,
  monthlyEvolution,
  paidVsForecast,
  topExpenses,
  toSeriesOccurrenceRows,
  installmentSummary,
  recurringSummary,
  upcomingCommitments,
  buildInsights,
  EVOLUTION_MONTHS,
  type SeriesOccurrenceRow,
} from '../lib/analyticsInsights';
import type { AnalyticsTxRow } from '../lib/analytics';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const TODAY = '2026-09-13';
const CUTOFF = '2026-08-01';

function tx(partial: Partial<AnalyticsTxRow> & { id: string }, occurredOn = '2026-09-01'): AnalyticsTxRow {
  return {
    transaction_kind: 'expense',
    amount: 10,
    account_id: 'A1',
    category_id: null,
    occurred_on: occurredOn,
    status: 'posted',
    raw_description: 'Despesa',
    accounts: null,
    categories: null,
    ...partial,
  };
}

function occ(partial: Partial<SeriesOccurrenceRow>): SeriesOccurrenceRow {
  const base: SeriesOccurrenceRow = {
    series_id: 'S1',
    state: 'completed',
    kind: 'installment',
    frequency: 'monthly',
    direction: 'expense',
    display_name: 'Compra parcelada',
    amount_total: 1200,
    total_occurrences: 12,
    starts_on: '2026-01-10',
    occurrence_index: 1,
    occurred_on: '2026-09-10',
    amount: 100,
    tx_status: 'scheduled',
    tx_deleted_at: null,
  };
  return { ...base, ...partial };
}

describe('PESSOAL-12 — Resumo do período', () => {
  it('receitas e despesas corretas; resultado = receitas − despesas', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 300, raw_description: 'Salário' }),
      tx({ id: '2', transaction_kind: 'expense', amount: 80, raw_description: 'Mercado' }),
      tx({ id: '3', transaction_kind: 'expense', amount: 20, raw_description: 'Transporte' }),
    ];
    const s = summaryByPeriod(rows);
    expect(s.income).toBe(300);
    expect(s.expense).toBe(100);
    expect(s.balance).toBe(200);
    expect(s.totalCount).toBe(3);
  });

  it('transferências são excluídas dos totais de receita e despesa', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 500 }),
      tx({ id: '2', transaction_kind: 'expense', amount: 150 }),
      tx({ id: '3', transaction_kind: 'transfer', amount: 9999 }),
      tx({ id: '4', transaction_kind: 'transfer', amount: 9999 }),
    ];
    const s = summaryByPeriod(rows);
    expect(s.income).toBe(500);
    expect(s.expense).toBe(150);
    expect(s.balance).toBe(350);
  });

  it('percentual de despesas sobre receitas (share = despesas / receitas)', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 200 }),
      tx({ id: '2', transaction_kind: 'expense', amount: 50 }),
    ];
    expect(summaryByPeriod(rows).expenseShare).toBeCloseTo(0.25);
  });

  it('sem receitas: expenseShare é null (nunca divide por zero)', () => {
    const rows = [tx({ id: '1', transaction_kind: 'expense', amount: 50 })];
    expect(summaryByPeriod(rows).expenseShare).toBeNull();
  });
});

describe('PESSOAL-12 — Gastos por categoria', () => {
  it('ranking por categoria ordenado por valor com % do total de despesas', () => {
    const rows = [
      tx({ id: '1', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 70 }),
      tx({ id: '2', category_id: 'B', categories: { display_name: 'B', canonical_path: 'B' }, amount: 30 }),
      tx({ id: '3', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 50 }),
    ];
    const b = expensesByCategory(rows);
    expect(b[0].label).toBe('A');
    expect(b[0].amount).toBe(120);
    expect(b[0].share).toBeCloseTo(0.8);
    expect(b[1].amount).toBe(30);
  });

  it('Top N respeita o limite; receitas e transferências nunca entram', () => {
    const rows = [
      tx({ id: '1', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 100 }),
      tx({ id: '2', category_id: 'B', categories: { display_name: 'B', canonical_path: 'B' }, amount: 90 }),
      tx({ id: '3', category_id: 'C', categories: { display_name: 'C', canonical_path: 'C' }, amount: 80 }),
      tx({ id: '4', transaction_kind: 'income', category_id: 'Z', categories: { display_name: 'Z', canonical_path: 'Z' }, amount: 5000 }),
      tx({ id: '5', transaction_kind: 'transfer', category_id: 'W', categories: { display_name: 'W', canonical_path: 'W' }, amount: 999 }),
    ];
    expect(expensesByCategory(rows, 2)).toHaveLength(2);
    expect(expensesByCategory(rows, 2)[0].label).toBe('A');
    expect(expensesByCategory(rows, 2).every((c) => c.label !== 'Z')).toBe(true);
  });

  it('categoria vem do category_id real (nunca inferida por descrição)', () => {
    const rows = [tx({ id: '1', category_id: null, raw_description: 'IFOOD' })];
    const b = expensesByCategory(rows);
    expect(b[0].label).toBe('Sem categoria');
    expect(b[0].label).not.toMatch(/ifood/i);
  });
});

describe('PESSOAL-12 — Evolução mensal', () => {
  it('janela: 6 meses cheios terminando no mês selecionado', () => {
    const w = buildEvolutionWindow({ year: 2026, month: 9 });
    expect(w.months).toHaveLength(6);
    expect(w.months[0]).toEqual({ year: 2026, month: 4 });
    expect(w.months[5]).toEqual({ year: 2026, month: 9 });
    expect(w.start).toBe('2026-04-01');
    expect(w.end).toBe('2026-09-30');
  });

  it('EVOLUTION_MONTHS é 6 e o clamp de conta respeita o mínimo', () => {
    expect(EVOLUTION_MONTHS).toBe(6);
    expect(buildEvolutionWindow({ year: 2026, month: 9 }, 2).months).toHaveLength(2);
  });

  it('agrupa receitas e despesas por mês; meses sem movimento zerados', () => {
    const w = buildEvolutionWindow({ year: 2026, month: 9 }, 3);
    const rows = [
      tx({ id: '1', transaction_kind: 'expense', amount: 100 }, '2026-07-15'),
      tx({ id: '2', transaction_kind: 'income', amount: 400 }, '2026-09-01'),
      tx({ id: '3', transaction_kind: 'transfer', amount: 9000 }, '2026-09-05'),
    ];
    const pts = monthlyEvolution(rows, w.months);
    expect(pts).toHaveLength(3);
    expect(pts[0].key).toBe('2026-07');
    expect(pts[0].expense).toBe(100);
    expect(pts[0].income).toBe(0);
    expect(pts[0].balance).toBe(-100);
    expect(pts[1].key).toBe('2026-08');
    expect(pts[1].income).toBe(0);
    expect(pts[1].expense).toBe(0);
    expect(pts[2].key).toBe('2026-09');
    expect(pts[2].income).toBe(400);
    expect(pts[2].expense).toBe(0);
  });

  it('linhas fora da janela são ignoradas; rótulo curto pt-BR', () => {
    const w = buildEvolutionWindow({ year: 2026, month: 9 }, 2);
    const pts = monthlyEvolution(
      [tx({ id: '1', transaction_kind: 'income', amount: 1 }, '2020-01-01')],
      w.months,
    );
    expect(pts.every((p) => p.income === 0)).toBe(true);
    expect(pts[0].label).toBe('ago');
    expect(pts[1].label).toBe('set');
  });
});

describe('PESSOAL-12 — Pago x previsto', () => {
  it('posted = Pago; pending/review/scheduled/ignored = Não pago (a partir do cutoff)', () => {
    const rows = [
      tx({ id: '1', amount: 100, status: 'posted' }),
      tx({ id: '2', amount: 40, status: 'pending' }),
      tx({ id: '3', amount: 30, status: 'review' }),
      tx({ id: '4', amount: 20, status: 'scheduled' }),
      tx({ id: '5', amount: 10, status: 'ignored' }),
    ];
    const pv = paidVsForecast(rows);
    expect(pv.paid).toBe(100);
    expect(pv.unpaid).toBe(100);
    expect(pv.total).toBe(200);
    expect(pv.outsideStatusWindow).toBe(0);
  });

  it('antes do cutoff: entra no total, mas NÃO é classificado Pago/Não pago', () => {
    const rows = [
      tx({ id: '1', amount: 50, status: 'posted' }, '2026-01-01'),
      tx({ id: '2', amount: 30, status: 'posted' }),
    ];
    const pv = paidVsForecast(rows);
    expect(pv.paid).toBe(30);
    expect(pv.total).toBe(80);
    expect(pv.outsideStatusWindow).toBe(50);
  });

  it('transferências nunca entram no pago x previsto', () => {
    const rows = [
      tx({ id: '1', amount: 100, status: 'posted' }),
      tx({ id: '2', transaction_kind: 'transfer', amount: 7777, status: 'posted' }),
    ];
    const pv = paidVsForecast(rows);
    expect(pv.paid).toBe(100);
    expect(pv.unpaid).toBe(0);
    expect(pv.total).toBe(100);
  });
});

describe('PESSOAL-12 — Maiores despesas', () => {
  it('Top 5 por valor com descrição, categoria e data; transferências fora', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'expense', amount: 500, raw_description: 'Aluguel', category_id: 'C', categories: { display_name: 'Casa', canonical_path: 'Casa' } }),
      tx({ id: '2', transaction_kind: 'expense', amount: 800, raw_description: 'Faculdade', category_id: 'E', categories: { display_name: 'Educação', canonical_path: 'Educação' } }),
      tx({ id: '3', transaction_kind: 'transfer', amount: 99999, raw_description: 'Pix interno' }),
    ];
    const top = topExpenses(rows, 5);
    expect(top).toHaveLength(2);
    expect(top[0].description).toBe('Faculdade');
    expect(top[0].category).toBe('Educação');
    expect(top[0].amount).toBe(800);
    expect(top[0].occurred_on).toBe('2026-09-01');
  });
});

describe('PESSOAL-12 — toSeriesOccurrenceRows (normalização do embed)', () => {
  it('normaliza objeto e variante array do PostgREST', () => {
    const rows = toSeriesOccurrenceRows([
      { occurrence_index: 3, occurred_on: '2026-11-10', amount: 100.08, transaction_series: { id: 'S1', kind: 'installment', frequency: 'monthly', state: 'completed', amount_total: 1201 }, transactions: { status: 'scheduled', deleted_at: null } },
      { occurrence_index: 1, occurred_on: '2026-10-10', amount: '90', transaction_series: [{ kind: 'recurring' }], transactions: [{ status: 'posted' }] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].series_id).toBe('S1');
    expect(rows[0].kind).toBe('installment');
    expect(rows[0].amount).toBe(100.08);
    expect(rows[0].tx_status).toBe('scheduled');
    expect(rows[1].kind).toBe('recurring');
  });

  it('defensivo: linhas inválidas/nulas são ignoradas (sem crash)', () => {
    expect(toSeriesOccurrenceRows([null, {}, { occurrence_index: 1 }, 42, 'x'])).toHaveLength(0);
  });
});

describe('PESSOAL-12 — Parcelamentos (sem /99, sem total artificial)', () => {
  it('valor comprometido soma apenas as ocorrências não pagas (nunca amount_total cego)', () => {
    const rows = [
      occ({ series_id: 'S1', occurrence_index: 1, occurred_on: '2026-09-10', amount: 100.08, tx_status: 'scheduled' }),
      occ({ series_id: 'S1', occurrence_index: 2, occurred_on: '2026-10-10', amount: 100.08, tx_status: 'scheduled' }),
      occ({ series_id: 'S1', occurrence_index: 3, occurred_on: '2026-11-10', amount: 100.12, tx_status: 'scheduled' }),
    ];
    const ins = installmentSummary(rows, TODAY);
    expect(ins.count).toBe(1);
    expect(ins.committed).toBeCloseTo(300.28, 2);
    expect(ins.items[0].amount).toBeCloseTo(300.28, 2);
    expect(ins.items[0].remaining).toBe(3);
    expect(ins.items[0].nextDate).toBe('2026-09-10');
  });

  it('ocorrência paga (posted) não é compromisso futuro', () => {
    const rows = [
      occ({ series_id: 'S1', occurrence_index: 1, occurred_on: '2026-07-10', amount: 100, tx_status: 'posted' }),
      occ({ series_id: 'S1', occurrence_index: 2, occurred_on: '2026-08-10', amount: 100, tx_status: 'posted' }),
      occ({ series_id: 'S1', occurrence_index: 3, occurred_on: '2026-09-10', amount: 100, tx_status: 'posted' }),
    ];
    const ins = installmentSummary(rows, TODAY);
    expect(ins.count).toBe(0);
    expect(ins.committed).toBe(0);
  });

  it('ocorrência soft-deleted (transação apagada) é ignorada', () => {
    const rows = [
      occ({ series_id: 'S1', occurrence_index: 1, occurred_on: '2026-10-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S2', occurrence_index: 1, occurred_on: '2026-10-10', amount: 500, tx_status: 'scheduled', tx_deleted_at: '2026-09-13T00:00:00Z' }),
    ];
    const ins = installmentSummary(rows, TODAY);
    expect(ins.count).toBe(1);
    expect(ins.items[0].seriesId).toBe('S1');
  });

  it('parcelas próximas de terminar = até 2 restantes (nunca "/99")', () => {
    const rows = [
      occ({ series_id: 'S1', occurrence_index: 1, occurred_on: '2026-10-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S2', occurrence_index: 1, occurred_on: '2026-10-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S2', occurrence_index: 2, occurred_on: '2026-11-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S3', occurrence_index: 1, occurred_on: '2026-10-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S3', occurrence_index: 2, occurred_on: '2026-11-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S3', occurrence_index: 3, occurred_on: '2026-12-10', amount: 100, tx_status: 'scheduled' }),
    ];
    const fin = installmentSummary(rows, TODAY).finishingSoon.map((c) => c.seriesId).sort();
    expect(fin).toEqual(['S1', 'S2']);
    expect(installmentSummary(rows, TODAY).items.every((c) => c.remaining === 1 || c.remaining === 2 || c.remaining === 3)).toBe(true);
  });
});

describe('PESSOAL-12 — Recorrências', () => {
  it('recorrência aberta (state active) conta mesmo sem ocorrência futura na janela', () => {
    const rows = [occ({ kind: 'recurring', state: 'active', occurred_on: '2026-08-10', amount: 90, tx_status: 'posted' })];
    const rec = recurringSummary(rows, TODAY);
    expect(rec.count).toBe(1);
    expect(rec.items[0].frequencyLabel).toBe('Mensal');
    expect(rec.items[0].nextDate).toBeNull();
  });

  it('recorrência finita com ocorrência futura viva conta; sem futuro não conta', () => {
    const futura = [
      occ({ kind: 'recurring', state: 'completed', series_id: 'R1', occurred_on: '2026-10-10', amount: 90, tx_status: 'scheduled' }),
    ];
    const passada = [
      occ({ kind: 'recurring', state: 'completed', series_id: 'R2', occurred_on: '2026-07-10', amount: 90, tx_status: 'posted' }),
    ];
    expect(recurringSummary(futura, TODAY).count).toBe(1);
    expect(recurringSummary(passada, TODAY).count).toBe(0);
  });

  it('recorrência encerrada (stopped) nunca conta', () => {
    const rows = [occ({ kind: 'recurring', state: 'stopped', series_id: 'R3', occurred_on: '2026-10-10', amount: 90, tx_status: 'scheduled' })];
    expect(recurringSummary(rows, TODAY).count).toBe(0);
  });
});

describe('PESSOAL-12 — Próximos compromissos', () => {
  it('ordena por data e respeita o limite; rótulos Parcela/Recorrente', () => {
    const rows = [
      occ({ series_id: 'S2', occurred_on: '2026-11-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S1', kind: 'recurring', occurred_on: '2026-10-10', amount: 90, tx_status: 'scheduled' }),
      occ({ series_id: 'S3', occurred_on: '2026-12-10', amount: 50, tx_status: 'scheduled' }),
    ];
    const up = upcomingCommitments(rows, TODAY, 2);
    expect(up).toHaveLength(2);
    expect(up[0].kindLabel).toBe('Recorrente');
    expect(up[0].occurredOn).toBe('2026-10-10');
    expect(up[1].kindLabel).toBe('Parcela');
    expect(up[1].key).toContain('S2');
  });

  it('compromissos passados/pagos nunca aparecem como próximos', () => {
    const rows = [
      occ({ series_id: 'S1', occurred_on: '2026-08-10', amount: 100, tx_status: 'posted' }),
      occ({ series_id: 'S2', occurred_on: '2026-08-20', amount: 100, tx_status: 'scheduled', tx_deleted_at: '2026-09-01T00:00:00Z' }),
    ];
    expect(upcomingCommitments(rows, TODAY)).toHaveLength(0);
  });
});

describe('PESSOAL-12 — Estados vazios e números finitos', () => {
  it('buildInsights com entradas vazias devolve zeros/vazios sem NaN', () => {
    const w = buildEvolutionWindow({ year: 2026, month: 9 });
    const ins = buildInsights({ periodRows: [], evolutionRows: [], seriesOccurrences: [], months: w.months, todayISO: TODAY });
    expect(ins.summary.income).toBe(0);
    expect(ins.summary.expense).toBe(0);
    expect(ins.summary.balance).toBe(0);
    expect(ins.summary.expenseShare).toBeNull();
    expect(ins.expensesByCategory).toHaveLength(0);
    expect(ins.topExpenses).toHaveLength(0);
    expect(ins.paidVsForecast.paid).toBe(0);
    expect(ins.paidVsForecast.unpaid).toBe(0);
    expect(ins.paidVsForecast.total).toBe(0);
    expect(ins.installment.count).toBe(0);
    expect(ins.installment.committed).toBe(0);
    expect(ins.recurring.count).toBe(0);
    expect(ins.upcoming).toHaveLength(0);
    expect(ins.monthlyEvolution).toHaveLength(6);
    const allNumbers: number[] = [];
    const collect = (v: unknown) => {
      if (typeof v === 'number') allNumbers.push(v);
    };
    collect(ins.summary.income);
    collect(ins.summary.expense);
    collect(ins.summary.balance);
    for (const p of ins.monthlyEvolution) collect(p.balance);
    for (const p of ins.monthlyEvolution) collect(p.income);
    for (const p of ins.monthlyEvolution) collect(p.expense);
    collect(ins.paidVsForecast.paid);
    collect(ins.paidVsForecast.unpaid);
    collect(ins.paidVsForecast.total);
    collect(ins.installment.committed);
    expect(allNumbers.every(Number.isFinite)).toBe(true);
  });
});

describe('PESSOAL-12 — View (consultas, read-only e blocos)', () => {
  const view = `${readSource('views/AnalyticsView.tsx')}\n${readSource('components/SeriesFinancials.tsx')}`;
  const css = readSource('index.css');

  it('período selecionado respeitado com gte/lte inclusivos (2 consultas em transactions)', () => {
    expect(view).toContain(".gte('occurred_on', range.start)");
    expect(view).toContain(".lte('occurred_on', range.end)");
    expect(view.split(".from('transactions')").length - 1).toBe(2);
  });

  it('evolução busca projeção enxuta (amount, transaction_kind, occurred_on) sem embeds', () => {
    const evoIdx = view.indexOf("const evolutionFetcher");
    const evoBlock = view.slice(evoIdx, evoIdx + 700);
    expect(evoBlock).toContain("select('amount, transaction_kind, occurred_on'");
    expect(evoBlock).not.toContain('accounts(');
    expect(evoBlock).not.toContain('categories(');
    expect(evoBlock).toContain(".is('deleted_at', null)");
  });

  it('séries consultadas via transaction_series_occurrences (bloco dedicado, read-only)', () => {
    expect(view).toContain(".from('transaction_series_occurrences')");
    expect(view).toContain('occurrence_index, occurred_on, amount');
    expect(view).toContain('transactions(status, deleted_at)');
    expect(view).not.toMatch(/\.rpc\(/);
    expect(view).not.toMatch(/\.insert\(/);
    expect(view).not.toMatch(/\.update\(/);
    expect(view).not.toMatch(/\.delete\(/);
    expect(view).not.toMatch(/\.upsert\(/);
  });

  it('todos os blocos estão presentes na tela (mobile-first)', () => {
    for (const label of ['Resumo do período', 'Evolução mensal', 'Despesas por categoria', 'Pago x previsto', 'Parcelamentos e recorrências', 'Maiores despesas']) {
      expect(view).toContain(label);
    }
  });

  it('sem títulos técnicos nem "Parcela X de 99" fabricado', () => {
    expect(view).not.toContain('/99');
    expect(view).not.toContain('category_raw');
    const insightsSrc = readSource('lib/analyticsInsights.ts');
    const insightsCode = insightsSrc.slice(insightsSrc.indexOf('export function installmentSummary'));
    expect(insightsCode).not.toContain('/99');
    expect(insightsCode).not.toContain('amount_total *');
  });

  it('estados vazios amigáveis por bloco', () => {
    expect(view).toContain('Nenhuma transação no período selecionado');
    expect(view).toContain('Nenhuma despesa no período');
    expect(view).toContain('Nenhuma receita no período');
    expect(view).toContain('Nenhuma parcela ou recorrência futura cadastrada.');
  });

  it('responsividade mobile: classes do gráfico e compactação em telas estreitas', () => {
    expect(css).toContain('.evolution-chart');
    expect(css).toContain('.series-metrics');
    expect(css).toContain('@media (max-width: 480px)');
    expect(css).toContain('.analytics-toggle');
  });
});