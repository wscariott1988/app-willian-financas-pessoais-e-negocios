// pessoal12Defaults.test.ts — PESSOAL-12 (ajuste final): default de período por
// aba e isolamento do estado entre telas.
// - Início abre em "Até hoje" (up_to_today);
// - Transações e Análises abrem em "Mês todo" (full_month → 01/MM/AAAA → fim do mês);
// - o subtítulo redundante "Leitura do período no perfil ... somente leitura" saiu;
// - alternar de aba não contamina o default das demais; mudanças manuais são
//   preservadas na sessão (sem reset a cada render).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppShell } from '../components/AppShell';
import {
  PERIOD_DEFAULT_MODES,
  createPeriodState,
  periodReducer,
  type PeriodContextId,
} from '../lib/periodController';
import {
  computePeriodRange,
  daysInMonth,
  selectionFromDate,
  toLocalISODate,
  formatShortDate,
} from '../lib/period';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const NOOP = () => {};
const shellProps = {
  profileId: '11111111-1111-1111-1111-111111111111',
  profileCode: 'personal' as const,
  userEmail: 'usuario@exemplo.com',
  onProfileSwitch: NOOP,
  onLogout: NOOP,
  onProfileSwitchRequest: NOOP,
};

describe('PESSOAL-12 — default de período por contexto', () => {
  it('Início = up_to_today (Até hoje); Transações = full_month; Análises = full_month', () => {
    expect(PERIOD_DEFAULT_MODES.inicio).toBe('up_to_today');
    expect(PERIOD_DEFAULT_MODES.transacoes).toBe('full_month');
    expect(PERIOD_DEFAULT_MODES.analises).toBe('full_month');
  });

  it('estado inicial por contexto respeita o default (createPeriodState)', () => {
    const today = new Date(2026, 8, 13);
    expect(createPeriodState(PERIOD_DEFAULT_MODES.inicio, today).mode).toBe('up_to_today');
    expect(createPeriodState(PERIOD_DEFAULT_MODES.transacoes, today).mode).toBe('full_month');
    expect(createPeriodState(PERIOD_DEFAULT_MODES.analises, today).mode).toBe('full_month');
  });

  it('cada contexto inicia no mês atual, sem resíduo de outro contexto', () => {
    const inicio = createPeriodState(PERIOD_DEFAULT_MODES.inicio, new Date(2026, 8, 13));
    const txs = createPeriodState(PERIOD_DEFAULT_MODES.transacoes, new Date(2026, 8, 13));
    const anl = createPeriodState(PERIOD_DEFAULT_MODES.analises, new Date(2026, 8, 13));
    expect(inicio.selection).toEqual(txs.selection);
    expect(txs.selection).toEqual(anl.selection);
    expect(inicio.mode).not.toBe(txs.mode);
  });
});

