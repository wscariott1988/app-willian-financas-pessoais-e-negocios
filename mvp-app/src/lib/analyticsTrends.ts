// analyticsTrends.ts — Motor puro de tendências de gasto e oportunidades de
// economia (PESSOAL-13C3B-E1).
//
// Lógica 100% determinística e testável; nenhum write; nenhum acesso ao
// Supabase. Reutiliza as regras canônicas do PESSOAL-12/13 (analytics.ts,
// analyticsInsights.ts, period.ts) SEM duplicá-las:
//   - despesa = transaction_kind 'expense'; transferências NUNCA entram
//   - receitas não participam das médias de gasto
//   - categoria SEMPRE pelo category_id vinculado (display_name/canonical_path);
//     nunca por descrição
//   - deleted_at IS NULL é pré-requisito das consultas (linhas já canônicas)
//   - meses sem gasto entram como ZERO nas médias
//   - TODOS os valores são trabalhados em CENTAVOS (inteiros) para evitar erro
//     de ponto flutuante; conversão via Math.round(valor * 100)
//
// Contrato de período (nowISO OBRIGATÓRIO/injetável, YYYY-MM-DD local,
// America/Sao_Paulo; datas construídas por partes locais, nunca toISOString):
//   - 'six_complete'      ("últimos 6 meses") → 6 meses completos anteriores
//     ao mês atual; base = 1..3, recent = 4..6.
//   - 'five_plus_current' ("incluindo este mês") → 6 slots: 5 completos +
//     mês atual PARCIAL (isPartialCurrent=true, sem extrapolação do parcial);
//     base = 1..3, recent = 4..6 (inclui o mês parcial).
//   - 'six_plus_current'  ("seis meses completos mais este mês") → 7 slots:
//     6 completos + mês atual parcial em preview (fora de base/recent).

import { categoryLabel, type AnalyticsTxRow } from './analytics.js';
import { MONTH_FULL } from './analyticsInsights.js';
import { addMonths, daysInMonth, toLocalISODate } from './period.js';

// ============ Constantes de materialidade/crescimento ============

export const MATERIALITY_MIN_CENTS = 5000; // R$ 50,00
export const MATERIALITY_SHARE = 0.02; // 2% da média mensal total recente
export const MIN_GROWTH_RATE = 0.2; // crescimento relativo mínimo (20%)
export const MIN_RECENT_MONTHS = 2; // presença mínima nos 3 meses recentes
export const BASE_EPSILON_CENTS = 50; // base "quase zero": até R$ 0,50
export const SPIKE_SHARE = 0.65; // maior mês recente / soma dos 3 recentes
export const TREND_TOP_DEFAULT = 3;
export const TREND_MAX_RESULTS = 100;

// ============ Janela de período ============

export type TrendWindowStyle = 'six_complete' | 'five_plus_current' | 'six_plus_current';

export interface TrendMonthSlot {
  key: string; // 'YYYY-MM'
  label: string; // 'março de 2026'
  year: number;
  month: number; // 1..12
  start: string; // 'YYYY-MM-01' (local)
  end: string; // último dia do mês — ou hoje quando isPartial
  isCurrent: boolean;
  isPartial: boolean;
}

export interface TrendWindow {
  style: TrendWindowStyle;
  months: TrendMonthSlot[]; // cronológico
  base: TrendMonthSlot[]; // 3 slots (1..3)
  recent: TrendMonthSlot[]; // 3 slots (4..6)
  preview?: TrendMonthSlot; // 7º slot parcial apenas em 'six_plus_current'
  isPartialCurrent: boolean;
  start: string;
  end: string;
  baseStart: string;
  baseEnd: string;
  recentStart: string;
  recentEnd: string;
}

const pad2 = (v: number) => String(v).padStart(2, '0');

interface YearMonth {
  year: number;
  month: number; // 1..12
}

