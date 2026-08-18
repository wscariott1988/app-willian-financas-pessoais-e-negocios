import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppShell } from '../components/AppShell';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import { Dashboard } from '../components/Dashboard';
import { PeriodSelector } from '../components/PeriodSelector';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '..', 'index.css'), 'utf8');

function extractMediaBlock(cssSource: string, mediaQuery: string): string {
  // procura "@media (min-width: 1024px) {" com a chave — evita casar dentro de comentários
  const needle = `${mediaQuery} {`;
  const start = cssSource.indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = start + needle.length - 1;
  let depth = 0;
  for (let i = open; i < cssSource.length; i++) {
    if (cssSource[i] === '{') depth += 1;
    else if (cssSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return cssSource.slice(open + 1, i);
    }
  }
  throw new Error('bloco de media não fechado');
}

function ruleBlock(cssSource: string, selector: string): string | null {
  let idx = -1;
  for (;;) {
    idx = cssSource.indexOf(selector, idx + 1);
    if (idx === -1) return null;
    const before = idx === 0 ? ' ' : cssSource[idx - 1];
    if (!/[\s;})]/.test(before)) continue; // deve ser início de regra
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

const NOOP = () => {};

const period = {
  selection: { year: 2026, month: 8 },
  mode: 'up_to_today' as const,
  range: { start: '2026-08-01', end: '2026-08-12' },
  onSelectionChange: NOOP,
  onModeChange: NOOP,
};

const shellProps = {
  profileId: '11111111-1111-1111-1111-111111111111',
  profileCode: 'personal' as const,
  userEmail: 'usuario@exemplo.com',
  onProfileSwitch: NOOP,
  onLogout: NOOP,
  onProfileSwitchRequest: NOOP,
};

describe('breakpoints do sistema visual', () => {
  it('1) desktop inicia em 1024px (não 900px)', () => {
    expect(css).toContain('@media (min-width: 1024px)');
    expect(css).not.toContain('@media (min-width: 900px)');
  });

  it('2) sidebar e bottom nav são mutuamente exclusivas', () => {
    const baseSide = ruleBlock(css, '.side-nav');
    const baseBottom = ruleBlock(css, '.bottom-nav');
    expect(baseSide).toContain('display: none');
    expect(baseBottom).toContain('display: flex');

    const desktop = extractMediaBlock(css, '@media (min-width: 1024px)');
    const desktopSide = ruleBlock(desktop, '.side-nav');
    const desktopBottom = ruleBlock(desktop, '.bottom-nav');
    expect(desktopSide).toContain('display: flex');
    expect(desktopBottom).toContain('display: none');
  });

  it('3) safe area inferior é respeitada (conteúdo e navegação)', () => {
    const body = ruleBlock(css, '.app-body');
    const nav = ruleBlock(css, '.bottom-nav');
    const header = ruleBlock(css, '.app-header');
    expect(body).toContain('env(safe-area-inset-bottom)');
    expect(nav).toContain('env(safe-area-inset-bottom)');
    expect(header).toContain('env(safe-area-inset-top)');
  });

  it('3b) largura útil desktop limitada (≈1400px)', () => {
    const desktop = extractMediaBlock(css, '@media (min-width: 1024px)');
    expect(desktop).toContain('max-width: 1400px');
    const sidebar = ruleBlock(desktop, '.side-nav');
    expect(sidebar).toContain('width: 280px');
  });

  it('4) áreas de toque móveis com mínimo de 44px', () => {
    const root = ruleBlock(css, ':root');
    expect(root).toContain('--touch-min: 44px');
    const navItem = ruleBlock(css, '.bottom-nav-item');
    expect(navItem).toContain('var(--touch-min)');
    const modeBtn = ruleBlock(css, '.period-mode-btn');
    expect(modeBtn).toContain('var(--touch-min)');
    const pendingRow = ruleBlock(css, '.pending-row');
    expect(pendingRow).toContain('var(--touch-min)');
    const todayBtn = ruleBlock(css, '.period-today-btn');
    expect(todayBtn).toContain('var(--touch-min)');
  });

  it('datas não são renderizadas dentro de cada opção segmentada', () => {
    const html = renderToString(createElement(PeriodSelector, period));
    expect(html).not.toContain('period-mode-dates');
    // os três botões trazem somente os rótulos
    for (const label of ['Até hoje', 'Até o fim do mês', 'Mês todo']) {
      expect(html).toContain(label);
    }
    // nenhum intervalo “dd/mm – dd/mm” dentro dos botões (só rótulos)
    expect(html).not.toMatch(/\d{2}\/\d{2}\s*–\s*\d{2}\/\d{2}/);
  });

  it('existe um único intervalo aplicado no seletor', () => {
    const html = renderToString(createElement(PeriodSelector, period));
    // o intervalo efetivo aparece uma única vez (seta “→”)
    expect((html.match(/→/g) ?? []).length).toBe(1);
    expect(html).toContain('Período aplicado');
  });

  it('pendências: painel único com duas linhas acionáveis e aria-pressed', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).toContain('Pendências');
    expect(html).toContain('Em revisão');
    expect(html).toContain('Sem categoria');
    // exatamente duas linhas do painel, ambas com aria-pressed
    expect((html.match(/class="pending-row"/g) ?? []).length).toBe(2);
    expect((html.match(/class="pending-row" aria-pressed=/g) ?? []).length).toBe(2);
  });

  it('valor do Resultado possui regra de não quebra (nowrap + clamp)', () => {
    const baseResult = ruleBlock(css, '.stat-result .stat-card-value');
    const desktop = extractMediaBlock(css, '@media (min-width: 1024px)');
    const desktopResult = ruleBlock(desktop, '.stat-result .stat-card-value');
    for (const block of [baseResult, desktopResult]) {
      expect(block).toContain('white-space: nowrap');
    }
    expect(baseResult).toContain('clamp(');
  });

  it('círculos decorativos anteriores foram removidos do CSS', () => {
    expect(css).not.toContain('stat-card::before');
    expect(css).not.toContain('border-radius: 50%');
  });
});

