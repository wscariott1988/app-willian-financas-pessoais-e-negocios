// pessoal13c3aTrends.test.ts — PESSOAL-13C3B-E1: motor puro de tendências e
// oportunidades de economia (analyticsTrends.ts).
//
// Fixtures 100% fictícias; nenhum Supabase, Gemini, JWT ou dado real. Cobre:
//  períodos (6 completos; 5+parcial; 7 slots; virada de ano; fevereiro bissexto);
//  média/arredondamento em centavos; materialidade R$50 e 2%; delta < M;
//  crescimento < 20%; base zero/quase zero; presença 1/2/3 meses; spikeShare
//  em 0,65; queda; empates; ranking; top 3; economia 5/10/custom e rejeições;
//  economia mensal/anual; regularidade; 3 faixas de CV; dados insuficientes;
//  entradas não mutadas; determinismo; nenhuma string inútil/desnecessário/dispensável.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyticsTxRow } from '../lib/analytics';
import {
  buildTrendWindow,
  analyzeCategoryGrowth,
  topGrowingCategories,
  savingsOpportunities,
  MATERIALITY_MIN_CENTS,
  MATERIALITY_SHARE,
  MIN_GROWTH_RATE,
  MIN_RECENT_MONTHS,
  BASE_EPSILON_CENTS,
  SPIKE_SHARE,
} from '../lib/analyticsTrends';

const here = dirname(fileURLToPath(import.meta.url));

const SUPER = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PADARIA = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };
const MORADIA = { display_name: 'Moradia', canonical_path: 'Moradia > Aluguel' };
const SAUDE = { display_name: 'Saúde', canonical_path: 'Saúde' };

type Cat = { display_name: string; canonical_path: string | null };

let seq = 0;

function tx(
  date: string,
  amount: number,
  cats: Cat | null = SUPER,
  kind: 'expense' | 'income' | 'transfer' = 'expense',
): AnalyticsTxRow {
  seq += 1;
  return {
    id: `tx-${seq}`,
    transaction_kind: kind,
    amount,
    account_id: 'ACCT-1',
    category_id: cats ? 'cat-' + cats.canonical_path : null,
    occurred_on: date,
    status: 'posted',
    raw_description: `desc-${seq}`,
    accounts: { display_name: 'Conta' },
    categories: cats,
  };
}