function monthLabel(ym: YearMonth): string {
  const name = MONTH_FULL[ym.month - 1] ?? '';
  return name ? `${name} de ${ym.year}` : `${ym.year}-${pad2(ym.month)}`;
}

function fullMonthSlot(ym: YearMonth): TrendMonthSlot {
  const lastDay = daysInMonth(ym.year, ym.month);
  return {
    key: `${ym.year}-${pad2(ym.month)}`,
    label: monthLabel(ym),
    year: ym.year,
    month: ym.month,
    start: toLocalISODate(ym.year, ym.month, 1),
    end: toLocalISODate(ym.year, ym.month, lastDay),
    isCurrent: false,
    isPartial: false,
  };
}

function partialCurrentSlot(now: { year: number; month: number; day: number }): TrendMonthSlot {
  return {
    key: `${now.year}-${pad2(now.month)}`,
    label: monthLabel(now),
    year: now.year,
    month: now.month,
    start: toLocalISODate(now.year, now.month, 1),
    end: toLocalISODate(now.year, now.month, now.day),
    isCurrent: true,
    isPartial: true,
  };
}

function monthsBackSlots(anchor: YearMonth, count: number): TrendMonthSlot[] {
  const slots: TrendMonthSlot[] = [];
  for (let i = count; i >= 1; i--) {
    slots.push(fullMonthSlot(addMonths(anchor, -i)));
  }
  return slots;
}

function parseLocalISO(iso: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new RangeError(`nowISO inválido: "${iso}" (esperado YYYY-MM-DD local)`);
  }
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`nowISO inválido: "${iso}" (data inexistente)`);
  }
  return { year, month, day };
}

/**
 * Janela de tendência com base no relógio LOCAL injetável. Lança RangeError para
 * nowISO inválido (data obrigatória). Não extrapola o mês parcial: o slot do mês
 * atual termina exatamente em `nowISO`.
 */
export function buildTrendWindow(nowISO: string, style: TrendWindowStyle = 'six_complete'): TrendWindow {
  const now = parseLocalISO(nowISO);
  const anchor: YearMonth = { year: now.year, month: now.month };

  let months: TrendMonthSlot[];
  switch (style) {
    case 'six_complete':
      months = monthsBackSlots(anchor, 6);
      break;
    case 'five_plus_current':
      months = [...monthsBackSlots(anchor, 5), partialCurrentSlot(now)];
      break;
    case 'six_plus_current':
      months = [...monthsBackSlots(anchor, 6), partialCurrentSlot(now)];
      break;
    default: {
      const exhaustive: never = style;
      throw new RangeError(`estilo de janela desconhecido: ${String(exhaustive)}`);
    }
  }

  const base = months.slice(0, 3);
  const recent = months.slice(3, 6);
  const preview = months.length === 7 ? months[6] : undefined;

  return {
    style,
    months,
    base,
    recent,
    preview,
    isPartialCurrent: months[months.length - 1]?.isPartial === true,
    start: months[0].start,
    end: months[months.length - 1].end,
    baseStart: base[0].start,
    baseEnd: base[2].end,
    recentStart: recent[0].start,
    recentEnd: recent[2].end,
  };
}

// ============ Agregação por categoria (centavos) ============

interface CategoryBucket {
  categoryId: string | null;
  label: string;
  base: number[]; // [3] centavos, zeros preenchidos
  recent: number[]; // [3] centavos, zeros preenchidos
  countRecent: number; // n.º de transações na janela recente
}