describe('PESSOAL-12 — "Mês todo" = intervalo completo do mês selecionado', () => {
  it('setembro/2026 em full_month resulta em 01/09/2026 → 30/09/2026 (qualquer hoje)', () => {
    const range = computePeriodRange({ year: 2026, month: 9 }, 'full_month', new Date(2026, 0, 5));
    expect(range).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  it('o default full_month de Transações seleciona setembro/2026 e cobre o mês inteiro', () => {
    const txs = createPeriodState(PERIOD_DEFAULT_MODES.transacoes, new Date(2026, 8, 13));
    const next = periodReducer(txs, { type: 'selection_change', selection: { year: 2026, month: 9 } });
    const range = computePeriodRange(next.selection, next.mode, new Date(2026, 8, 13));
    expect(range).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  it('o default full_month de Análises cobre o mês inteiro (01 → último dia)', () => {
    const anl = createPeriodState(PERIOD_DEFAULT_MODES.analises, new Date(2026, 8, 13));
    const next = periodReducer(anl, { type: 'selection_change', selection: { year: 2026, month: 9 } });
    const range = computePeriodRange(next.selection, next.mode, new Date(2026, 8, 13));
    const last = daysInMonth(2026, 9);
    expect(range.start).toBe('2026-09-01');
    expect(range.end).toBe(toLocalISODate(2026, 9, last));
  });
});

describe('PESSOAL-12 — subtítulo redundante removido da aba Análises', () => {
  it('o texto "Leitura do período no perfil ... somente leitura" não aparece', () => {
    const view = readSource('views/AnalyticsView.tsx');
    expect(view).not.toContain('Leitura do período no perfil Pessoal - somente leitura');
    expect(view).not.toContain('Leitura do período no perfil Negócio - somente leitura');
    expect(view).not.toContain('somente leitura');
  });

  it('a tela começa diretamente pelo seletor de período (sem subtítulo substituto)', () => {
    const view = readSource('views/AnalyticsView.tsx');
    expect(view).not.toContain('dash-title');
    const returnIndex = view.lastIndexOf('return (');
    const afterReturn = view.slice(returnIndex, returnIndex + 120);
    expect(afterReturn).toContain('<div className="analytics-root">');
    expect(view.indexOf('<PeriodSelector') > -1).toBe(true);
  });
});

describe('PESSOAL-12 — isolamento entre abas (sem contaminação)', () => {
  it('mudar o modo de um contexto não altera os demais', () => {
    const inicio = createPeriodState(PERIOD_DEFAULT_MODES.inicio, new Date(2026, 8, 13));
    const txs = createPeriodState(PERIOD_DEFAULT_MODES.transacoes, new Date(2026, 8, 13));
    const anl = createPeriodState(PERIOD_DEFAULT_MODES.analises, new Date(2026, 8, 13));

    // usuário muda Transações p/ "Até hoje" (manual): só esse contexto muda.
    const txsChanged = periodReducer(txs, { type: 'mode_change', mode: 'up_to_today' });
    expect(txsChanged.mode).toBe('up_to_today');
    expect(inicio.mode).toBe('up_to_today');
    expect(anl.mode).toBe('full_month');

    // usuário muda Análises p/ "Até hoje": Início e Transações intactos.
    const anlChanged = periodReducer(anl, { type: 'mode_change', mode: 'up_to_today' });
    expect(anlChanged.mode).toBe('up_to_today');
    expect(inicio.mode).toBe('up_to_today');
    expect(txsChanged.mode).toBe('up_to_today');
  });

  it('entrar em Análises nunca muda Home para "Mês todo" nem Análises para "Até hoje"', () => {
    const inicio = createPeriodState(PERIOD_DEFAULT_MODES.inicio, new Date(2026, 8, 13));
    const anl = createPeriodState(PERIOD_DEFAULT_MODES.analises, new Date(2026, 8, 13));
    // Simula a inicialização independente de cada aba (sem acoplamento):
    // mudar a seleção de Análises deixa o default/modo de Início intacto.
    const anlMoved = periodReducer(anl, { type: 'selection_change', selection: { year: 2026, month: 7 } });
    expect(anlMoved.mode).toBe('full_month');
    expect(anlMoved.selection).toEqual({ year: 2026, month: 7 });
    expect(inicio.mode).toBe('up_to_today');
    expect(inicio.selection).toEqual(selectionFromDate(new Date(2026, 8, 13)));
  });

  it('mudança manual no seletor é preservada (não há reset a cada render/evolução)', () => {
    const txs = createPeriodState(PERIOD_DEFAULT_MODES.transacoes, new Date(2026, 8, 13));
    const changed = periodReducer(txs, { type: 'mode_change', mode: 'up_to_today' });
    // Ações seguintes (trocar mês, abrir picker) NÃO redefinem o modo.
    const afterNav = periodReducer(changed, { type: 'selection_change', selection: { year: 2026, month: 8 } });
    const afterPicker = periodReducer(afterNav, { type: 'picker_open' });
    expect(changed.mode).toBe('up_to_today');
    expect(afterNav.mode).toBe('up_to_today');
    expect(afterPicker.mode).toBe('up_to_today');
  });
});

describe('PESSOAL-12 — wiring da UI (AppShell) por contexto', () => {
  const src = readSource('components/AppShell.tsx');

  it('monta um controlador de período independente por aba com o default certo', () => {
    expect(src).toContain('usePeriodController(PERIOD_DEFAULT_MODES.inicio)');
    expect(src).toContain('usePeriodController(PERIOD_DEFAULT_MODES.transacoes)');
    expect(src).toContain('usePeriodController(PERIOD_DEFAULT_MODES.analises)');
  });

  it('cada view recebe o controlador do próprio contexto', () => {
    expect(src).toContain('period={homePeriod.controller}');
    expect(src).toContain('period={txPeriod.controller}');
    expect(src).toContain('period={analyticsPeriod.controller}');
  });

  it('o picker de período personalizado opera sobre o contexto ativo', () => {
    expect(src).toContain('activePeriod.pickerOpen');
    expect(src).toContain('activePeriod.closePicker');
    expect(src).toContain('activePeriod.controller.onCustomApply');
  });
});

describe('PESSOAL-12 — render (AppShell): defaults aplicados na tela', () => {
  const now = new Date();
  const current = selectionFromDate(now);
  const expectedUpToToday = computePeriodRange(current, 'up_to_today', now);
  const expectedFullMonth = computePeriodRange(current, 'full_month', now);

  it('Início abre com "Até hoje" ativo e range do dia 1 até hoje', () => {
    const html = renderToString(createElement(AppShell, { ...shellProps }));
    expect(html).toContain('aria-pressed="true">Até hoje');
    expect(html).toContain('aria-pressed="false">Mês todo');
    expect(html).toContain(formatShortDate(expectedUpToToday.start));
    expect(html).toContain(formatShortDate(expectedUpToToday.end));
  });

  it('Transações abre com "Mês todo" ativo e range do mês completo', () => {
    const html = renderToString(createElement(AppShell, { ...shellProps, initialView: 'transacoes' }));
    expect(html).toContain('aria-pressed="true">Mês todo');
    expect(html).toContain('aria-pressed="false">Até hoje');
    expect(html).toContain(formatShortDate(expectedFullMonth.start));
    expect(html).toContain(formatShortDate(expectedFullMonth.end));
  });

  it('Análises abre com "Mês todo" ativo e range do mês completo (01 → último dia)', () => {
    const html = renderToString(createElement(AppShell, { ...shellProps, initialView: 'analises' }));
    expect(html).toContain('aria-pressed="true">Mês todo');
    expect(html).toContain('aria-pressed="false">Até hoje');
    expect(html).toContain(formatShortDate(expectedFullMonth.start));
    expect(html).toContain(formatShortDate(expectedFullMonth.end));
    expect(html).not.toContain('somente leitura');
  });
});