// month: 1..12
function days(month: number, day: number): string {
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ============ 1. Período ============

describe('PESSOAL-13C3B-E1: buildTrendWindow', () => {
  it('seis meses completos por padrão (six_complete), sem mês atual', () => {
    const w = buildTrendWindow('2026-09-16');
    expect(w.style).toBe('six_complete');
    expect(w.months.map((m) => m.key)).toEqual([
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
    ]);
    expect(w.months).toHaveLength(6);
    expect(w.base.map((m) => m.key)).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(w.recent.map((m) => m.key)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(w.preview).toBeUndefined();
    expect(w.isPartialCurrent).toBe(false);
    expect(w.start).toBe('2026-03-01');
    expect(w.end).toBe('2026-08-31');
    expect(w.baseStart).toBe('2026-03-01');
    expect(w.baseEnd).toBe('2026-05-31');
    expect(w.recentStart).toBe('2026-06-01');
    expect(w.recentEnd).toBe('2026-08-31');
  });

  it('"incluindo este mês" = exatamente 6 slots: 5 completos + mês atual parcial (sem extrapolação)', () => {
    const w = buildTrendWindow('2026-09-16', 'five_plus_current');
    expect(w.style).toBe('five_plus_current');
    expect(w.months).toHaveLength(6);
    expect(w.months.map((m) => m.key)).toEqual([
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    const actual = w.months[w.months.length - 1];
    expect(actual.isPartial).toBe(true);
    expect(actual.isCurrent).toBe(true);
    expect(actual.start).toBe('2026-09-01');
    expect(actual.end).toBe('2026-09-16');
    expect(w.isPartialCurrent).toBe(true);
    expect(w.recent[w.recent.length - 1].isPartial).toBe(true);
    expect(w.end).toBe('2026-09-16');
  });

  it('apenas "seis meses completos mais este mês" (six_plus_current) gera 7 slots com preview parcial', () => {
    const w = buildTrendWindow('2026-09-16', 'six_plus_current');
    expect(w.months).toHaveLength(7);
    expect(w.base).toHaveLength(3);
    expect(w.recent).toHaveLength(3);
    expect(w.recent.map((m) => m.key)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(w.preview?.key).toBe('2026-09');
    expect(w.preview?.isPartial).toBe(true);
    expect(w.isPartialCurrent).toBe(true);
    expect(w.recent.some((m) => m.isPartial)).toBe(false);
  });

  it('virada de ano: dezembro→janeiro derivado por partes locais', () => {
    const w = buildTrendWindow('2026-01-10');
    expect(w.months.map((m) => m.key)).toEqual([
      '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
    ]);
    expect(w.base.map((m) => m.key)).toEqual(['2025-07', '2025-08', '2025-09']);
    expect(w.recent.map((m) => m.key)).toEqual(['2025-10', '2025-11', '2025-12']);
    expect(w.start).toBe('2025-07-01');
    expect(w.end).toBe('2025-12-31');
  });

  it('virada de ano com mês atual parcial (five_plus_current)', () => {
    const w = buildTrendWindow('2026-01-10', 'five_plus_current');
    expect(w.months).toHaveLength(6);
    expect(w.months[w.months.length - 1].key).toBe('2026-01');
    expect(w.months[w.months.length - 1].end).toBe('2026-01-10');
    expect(w.months.map((m) => m.key)).toEqual([
      '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
    ]);
  });

  it('fevereiro bissexto: último dia 29', () => {
    const w = buildTrendWindow('2024-03-15');
    expect(w.months.map((m) => m.key)).toEqual([
      '2023-09', '2023-10', '2023-11', '2023-12', '2024-01', '2024-02',
    ]);
    expect(w.end).toBe('2024-02-29');
  });

  it('nowISO inválido lança RangeError (formato e data inexistente)', () => {
    expect(() => buildTrendWindow('2026/09/16')).toThrow(RangeError);
    expect(() => buildTrendWindow('2024-02-30')).toThrow(RangeError);
    expect(() => buildTrendWindow('2026-13-01')).toThrow(RangeError);
    expect(() => buildTrendWindow('')).toThrow(RangeError);
  });
});

// ============ 2. Crescimento ============

const W = buildTrendWindow('2026-09-16'); // base mar-mai, recent jun-ago

interface GrowthRowHelper {
  sumir?: never;
}

describe('PESSOAL-13C3B-E1: análise de crescimento', () => {
  it('médias e arredondamento em centavos, com mês zerado preenchido', () => {
    const rows = [
      tx(days(3, 10), 100.0), // março
      tx(days(5, 20), 200.0), // maio (abril zerado => conta como zero)
      tx(days(6, 5), 10.0),
      tx(days(6, 5), 0.5),
      tx(days(7, 5), 10.5),
      tx(days(8, 5), 9.8),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const row = a.rows.find((r) => r.label === 'Alimentação > Supermercado');
    expect(row).toBeDefined();
    expect(row!.monthlyCentsBase).toEqual([10000, 0, 20000]);
    expect(row!.monthlyCentsRecent).toEqual([1050, 1050, 980]);
    expect(row!.meanACents).toBe(10000); // round(30000/3)
    expect(row!.meanRCents).toBe(1027); // round(3080/3)
  });

  it('materialidade piso R$50 quando o total recente é pequeno', () => {
    const rows = [tx(days(5, 5), 100.0), tx(days(6, 5), 100.0), tx(days(7, 5), 100.0), tx(days(8, 5), 100.0)];
    const a = analyzeCategoryGrowth(rows, W);
    expect(a.materialityCents).toBe(MATERIALITY_MIN_CENTS);
    expect(a.meanRecentTotalCents).toBe(10000); // R$ 100/mês
  });

  it('piso adaptativo de 2% da média mensal total recente quando maior que R$50', () => {
    const rows = [
      tx(days(6, 1), 3000.0, MORADIA),
      tx(days(7, 1), 3000.0, MORADIA),
      tx(days(8, 1), 3000.0, MORADIA),
      // base
      tx(days(3, 1), 1000.0, MORADIA),
      tx(days(4, 1), 1000.0, MORADIA),
      tx(days(5, 1), 1000.0, MORADIA),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    expect(a.meanRecentTotalCents).toBe(300000); // R$ 3000
    expect(a.materialityCents).toBe(Math.round(300000 * MATERIALITY_SHARE)); // 6000 > 5000
    const row = a.rows.find((r) => r.label === 'Moradia > Aluguel');
    expect(row!.meanACents).toBe(100000);
    expect(row!.meanRCents).toBe(300000);
    expect(row!.deltaCents).toBe(200000);
    expect(row!.significant).toBe(true);
  });

  it('delta abaixo da materialidade => não significativo', () => {
    const rows = [
      tx(days(3, 5), 1000.0),
      tx(days(4, 5), 1000.0),
      tx(days(5, 5), 1000.0),
      tx(days(6, 5), 1010.0),
      tx(days(7, 5), 1000.0),
      tx(days(8, 5), 1020.0),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const row = a.rows[0];
    expect(row!.meanRCents).toBe(101000);
    expect(row!.deltaCents).toBe(1000);
    expect(row!.deltaCents).toBeLessThan(a.materialityCents);
    expect(row!.significant).toBe(false);
    expect(a.significant).toHaveLength(0);
    expect(a.insufficientData).toBe(true);
  });

  it('crescimento abaixo de 20% => não significativo', () => {
    const rows = [
      tx(days(3, 5), 1000.0),
      tx(days(4, 5), 1000.0),
      tx(days(5, 5), 1000.0),
      tx(days(6, 5), 1100.0),
      tx(days(7, 5), 1120.0),
      tx(days(8, 5), 1110.0),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const row = a.rows[0];
    expect(row!.deltaCents).toBe(11000);
    expect(row!.growthPct).toBeCloseTo(0.11, 5);
    expect(row!.growthPct!).toBeLessThan(MIN_GROWTH_RATE);
    expect(row!.significant).toBe(false);
  });

  it('base zero => classificação "new", growthPct null, significativa quando meanR >= M', () => {
    const rowsNova = [
      tx(days(6, 5), 700.0),
      tx(days(7, 5), 800.0),
      tx(days(8, 5), 600.0),
    ];
    const a = analyzeCategoryGrowth(rowsNova, W);
    const row = a.rows[0];
    expect(row!.meanACents).toBe(0);
    expect(row!.classification).toBe('new');
    expect(row!.growthPct).toBeNull();
    expect(row!.meanRCents).toBe(70000);
    expect(row!.significant).toBe(true);
    expect(a.significant).toHaveLength(1);
    expect(a.top[0].label).toBe('Alimentação > Supermercado');
  });

  it('base quase zero (até R$0,50) ainda é "new" com growthPct null', () => {
    const rows = [
      tx(days(3, 5), 0.5), // R$ 0,50 em 1 mês da base
      tx(days(6, 5), 700.0),
      tx(days(7, 5), 800.0),
      tx(days(8, 5), 600.0),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const row = a.rows[0];
    expect(row!.meanACents).toBeLessThanOrEqual(BASE_EPSILON_CENTS);
    expect(row!.classification).toBe('new');
    expect(row!.growthPct).toBeNull();
    expect(row!.significant).toBe(true);
  });

  it('base zero com meanR abaixo da materialidade não é significativa', () => {
    const rows = [
      tx(days(6, 5), 90.0),
      tx(days(7, 5), 20.0),
      tx(days(8, 5), 40.0), // meanR = round(15000/3) = 5000 = M => significativa
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const row = a.rows[0];
    expect(row!.meanRCents).toBe(5000);
    expect(row!.significant).toBe(true); // meanR >= M (= 5000)

    const rowsAbaixo = [
      tx(days(6, 5), 80.0),
      tx(days(7, 5), 20.0),
      tx(days(8, 5), 20.0), // meanR = 4000 < M
    ];
    const b = analyzeCategoryGrowth(rowsAbaixo, W);
    expect(b.rows[0].meanRCents).toBe(4000);
    expect(b.rows[0].significant).toBe(false);
  });

  it('presença em 1, 2 e 3 meses recentes', () => {
    const um = analyzeCategoryGrowth([tx(days(6, 5), 500.0)], W);
    expect(um.rows[0].monthsRecentWithSpend).toBe(1);
    expect(um.rows[0].classification).toBe('none');
    expect(um.rows[0].significant).toBe(false);

    const dois = analyzeCategoryGrowth(
      [tx(days(6, 5), 500.0), tx(days(8, 5), 500.0), tx(days(3, 5), 100.0), tx(days(4, 5), 100.0), tx(days(5, 5), 100.0)],
      W,
    );
    expect(dois.rows[0].monthsRecentWithSpend).toBe(2);
    expect(dois.rows[0].significant).toBe(true);

    const tres = analyzeCategoryGrowth(
      [tx(days(6, 5), 400.0), tx(days(7, 5), 400.0), tx(days(8, 5), 400.0), tx(days(3, 5), 100.0), tx(days(4, 5), 100.0), tx(days(5, 5), 100.0)],
      W,
    );
    expect(tres.rows[0].monthsRecentWithSpend).toBe(3);
    expect(tres.rows[0].significant).toBe(true);
  });

  it('categoria base zero com presença em apenas 1 mês não é tendência (nem "new")', () => {
    const rows = [tx(days(6, 5), 900.0)];
    const a = analyzeCategoryGrowth(rows, W);
    expect(a.rows[0].meanACents).toBe(0);
    expect(a.rows[0].monthsRecentWithSpend).toBe(1);
    expect(a.rows[0].classification).toBe('none');
    expect(a.rows[0].significant).toBe(false);
  });

  it('M usa a média mensal total da janela recente (global), não a da categoria', () => {
    const rows = [
      // Moradia é grande e eleva meanRecentTotal acima do delta da categoria pequena.
      tx(days(3, 1), 1000.0, MORADIA),
      tx(days(4, 1), 1000.0, MORADIA),
      tx(days(5, 1), 1000.0, MORADIA),
      tx(days(6, 1), 5000.0, MORADIA),
      tx(days(7, 1), 5000.0, MORADIA),
      tx(days(8, 1), 5000.0, MORADIA),
      tx(days(3, 5), 400.0, SUPER),
      tx(days(4, 5), 400.0, SUPER),
      tx(days(5, 5), 400.0, SUPER),
      tx(days(6, 5), 500.0, SUPER),
      tx(days(7, 5), 500.0, SUPER),
      tx(days(8, 5), 500.0, SUPER),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const superRow = a.rows.find((r) => r.label === 'Alimentação > Supermercado');
    const moradiaRow = a.rows.find((r) => r.label === 'Moradia > Aluguel');
    // meanRecentTotal = (500000*3 + 50000*3)/3 = 550000 → 2% = 11000 > R$50
    expect(a.meanRecentTotalCents).toBe(550000);
    expect(a.materialityCents).toBe(11000);
    expect(superRow!.deltaCents).toBe(10000);
    expect(superRow!.deltaCents).toBeLessThan(a.materialityCents);
    expect(superRow!.significant).toBe(false);
    expect(moradiaRow!.deltaCents).toBe(400000);
    expect(moradiaRow!.significant).toBe(true);
  });

  it('spikeShare exatamente 0,65 classifica como spike', () => {
    const rows = [
      tx(days(6, 5), 6500.0),
      tx(days(7, 5), 2000.0),
      tx(days(8, 5), 1500.0),
      tx(days(3, 5), 2000.0),
      tx(days(4, 5), 2000.0),
      tx(days(5, 5), 2000.0),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const row = a.rows[0];
    expect(row!.spikeShare).toBeCloseTo(SPIKE_SHARE, 10);
    expect(row!.classification).toBe('spike');
    expect(row!.significant).toBe(true);
  });

  it('queda de gastos não é exposta como crescimento', () => {
    const rows = [
      tx(days(3, 5), 2000.0),
      tx(days(4, 5), 2000.0),
      tx(days(5, 5), 2000.0),
      tx(days(6, 5), 1000.0),
      tx(days(7, 5), 1000.0),
      tx(days(8, 5), 1000.0),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    expect(a.rows[0].meanRCents).toBe(100000);
    expect(a.rows[0].meanACents).toBe(200000);
    expect(a.rows[0].deltaCents).toBe(-100000);
    expect(a.rows[0].significant).toBe(false);
    expect(a.significant).toHaveLength(0);
  });

  it('empate em delta e growthPct é resolvido pelo canonical_path alfabético', () => {
    const base = [tx(days(3, 5), 1000.0, SUPER), tx(days(4, 5), 1000.0, SUPER), tx(days(5, 5), 1000.0, SUPER), tx(days(3, 5), 1000.0, PADARIA), tx(days(4, 5), 1000.0, PADARIA), tx(days(5, 5), 1000.0, PADARIA)];
    const rec = [tx(days(6, 5), 2000.0, SUPER), tx(days(7, 5), 2000.0, SUPER), tx(days(8, 5), 2000.0, SUPER), tx(days(6, 5), 2000.0, PADARIA), tx(days(7, 5), 2000.0, PADARIA), tx(days(8, 5), 2000.0, PADARIA)];
    const a = analyzeCategoryGrowth([...base, ...rec], W);
    const sig = a.significant;
    expect(sig).toHaveLength(2);
    expect(sig[0].label).toBe('Alimentação > Padaria');
    expect(sig[1].label).toBe('Alimentação > Supermercado');
    expect(sig[0].deltaCents).toBe(sig[1].deltaCents);
    expect(sig[0].growthPct).toBeCloseTo(sig[1].growthPct!, 10);
    // Determinismo: repetir produz a mesma ordem
    const again = analyzeCategoryGrowth([...base, ...rec], W);
    expect(again.significant.map((r) => r.label)).toEqual(sig.map((r) => r.label));
  });

  it('"new" é desempate especial quando o delta empata (primeiro em ranking)', () => {
    const rows = [
      // NOVO: base zero, delta = 100000
      tx(days(6, 5), 1000.0, SAUDE),
      tx(days(7, 5), 1000.0, SAUDE),
      tx(days(8, 5), 1000.0, SAUDE),
      // EXISTENTE: base 500000/mês, recent 600000/mês, delta = 100000 (pct 20%)
      tx(days(3, 5), 5000.0, MORADIA),
      tx(days(4, 5), 5000.0, MORADIA),
      tx(days(5, 5), 5000.0, MORADIA),
      tx(days(6, 5), 6000.0, MORADIA),
      tx(days(7, 5), 6000.0, MORADIA),
      tx(days(8, 5), 6000.0, MORADIA),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    const saude = a.significant.find((r) => r.label === 'Saúde');
    const moradia = a.significant.find((r) => r.label === 'Moradia > Aluguel');
    expect(saude!.deltaCents).toBe(100000);
    expect(moradia!.deltaCents).toBe(100000);
    expect(saude!.growthPct).toBeNull();
    expect(moradia!.growthPct).toBeGreaterThanOrEqual(MIN_GROWTH_RATE);
    expect(a.significant[0].label).toBe('Saúde'); // new vem antes no empate
  });

  it('top 3 padrão retorna os 3 primeiros do ranking', () => {
    const cats = [SUPER, PADARIA, MORADIA, SAUDE];
    const rows: AnalyticsTxRow[] = [];
    for (const c of cats) {
      rows.push(tx(days(3, 5), 300.0, c));
      rows.push(tx(days(4, 5), 300.0, c));
      rows.push(tx(days(5, 5), 300.0, c));
      rows.push(tx(days(6, 5), 900.0, c));
      rows.push(tx(days(7, 5), 900.0, c));
      rows.push(tx(days(8, 5), 900.0, c));
    }
    const a = topGrowingCategories(rows, W);
    expect(a.significant).toHaveLength(4);
    expect(a.top).toHaveLength(3);
    expect(a.top).toEqual(a.significant.slice(0, 3));
    expect(a.significant[0].deltaCents).toBe(60000); // todos com delta 60000 -> path asc
  });

  it('transferências e receitas nunca entram nas métricas', () => {
    const rows = [
      tx(days(6, 5), 1500.0, SUPER),
      tx(days(7, 5), 1500.0, SUPER),
      tx(days(8, 5), 1500.0, SUPER),
      tx(days(6, 10), 999999.0, null, 'transfer'),
      tx(days(7, 10), 999999.0, null, 'income'),
    ];
    const a = analyzeCategoryGrowth(rows, W);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].meanRCents).toBe(150000);
  });

  it('materialidade custom via options respeita override', () => {
    const rows = [
      tx(days(3, 5), 1000.0),
      tx(days(4, 5), 1000.0),
      tx(days(5, 5), 1000.0),
      tx(days(6, 5), 1400.0),
      tx(days(7, 5), 1400.0),
      tx(days(8, 5), 1400.0),
    ];
    const a = analyzeCategoryGrowth(rows, W, { materialityMinCents: 200000 });
    expect(a.materialityCents).toBe(200000);
    expect(a.rows[0].deltaCents).toBe(40000);
    expect(a.rows[0].significant).toBe(false);
  });

  it('maxResults defensivo limita a lista retornada', () => {
    const cats = [SUPER, PADARIA, MORADIA, SAUDE];
    const rows: AnalyticsTxRow[] = [];
    for (const c of cats) {
      rows.push(tx(days(6, 5), 60.0, c));
      rows.push(tx(days(7, 5), 60.0, c));
      rows.push(tx(days(8, 5), 60.0, c));
    }
    const full = analyzeCategoryGrowth(rows, W);
    expect(full.significant).toHaveLength(4);
    const capped = analyzeCategoryGrowth(rows, W, { maxResults: 2 });
    expect(capped.significant).toHaveLength(2);
    expect(capped.top).toHaveLength(2);
  });

  it('teto rígido de 100 resultados mesmo quando maxResults pedir mais', () => {
    // 120 categorias todas significativas; um pedido de 1000 deve ser
    // frustrado pelo teto público TREND_MAX_RESULTS=100.
    const rows: AnalyticsTxRow[] = [];
    const cats: Cat[] = [];
    for (let i = 1; i <= 120; i++) {
      cats.push({ display_name: `Categoria ${i}`, canonical_path: `Grupo > Categoria ${i}` });
    }
    const base: AnalyticsTxRow[] = [];
    const rec: AnalyticsTxRow[] = [];
    for (const c of cats) {
      base.push(tx(days(3, 5), 1000.0, c));
      base.push(tx(days(4, 5), 1000.0, c));
      base.push(tx(days(5, 5), 1000.0, c));
      rec.push(tx(days(6, 5), 3000.0, c));
      rec.push(tx(days(7, 5), 3000.0, c));
      rec.push(tx(days(8, 5), 3000.0, c));
    }
    rows.push(...base, ...rec);
    const capped = analyzeCategoryGrowth(rows, W, { maxResults: 1000, materialityShare: 0 });
    expect(capped.significant).toHaveLength(100);
    expect(capped.top).toHaveLength(3);
    const savings = savingsOpportunities(rows, W, 10, { maxResults: 1000 });
    expect(savings.items).toHaveLength(100);
    expect(savings.top).toHaveLength(3);
  });

  it('entradas não são mutadas e resultados são determinísticos', () => {
    const rows: AnalyticsTxRow[] = [
      tx(days(3, 5), 1000.0),
      tx(days(4, 5), 1000.0),
      tx(days(5, 5), 1000.0),
      tx(days(6, 5), 2000.0),
      tx(days(7, 5), 2000.0),
      tx(days(8, 5), 2000.0),
    ];
    const snapshot = rows.map((r) => ({ ...r }));
    const a = topGrowingCategories(rows, W);
    expect(rows).toEqual(snapshot);
    const b = topGrowingCategories(rows, W);
    expect(a).toEqual(b);
  });
});

// ============ 3. Economia ============

describe('PESSOAL-13C3B-E1: oportunidades de economia', () => {
  it('10% default: economia mensal = meanR × pct e anual = mensal × 12', () => {
    const rows = [
      tx(days(6, 5), 300.0),
      tx(days(7, 5), 300.0),
      tx(days(8, 5), 300.0),
    ];
    const s = savingsOpportunities(rows, W);
    expect(s.insufficientData).toBe(false);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].meanRCents).toBe(30000);
    expect(s.items[0].percent).toBe(10);
    expect(s.items[0].economyMonthlyCents).toBe(3000);
    expect(s.items[0].economyAnnualCents).toBe(3000 * 12);
  });

  it('5% e custom (15%): economia escala com o percentual', () => {
    const rows = [
      tx(days(6, 5), 300.0),
      tx(days(7, 5), 300.0),
      tx(days(8, 5), 300.0),
    ];
    const s5 = savingsOpportunities(rows, W, 5);
    expect(s5.items[0].economyMonthlyCents).toBe(1500);
    const s100 = savingsOpportunities(rows, W, 100);
    expect(s100.items[0].economyMonthlyCents).toBe(30000);
    const s15 = savingsOpportunities(rows, W, 15);
    expect(s15.items[0].economyMonthlyCents).toBe(4500);
  });

  it('percentuais 0, negativos e >100 são rejeitados', () => {
    const rows = [tx(days(6, 5), 300.0), tx(days(7, 5), 300.0), tx(days(8, 5), 300.0)];
    expect(() => savingsOpportunities(rows, W, 0)).toThrow(RangeError);
    expect(() => savingsOpportunities(rows, W, -10)).toThrow(RangeError);
    expect(() => savingsOpportunities(rows, W, 101)).toThrow(RangeError);
    expect(() => savingsOpportunities(rows, W, Number.NaN)).toThrow(RangeError);
  });

  it('ranking: economia mensal desc → participação desc → path alfabético', () => {
    // SUPER: meanR 40000 (10% = 4000); MORADIA: meanR 20000 (10% = 2000)
    // SUPER maior economia; empate de economia não se configura aqui.
    // PESSOAL-13C3B.10: Moradia > Aluguel é compromisso fixo → fora do ranking.
    const rows = [
      tx(days(6, 5), 400.0, SUPER),
      tx(days(7, 5), 400.0, SUPER),
      tx(days(8, 5), 400.0, SUPER),
      tx(days(6, 5), 200.0, MORADIA),
      tx(days(7, 5), 200.0, MORADIA),
      tx(days(8, 5), 200.0, MORADIA),
    ];
    const s = savingsOpportunities(rows, W);
    expect(s.items.map((i) => i.label)).toEqual(['Alimentação > Supermercado']);
    expect(s.excluded.map((e) => e.label)).toEqual(['Moradia > Aluguel']);
    expect(s.excluded[0].classification).toBe('fixed_contract');
  });

  it('regularidade mensal = meses com gasto / 3', () => {
    const rows = [
      tx(days(6, 5), 200.0),
      tx(days(8, 5), 200.0), // 2 de 3 meses
    ];
    const s = savingsOpportunities(rows, W);
    expect(s.items[0].monthsRecentWithSpend).toBe(2);
    expect(s.items[0].regularity).toBeCloseTo(2 / 3, 10);
  });

  it('três faixas de CV sobre os 3 meses recentes', () => {
    const baixa = savingsOpportunities([tx(days(6, 5), 100.0), tx(days(7, 5), 101.0), tx(days(8, 5), 102.0)], W);
    expect(baixa.items[0].variability).toBe('low');
    expect(baixa.items[0].cv).toBeLessThanOrEqual(0.25);

    const media = savingsOpportunities([tx(days(6, 5), 100.0), tx(days(7, 5), 150.0), tx(days(8, 5), 200.0)], W);
    expect(media.items[0].variability).toBe('medium');
    expect(media.items[0].cv!).toBeGreaterThan(0.25);
    expect(media.items[0].cv!).toBeLessThanOrEqual(0.75);

    const alta = savingsOpportunities([tx(days(6, 5), 500.0), tx(days(7, 5), 50.0), tx(days(8, 5), 50.0)], W);
    expect(alta.items[0].variability).toBe('high');
    expect(alta.items[0].cv!).toBeGreaterThan(0.75);
  });

  it('crescimento e participação entram como evidências', () => {
    const rows = [
      tx(days(6, 5), 400.0),
      tx(days(7, 5), 400.0),
      tx(days(8, 5), 400.0),
      tx(days(3, 5), 200.0),
      tx(days(4, 5), 200.0),
      tx(days(5, 5), 200.0),
    ];
    const s = savingsOpportunities(rows, W);
    expect(s.items[0].growthPct).toBeCloseTo(1.0, 5);
    expect(s.items[0].share).toBeCloseTo(1.0, 5);
    expect(s.items[0].transactionCount).toBe(3);
  });

  it('dados insuficientes sem gasto recente ou categoria elegível', () => {
    const semGasto = savingsOpportunities([], W);
    expect(semGasto.insufficientData).toBe(true);
    expect(semGasto.items).toHaveLength(0);
    expect(semGasto.top).toHaveLength(0);

    const apenasUmMes = savingsOpportunities([tx(days(6, 5), 900.0)], W);
    expect(apenasUmMes.insufficientData).toBe(true);

    const soReceitas = savingsOpportunities([tx(days(6, 5), 900.0, null, 'income')], W);
    expect(soReceitas.insufficientData).toBe(true);
  });

  it('economia nunca fabrica strings de julgamento; entradas não mudam', () => {
    const rows = [
      tx(days(6, 5), 300.0),
      tx(days(7, 5), 300.0),
      tx(days(8, 5), 300.0),
    ];
    const snapshot = rows.map((r) => ({ ...r }));
    const s1 = savingsOpportunities(rows, W);
    expect(rows).toEqual(snapshot);
    const s2 = savingsOpportunities(rows, W);
    expect(s1).toEqual(s2);
  });
});

// ============ 4. Higiene ============

describe('PESSOAL-13C3B-E1: higiene', () => {
  it('fonte do motor não contém inútil/desnecessário/dispensável', () => {
    const src = readFileSync(resolve(here, '../lib/analyticsTrends.ts'), 'utf8');
    expect(src.toLowerCase()).not.toContain('inútil');
    expect(src.toLowerCase()).not.toContain('inutil');
    expect(src.toLowerCase()).not.toContain('desnecessário');
    expect(src.toLowerCase()).not.toContain('desnecessario');
    expect(src.toLowerCase()).not.toContain('dispensável');
    expect(src.toLowerCase()).not.toContain('dispensavel');
  });

  it('contantes públicas têm os valores definidos', () => {
    expect(MATERIALITY_MIN_CENTS).toBe(5000);
    expect(MATERIALITY_SHARE).toBe(0.02);
    expect(MIN_GROWTH_RATE).toBe(0.2);
    expect(MIN_RECENT_MONTHS).toBe(2);
    expect(BASE_EPSILON_CENTS).toBe(50);
    expect(SPIKE_SHARE).toBe(0.65);
  });
});