function number(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toCents(v: number | string | null | undefined): number {
  return Math.round(number(v) * 100);
}

function sumCents(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function roundCents(v: number): number {
  return Math.round(v);
}

function meanCents(values: number[]): number {
  return values.length === 0 ? 0 : roundCents(sumCents(values) / values.length);
}

function stdDevCents(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const m = meanCents(values);
  const variance = values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / n;
  return Math.sqrt(variance);
}

/**
 * Agrupa despesas 'expense' por categoria nas janelas base/recent, com meses
 * sem gasto preenchidos com ZERO. Transferências/receitas nunca entram. Linhas
 * fora das janelas são ignoradas. NÃO muta o array de entrada.
 */
function bucketByCategory(
  rows: ReadonlyArray<AnalyticsTxRow>,
  window: TrendWindow,
): Map<string, CategoryBucket> {
  const map = new Map<string, CategoryBucket>();
  for (const r of rows) {
    if (r.transaction_kind !== 'expense') continue;
    const date = r.occurred_on ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    let idx = -1;
    let isRecent = false;
    for (let i = 0; i < window.base.length; i++) {
      const s = window.base[i];
      if (date >= s.start && date <= s.end) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      for (let i = 0; i < window.recent.length; i++) {
        const s = window.recent[i];
        if (date >= s.start && date <= s.end) {
          idx = i;
          isRecent = true;
          break;
        }
      }
    }
    if (idx === -1) continue;

    const key = r.category_id ?? '__none__';
    let b = map.get(key);
    if (!b) {
      b = { categoryId: r.category_id, label: categoryLabel(r), base: [0, 0, 0], recent: [0, 0, 0], countRecent: 0 };
      map.set(key, b);
    }
    const amount = toCents(r.amount);
    if (isRecent) {
      b.recent[idx] += amount;
      b.countRecent += 1;
    } else {
      b.base[idx] += amount;
    }
  }
  return map;
}

// ============ Crescimento por categoria ============

export type GrowthClassification = 'growth' | 'spike' | 'new' | 'none';

export interface GrowthCategoryResult {
  categoryId: string | null;
  label: string;
  monthlyCentsBase: number[]; // [3] centavos (zeros preenchidos)
  monthlyCentsRecent: number[]; // [3] centavos (zeros preenchidos)
  meanACents: number; // média meses 1..3
  meanRCents: number; // média meses 4..6
  deltaCents: number; // meanR − meanA
  growthPct: number | null; // delta/meanA; null quando base <= epsilon
  spikeShare: number | null; // max(recent)/soma(recent); null quando soma 0
  classification: GrowthClassification;
  monthsRecentWithSpend: number;
  significant: boolean;
  transactionCount: number;
}

export interface CategoryGrowthAnalysis {
  rows: GrowthCategoryResult[]; // todas as categorias agregadas
  significant: GrowthCategoryResult[]; // significativas, ranqueadas (limitadas)
  top: GrowthCategoryResult[]; // top padrão (limitado por topLimit)
  materialityCents: number; // M = max(R$ 50, 2% da média mensal total recente)
  meanRecentTotalCents: number;
  insufficientData: boolean;
}

export interface TrendAnalysisOptions {
  materialityMinCents?: number;
  materialityShare?: number;
  minGrowthRate?: number;
  minRecentMonths?: number;
  baseEpsilonCents?: number;
  spikeShare?: number;
  maxResults?: number;
  topLimit?: number;
}

function resolveOptions(opts: TrendAnalysisOptions) {
  return {
    materialityMinCents: opts.materialityMinCents ?? MATERIALITY_MIN_CENTS,
    materialityShare: opts.materialityShare ?? MATERIALITY_SHARE,
    minGrowthRate: opts.minGrowthRate ?? MIN_GROWTH_RATE,
    minRecentMonths: opts.minRecentMonths ?? MIN_RECENT_MONTHS,
    baseEpsilonCents: opts.baseEpsilonCents ?? BASE_EPSILON_CENTS,
    spikeShare: opts.spikeShare ?? SPIKE_SHARE,
    maxResults: Math.max(1, Math.min(opts.maxResults ?? TREND_MAX_RESULTS, TREND_MAX_RESULTS)),
    topLimit: Math.max(1, opts.topLimit ?? TREND_TOP_DEFAULT),
  };
}

function compareGrowth(a: GrowthCategoryResult, b: GrowthCategoryResult): number {
  // 1) delta descendente; 2) growthPct descendente (new = +∞ = desempate especial);
  // 3) canonical_path alfabético.
  if (b.deltaCents !== a.deltaCents) return b.deltaCents - a.deltaCents;
  const aGrowth = a.growthPct ?? Infinity;
  const bGrowth = b.growthPct ?? Infinity;
  if (bGrowth !== aGrowth) return bGrowth - aGrowth;
  return a.label.localeCompare(b.label);
}

/**
 * Métricas de crescimento de TODAS as categorias de despesa das janelas.
 * Categoria existente é significativa quando: presença em >= 2 meses recentes,
 * delta >= M e growthPct >= 20%. Categoria nova (meanA <= R$ 0,50) é
 * significativa quando meanR >= M, com growthPct = null (nunca infinito).
 * spikeShare >= 0,65 classifica como 'spike'; categoria presente em 1 mês é
 * 'none' (não é tendência nesta fase). NUNCA muta a entrada.
 */
export function analyzeCategoryGrowth(
  rows: ReadonlyArray<AnalyticsTxRow>,
  window: TrendWindow,
  opts: TrendAnalysisOptions = {},
): CategoryGrowthAnalysis {
  const cfg = resolveOptions(opts);
  const buckets = bucketByCategory(rows, window);
  const totalRecentCents = [...buckets.values()].reduce((acc, b) => acc + sumCents(b.recent), 0);
  const meanRecentTotalCents = roundCents(totalRecentCents / 3);
  const materialityCents = Math.max(
    cfg.materialityMinCents,
    roundCents(meanRecentTotalCents * cfg.materialityShare),
  );

  const results: GrowthCategoryResult[] = [];
  for (const b of buckets.values()) {
    const meanA = meanCents(b.base);
    const meanR = meanCents(b.recent);
    const deltaCents = meanR - meanA;
    const growthPct = meanA > cfg.baseEpsilonCents ? deltaCents / meanA : null;
    const recentSum = sumCents(b.recent);
    const spikeShare = recentSum > 0 ? Math.max(...b.recent) / recentSum : null;
    const monthsRecentWithSpend = b.recent.filter((v) => v > 0).length;

    let classification: GrowthClassification = 'none';
    if (monthsRecentWithSpend >= cfg.minRecentMonths) {
      if (meanA <= cfg.baseEpsilonCents) classification = 'new';
      else if (spikeShare !== null && spikeShare >= cfg.spikeShare) classification = 'spike';
      else classification = 'growth';
    }

    let significant = classification !== 'none';
    if (significant) {
      significant =
        classification === 'new'
          ? meanR >= materialityCents
          : deltaCents >= materialityCents &&
            growthPct !== null &&
            growthPct >= cfg.minGrowthRate;
    }

    results.push({
      categoryId: b.categoryId,
      label: b.label,
      monthlyCentsBase: [...b.base],
      monthlyCentsRecent: [...b.recent],
      meanACents: meanA,
      meanRCents: meanR,
      deltaCents,
      growthPct,
      spikeShare,
      classification,
      monthsRecentWithSpend,
      significant,
      transactionCount: b.countRecent,
    });
  }

  const significantRows = results
    .filter((r) => r.significant)
    .sort(compareGrowth)
    .slice(0, cfg.maxResults);

  return {
    rows: results,
    significant: significantRows,
    top: significantRows.slice(0, cfg.topLimit),
    materialityCents,
    meanRecentTotalCents,
    insufficientData: significantRows.length === 0,
  };
}

/**
 * Análise de crescimento + ranking (atende ao objetivo "onde aumentou").
 * Conveniência sobre analyzeCategoryGrowth.
 */
export function topGrowingCategories(
  rows: ReadonlyArray<AnalyticsTxRow>,
  window: TrendWindow,
  opts: TrendAnalysisOptions = {},
): CategoryGrowthAnalysis {
  return analyzeCategoryGrowth(rows, window, opts);
}

// ============ Oportunidades de economia ============

export type VariabilityBand = 'low' | 'medium' | 'high';

export interface SavingsOpportunity {
  categoryId: string | null;
  label: string;
  percent: number;
  meanRCents: number;
  economyMonthlyCents: number; // meanR × percentual
  economyAnnualCents: number; // economia mensal × 12 (simulação)
  share: number; // participação sobre a média total recente (0..1)
  regularity: number; // meses recentes com gasto / 3
  variability: VariabilityBand | null;
  cv: number | null; // desvio-padrão (populacional) / meanR sobre os 3 recentes
  transactionCount: number;
  growthPct: number | null;
  deltaCents: number;
  monthsRecentWithSpend: number;
  monthlyCentsRecent: number[];
}

export interface SavingsResult {
  items: SavingsOpportunity[];
  top: SavingsOpportunity[];
  insufficientData: boolean;
  meanRecentTotalCents: number;
}

/**
 * "Oportunidades potenciais para revisar" — NUNCA uma promessa de economia e
 * nunca qualifica a categoria; cenário padrão 10%. Percentual custom válido
 * somente quando 0 < percent <= 100 (caso contrário lança RangeError). Elegibilidade: presença em >= 2 meses recentes e
 * meanR > 0. Ranking: economia mensal desc → participação desc → path alfabético.
 * CV: <= 0,25 baixa; <= 0,75 média; > 0,75 alta. Sem categoria elegível ou sem
 * gasto recente → insufficientData=true (saída explícita, jamais cards vazios).
 */
export function savingsOpportunities(
  rows: ReadonlyArray<AnalyticsTxRow>,
  window: TrendWindow,
  percent: number = 10,
  opts: TrendAnalysisOptions = {},
): SavingsResult {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new RangeError(`percentual inválido: ${percent} (esperado > 0 e <= 100)`);
  }
  const cfg = resolveOptions(opts);
  const buckets = bucketByCategory(rows, window);
  const totalRecentCents = [...buckets.values()].reduce((acc, b) => acc + sumCents(b.recent), 0);
  const meanRecentTotalCents = roundCents(totalRecentCents / 3);

  const items: SavingsOpportunity[] = [];
  for (const b of buckets.values()) {
    const meanR = meanCents(b.recent);
    const monthsRecentWithSpend = b.recent.filter((v) => v > 0).length;
    if (monthsRecentWithSpend < cfg.minRecentMonths || meanR <= 0) continue;

    const economyMonthlyCents = roundCents((meanR * percent) / 100);
    const meanA = meanCents(b.base);
    const deltaCents = meanR - meanA;
    const growthPct = meanA > cfg.baseEpsilonCents ? deltaCents / meanA : null;
    const regularity = monthsRecentWithSpend / 3;
    const cv = stdDevCents(b.recent) / meanR;
    let variability: VariabilityBand | null = null;
    if (cv <= 0.25) variability = 'low';
    else if (cv <= 0.75) variability = 'medium';
    else variability = 'high';

    items.push({
      categoryId: b.categoryId,
      label: b.label,
      percent,
      meanRCents: meanR,
      economyMonthlyCents,
      economyAnnualCents: economyMonthlyCents * 12,
      share: meanRecentTotalCents > 0 ? meanR / meanRecentTotalCents : 0,
      regularity,
      variability,
      cv,
      transactionCount: b.countRecent,
      growthPct,
      deltaCents,
      monthsRecentWithSpend,
      monthlyCentsRecent: [...b.recent],
    });
  }

  items.sort((a, b) => {
    if (b.economyMonthlyCents !== a.economyMonthlyCents) {
      return b.economyMonthlyCents - a.economyMonthlyCents;
    }
    if (b.share !== a.share) return b.share - a.share;
    return a.label.localeCompare(b.label);
  });

  const capped = items.slice(0, cfg.maxResults);
  return {
    items: capped,
    top: capped.slice(0, cfg.topLimit),
    insufficientData: capped.length === 0,
    meanRecentTotalCents,
  };
}