describe('troca de perfil e perfil ativo (componentes reais)', () => {
  it('5) botão “Trocar perfil” está presente no cabeçalho e na sidebar', () => {
    const shellHtml = renderToString(createElement(AppShell, shellProps));
    expect(shellHtml).toContain('Trocar perfil');
    expect((shellHtml.match(/Trocar perfil/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('6) perfil ativo é apresentado como “Perfil Pessoal”/“Perfil Negócio”', () => {
    const personal = renderToString(
      createElement(ProfileSwitcher, { ...shellProps, currentProfileCode: 'personal', variant: 'header' }),
    );
    expect(personal).toContain('Perfil Pessoal');
    expect(personal).not.toContain('Perfil Negócio');

    const business = renderToString(
      createElement(ProfileSwitcher, { ...shellProps, currentProfileCode: 'business', variant: 'sidebar' }),
    );
    expect(business).toContain('Perfil Negócio');
    expect(business).not.toContain('Perfil Pessoal');
  });

  it('7) troca de perfil usa o fluxo signOutAndReturn (logout oficial + retorno ao login)', () => {
    const switcherSource = readFileSync(resolve(here, '..', 'components', 'ProfileSwitcher.tsx'), 'utf8');
    expect(switcherSource).toContain('signOutAndReturn');
    expect(switcherSource).toContain('onProfileSwitchRequest');
    expect(switcherSource).toContain('onLogout');
  });
});

describe('Início — informações reais e ausência de itens falsos', () => {
  it('9) Resultado do período nunca é chamado de “Saldo atual”', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).toContain('Resultado do período');
    expect(html).not.toContain('Saldo atual');
    expect(html).not.toContain('Saldo Previsto');
    expect(html).not.toContain('Próximos Vencimentos');
  });

  it('9b) resumo real presente: Receitas, Despesas, Em revisão, Sem categoria', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).toContain('Receitas');
    expect(html).toContain('Despesas');
    expect(html).toContain('Em revisão');
    expect(html).toContain('Sem categoria');
  });

  it('10) FAB de Nova transação está presente na Início', () => {
    const html = renderToString(createElement(AppShell, shellProps));
    // Dashboard agora inclui FAB + botão "Nova transação"
    expect(html).toContain('aria-label="Nova transação"');
  });
});

describe('composição desktop da Início (≥1024px / ≥1280px)', () => {
  const desktop = extractMediaBlock(css, '@media (min-width: 1024px)');
  const wide = extractMediaBlock(css, '@media (min-width: 1280px)');

  it('1) três indicadores financeiros em uma linha no desktop', () => {
    const summary = ruleBlock(desktop, '.summary-grid');
    expect(summary).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  });

  it('2) Resultado não ocupa largura total no desktop', () => {
    const result = ruleBlock(desktop, '.stat-result');
    expect(result).toContain('grid-column: auto');
  });

  it('3) barra de período possui composição horizontal em ≥1024px', () => {
    const period = ruleBlock(desktop, '.period-selector');
    expect(period).toContain('flex-direction: row');
    expect(period).toContain('flex-wrap: wrap');
    expect(period).toContain('border-radius: var(--radius-lg)');
  });

  it('4) área de trabalho possui duas colunas em ≥1280px', () => {
    const root = ruleBlock(wide, '.dash-root');
    expect(root).toContain('grid-template-columns: minmax(0, 2fr) 340px');
  });

  it('5) Pendências pertence à coluna lateral no desktop', () => {
    const root = ruleBlock(wide, '.dash-root');
    expect(root).toContain('main    pending');
    expect(root).toContain('main    side');
    const basePending = ruleBlock(css, '.pending-panel');
    expect(basePending).toContain('grid-area: pending');
  });

  it('6) composição mobile permanece ativa abaixo de 768px (fluxo vertical)', () => {
    const baseRoot = ruleBlock(css, '.dash-root');
    expect(baseRoot).not.toBeNull();
    expect(baseRoot).toContain('grid-template-columns: 1fr');
    const areas = baseRoot!.slice(baseRoot!.indexOf('grid-template-areas'));
    // ordem mobile aprovada: pendências antes da área operacional
    expect(areas.indexOf('pending')).toBeLessThan(areas.indexOf('main'));
    // nenhuma regra @media (max-width) redefine a composição para 2 colunas
    expect(css).not.toMatch(/@media\s*\(max-width:\s*768px\)/);
  });

  it('8) nenhum conteúdo interativo é duplicado (um único conjunto no DOM)', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    // lista, painel de pendências e FAB renderizados uma única vez
    expect((html.match(/tx-table/g) ?? []).length).toBe(1);
    expect((html.match(/pending-panel/g) ?? []).length).toBe(1);
    expect((html.match(/tx-fab/g) ?? []).length).toBe(1);
    expect((html.match(/Nova transação/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((html.match(/period-mode-btn/g) ?? []).length).toBe(3);
  });

  it('9) ausência de overflow horizontal declarada (html/body)', () => {
    expect(css).toMatch(/html,\s*body\s*\{\s*overflow-x:\s*hidden/);
  });
});
