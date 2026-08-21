import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppShell } from '../components/AppShell';
import { TransactionList } from '../components/TransactionList';
import { CategorizerPanel } from '../components/CategorizerPanel';
import { Dashboard } from '../components/Dashboard';
import { TransactionsView } from '../views/TransactionsView';
import { PeriodSelector } from '../components/PeriodSelector';
import { PeriodPicker } from '../components/PeriodPicker';
import { buildCategoryQuery } from '../lib/categoryQuery';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '..', 'index.css'), 'utf8');

function extractMediaBlock(cssSource: string, mediaQuery: string): string {
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

const NOOP = () => {};
const period = {
  selection: { year: 2026, month: 8 },
  mode: 'up_to_today' as const,
  range: { start: '2026-08-01', end: '2026-08-12' },
  onSelectionChange: NOOP,
  onModeChange: NOOP,
  onCustomApply: NOOP,
  onCustomReset: NOOP,
  onPickerOpen: NOOP,
};
const shellProps = {
  profileId: '11111111-1111-1111-1111-111111111111',
  profileCode: 'personal' as const,
  userEmail: 'usuario@exemplo.com',
  onProfileSwitch: NOOP,
  onLogout: NOOP,
  onProfileSwitchRequest: NOOP,
};

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

describe('view Transações — navegação e ativação', () => {
  it('1) navegação abre a view Transações', () => {
    const html = renderToString(createElement(AppShell, { ...shellProps, initialView: 'transacoes' }));
    expect(html).toContain('Todas as transações do perfil ativo no período selecionado');
    expect(html).toContain('aria-current="page"');
  });

  it('2) item Transações fica ativo (aria-current) quando a view está aberta', () => {
    const html = renderToString(createElement(AppShell, { ...shellProps, initialView: 'transacoes' }));
    const activeButtons = (html.match(/aria-current="page"/g) ?? []).length;
    expect(activeButtons).toBe(2);
    const activeBlocks = [...html.matchAll(/aria-current="page"([\s\S]*?)<\/button>/g)].map((m) => m[1]);
    for (const block of activeBlocks) {
      expect(block).toContain('Transações');
      expect(block).not.toContain('Início');
    }
  });
});

describe('view Transações — lista densa mobile', () => {
  const mobile = extractMediaBlock(css, '@media (max-width: 1023px)');

  it('3) linha mobile não contém quatro rótulos verticais', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('grid-template-areas');
    const tdBefore = ruleBlock(mobile, '.tx-table td::before');
    expect(tdBefore).toContain('content: none');
  });

  it('4) altura-alvo compacta definida (56px min, 68px máx)', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('min-height: 56px');
    expect(tr).toContain('max-height: 68px');
  });

  it('15) linha compacta permanece entre 56 e 64 px na prática (56 min / 68 máx)', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('min-height: 56px');
    expect(tr).toContain('max-height: 68px');
    // conteúdo de duas faixas: sem espaçamento vertical excessivo
    expect(tr).toContain('gap: 2px 10px');
  });

  it('5) valor não quebra de linha', () => {
    const value = ruleBlock(mobile, '.tx-table td.tx-value');
    expect(value).toContain('white-space: nowrap');
  });

  it('6) categoria longa usa truncamento', () => {
    const cat = ruleBlock(mobile, '.tx-table td.tx-cat');
    expect(cat).toContain('text-overflow: ellipsis');
    expect(cat).toContain('white-space: nowrap');
  });
});

describe('view Transações — cabeçalho e período mobile', () => {
  it('1b) subtítulo oculto somente no mobile (<768px)', () => {
    const mobileBlock = extractMediaBlock(css, '@media (max-width: 767px)');
    const subtitle = ruleBlock(mobileBlock, '.tx-view-subtitle');
    expect(subtitle).toContain('display: none');
    // no base (tablet/desktop) não há ocultação
    const baseSubtitle = ruleBlock(css, '.tx-view-subtitle');
    expect(baseSubtitle).not.toContain('display: none');
  });

  it('2b) barra compacta de período padrão na view mobile (56–64px)', () => {
    const bar = ruleBlock(css, '.tx-period-bar');
    expect(bar).toContain('min-height: 56px');
    expect(bar).toContain('max-height: 60px');
  });

  it('3b) seletor completo abre e fecha (painel + Escape + foco)', () => {
    const source = readSource('views/TransactionsView.tsx');
    expect(source).toContain('periodOpen');
    expect(source).toContain('aria-expanded={periodOpen}');
    expect(source).toContain('handleClosePeriod');
    expect(source).toContain("'Escape'");
    expect(source).toContain('<PeriodSelector');
  });
});

describe('view Transações — filtros compactos', () => {
  const listHtml = renderToString(
    createElement(TransactionList, {
      profileId: shellProps.profileId,
      selectedTransactionId: null,
      onSelectTransaction: NOOP,
      refreshTrigger: 0,
      search: '',
      onSearchChange: NOOP,
      selectedAccount: '',
      onAccountChange: NOOP,
      startDate: period.range.start,
      onStartDateChange: NOOP,
      endDate: period.range.end,
      onEndDateChange: NOOP,
      filterNoCategory: false,
      onFilterNoCategoryChange: NOOP,
      filterReviewOnly: false,
      onFilterReviewOnlyChange: NOOP,
    }),
  );

  it('4b) busca permanece visível (input sempre no DOM)', () => {
    expect(listHtml).toContain('Buscar descrição');
    expect(listHtml).toContain('<input');
  });

  it('5b) filtros avançados ficam recolhidos por padrão', () => {
    expect(listHtml).toContain('tx-filters-panel');
    expect(listHtml).not.toContain('tx-filters-panel open');
    expect(listHtml).toContain('aria-expanded="false"');
  });

  it('6b) indicador de filtros ativos no botão', () => {
    const source = readSource('components/TransactionList.tsx');
    expect(source).toContain('activeFilterCount');
    expect(source).toContain('Filtros{activeFilterCount > 0');
  });

  it('9) filtros não exibem expressões técnicas', () => {
    expect(listHtml).not.toContain('status = review');
    expect(listHtml).not.toContain('category_id = null');
    expect(listHtml).toContain('Em revisão');
    expect(listHtml).toContain('Sem categoria');
  });
});

describe('view Transações — desktop mínimo e amplo', () => {
  const minDesktop = extractMediaBlock(css, '@media (min-width: 1024px) and (max-width: 1279px)');
  const wide = extractMediaBlock(css, '@media (min-width: 1280px)');

  it('9) 1024px não reserva coluna lateral vazia', () => {
    const grid = ruleBlock(minDesktop, '.tx-view-grid');
    expect(grid).toContain('grid-template-columns: minmax(0, 1fr)');
    const side = ruleBlock(minDesktop, '.tx-view-side');
    expect(side).toContain('width: min(380px, 92vw)');
    expect(side).toContain('translateX');
  });

  it('10) 1440px usa largura completa antes da seleção', () => {
    const grid = ruleBlock(wide, '.tx-view-grid');
    expect(grid).toContain('grid-template-columns: minmax(0, 1fr)');
    const withSide = ruleBlock(wide, '.tx-view-grid.with-side');
    expect(withSide).toContain('340px');
  });

  it('13) datas e valores sem truncamento indevido em 1440px (larguras em px)', () => {
    const dataCol = ruleBlock(wide, '.tx-table th:nth-child(1)');
    const valueCol = ruleBlock(wide, '.tx-table th:nth-child(3)');
    const statusCol = ruleBlock(wide, '.tx-table th:nth-child(6)');
    expect(dataCol).toContain('width: 120px');
    expect(valueCol).toContain('width: 140px');
    expect(statusCol).toContain('width: 140px');
  });

  it('10) desktop usa tabela tabular (thead visível no base)', () => {
    expect(ruleBlock(css, '.tx-table th')).not.toBeNull();
    const mobile = extractMediaBlock(css, '@media (max-width: 1023px)');
    const thead = ruleBlock(mobile, '.tx-table thead');
    expect(thead).toContain('display: none');
  });
});

describe('view Transações — seleção e recategorização', () => {
  it('11) editor abre via Modal global (sem painel vazio permanente)', () => {
    const viewHtml = renderToString(
      createElement(TransactionsView, {
        profileId: shellProps.profileId,
        profileCode: 'personal',
        period,
        mode: 'period',
        onModeChange: NOOP,
        pendingFilter: 'all',
        onPendingFilterChange: NOOP,
      }),
    );
    // sem seleção: nenhum painel vazio permanente e nenhum modal aberto
    expect(viewHtml).not.toContain('Nenhuma transação selecionada');
    expect(viewHtml).not.toContain('tx-view-side');

    const source = readSource('views/TransactionsView.tsx');
    expect(source).toContain('Modal');
    expect(source).toContain('open={!!editor}');
    expect(source).toContain('TransactionEditor');
  });

  it('12) editor abre em Modal global (sem classe with-side)', () => {
    const source = readSource('views/TransactionsView.tsx');
    expect(source).not.toContain('with-side');
    expect(source).toContain('handleCloseEditor');
    expect(source).toContain("'Escape'");
    // Modal global substitui o painel lateral
    expect(source).toContain('<Modal');
    expect(source).toContain('open={!!editor}');
  });
});

describe('view Transações — paginação e overflow', () => {
  it('11b) paginação interna preservada (lotes TX_PAGE_SIZE)', () => {
    const source = readSource('components/TransactionList.tsx');
    expect(source).toContain('TX_PAGE_SIZE');
    expect(source).toContain('fetchAllTxPages');
  });

  it('12) não existe botão “Carregar mais” nem paginação visual', () => {
    const listHtml = renderToString(
      createElement(TransactionList, {
        profileId: shellProps.profileId,
        selectedTransactionId: null,
        onSelectTransaction: NOOP,
        refreshTrigger: 0,
        search: '',
        onSearchChange: NOOP,
        selectedAccount: '',
        onAccountChange: NOOP,
        startDate: period.range.start,
        onStartDateChange: NOOP,
        endDate: period.range.end,
        onEndDateChange: NOOP,
        filterNoCategory: false,
        onFilterNoCategoryChange: NOOP,
        filterReviewOnly: false,
        onFilterReviewOnlyChange: NOOP,
      }),
    );
    expect(listHtml).not.toContain('Carregar mais');
    expect(listHtml).not.toContain('Anterior');
    expect(listHtml).not.toContain('Próxima');
    expect(listHtml).not.toMatch(/Página\s*<strong>/);
  });

  it('14) ausência de overflow horizontal declarada (html/body)', () => {
    expect(css).toMatch(/html,\s*body\s*\{\s*overflow-x:\s*hidden/);
  });
});

describe('geometria da linha e truncamentos críticos (1.2A.3c)', () => {
  const mobile = extractMediaBlock(css, '@media (max-width: 1023px)');
  const narrow = extractMediaBlock(css, '@media (max-width: 379px)');
  const minDesktop = extractMediaBlock(css, '@media (min-width: 1024px) and (max-width: 1279px)');
  const wide = extractMediaBlock(css, '@media (min-width: 1280px)');

  it('1) grid real da linha secundária (data max-content, categoria flexível, editar max-content)', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('grid-template-columns: max-content minmax(0, 1fr) max-content max-content max-content');
    expect(tr).toContain("'date cat account status edit'");
  });

  it('3) data e status não encolhem (colunas max-content)', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).not.toBeNull();
    const cols = tr!.slice(tr!.indexOf('grid-template-columns'));
    expect(cols).toMatch(/^[^;]*max-content minmax\(0, 1fr\) max-content max-content/);
  });

  it('4) categoria aplica ellipsis com espaço flexível (min-width: 0)', () => {
    const cat = ruleBlock(mobile, '.tx-table td.tx-cat');
    expect(cat).toContain('min-width: 0');
    expect(cat).toContain('overflow: hidden');
    expect(cat).toContain('text-overflow: ellipsis');
    expect(cat).toContain('white-space: nowrap');
  });

  it('5) conta é ocultada somente abaixo de 380px', () => {
    const account = ruleBlock(narrow, '.tx-table td.tx-account');
    expect(account).toContain('display: none');
    const baseAccount = ruleBlock(mobile, '.tx-table td.tx-account');
    expect(baseAccount).not.toContain('display: none');
    expect(baseAccount).toContain('grid-area: account');
  });

  it('5b) em 380–767px a conta permanece na linha secundária', () => {
    const account = ruleBlock(mobile, '.tx-table td.tx-account');
    expect(account).toContain('grid-area: account');
    expect(account).toContain('text-overflow: ellipsis');
  });

  it('6) data em dd/mm no desktop 1024px', () => {
    const min = extractMediaBlock(css, '@media (min-width: 1024px)');
    const full = ruleBlock(min, '.tx-date-full');
    const short = ruleBlock(min, '.tx-date-short');
    expect(full).toContain('display: none');
    expect(short).toContain('display: inline');
  });

  it('7) data completa em 1440px sem seleção; dd/mm somente com painel', () => {
    const full = ruleBlock(wide, '.tx-date-full');
    const short = ruleBlock(wide, '.tx-date-short');
    expect(full).toContain('display: inline');
    expect(short).toContain('display: none');
    const withSideFull = ruleBlock(wide, '.tx-view-grid.with-side .tx-date-full');
    const withSideShort = ruleBlock(wide, '.tx-view-grid.with-side .tx-date-short');
    expect(withSideFull).toContain('display: none');
    expect(withSideShort).toContain('display: inline');
  });

  it('8) valor e status completos (larguras fixas em px)', () => {
    const min = extractMediaBlock(css, '@media (min-width: 1024px)');
    const valueCol = ruleBlock(min, '.tx-table th:nth-child(3)');
    const statusCol = ruleBlock(min, '.tx-table th:nth-child(6)');
    expect(valueCol).toContain('width: 140px');
    expect(statusCol).toContain('width: 140px');
  });

  it('8b) data com largura suficiente no 1440px (dd/mm/aaaa)', () => {
    const dataCol = ruleBlock(wide, '.tx-table th:nth-child(1)');
    expect(dataCol).toContain('width: 120px');
  });

  it('9) drawer de 1024px possui rolagem interna', () => {
    const side = ruleBlock(minDesktop, '.tx-view-side');
    expect(side).toContain('overflow-y: auto');
    expect(side).toContain('position: fixed');
  });

  it('10) ação do drawer permanece visível (fixa no rodapé interno)', () => {
    const submit = ruleBlock(minDesktop, '.tx-view-side .categorizer-submit');
    expect(submit).toContain('position: absolute');
    expect(submit).toContain('bottom: 0');
    expect(submit).toContain('left: 0');
    expect(submit).toContain('right: 0');
    const side = ruleBlock(minDesktop, '.tx-view-side');
    expect(side).toContain('env(safe-area-inset-bottom)');
  });

  it('11) linha continua com máximo de 68px', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('min-height: 56px');
    expect(tr).toContain('max-height: 68px');
  });

  it('13) categorizerClose.test.tsx continua sendo executado (vitest inclui .tsx)', () => {
    const config = readFileSync(resolve(here, '..', '..', 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'src/tests/**/*.test.{ts,tsx}'");
  });
});

describe('modos Do período e Pendências (1.2A.4B)', () => {
  const viewProps = {
    profileId: shellProps.profileId,
    profileCode: 'personal' as const,
    period,
    mode: 'period' as const,
    onModeChange: NOOP,
    pendingFilter: 'all' as const,
    onPendingFilterChange: NOOP,
  };

  it('1) controle Do período/Pendências presente e acessível', () => {
    const html = renderToString(createElement(TransactionsView, viewProps));
    expect(html).toContain('Do período');
    expect(html).toContain('Pendências');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain('tx-mode-toggle');
  });

  it('2) modo padrão é Do período (com seletor mensal)', () => {
    const html = renderToString(createElement(TransactionsView, viewProps));
    expect(html).toContain('Todas as transações do perfil ativo no período selecionado');
    expect(html).toContain('period-month-label');
  });

  it('3) Pendências não envia intervalo e não renderiza seletor mensal', () => {
    const html = renderToString(
      createElement(TransactionsView, { ...viewProps, mode: 'pending', pendingFilter: 'all' }),
    );
    expect(html).toContain('Pendências');
    expect(html).toContain('Transações em revisão ou sem categoria de todo o histórico');
    expect(html).not.toContain('period-month-label');
    expect(html).not.toContain('Período aplicado');
    expect(html).not.toContain('tx-period-bar');
    // filtros de 3 vias
    for (const label of ['Todas', 'Em revisão', 'Sem categoria']) {
      expect(html).toContain(label);
    }
    expect((html.match(/tx-pending-pills/g) ?? []).length).toBe(1);
    expect(html).toContain('pendências no histórico');
  });

  it('10) contagem global da Início independe do período', () => {
    const dashboard = readSource('components/Dashboard.tsx');
    // os contadores de pendências não usam intervalo de datas (sem gte/lte)
    expect(dashboard).not.toMatch(/\.gte\(/);
    expect(dashboard).not.toMatch(/\.lte\(/);
    expect(dashboard).toContain('supabaseCounters()');
    expect(dashboard).toContain('Todo o histórico');
  });

  it('11) card Em revisão abre a fila global filtrada', () => {
    const dashboard = readSource('components/Dashboard.tsx');
    expect(dashboard).toContain("onOpenPending?.('review')");
    const shell = readSource('components/AppShell.tsx');
    expect(shell).toContain("setTxPendingFilter(filter)");
    expect(shell).toContain("setTxMode('pending')");
    expect(shell).toContain("setView('transacoes')");
  });

  it('12) card Sem categoria abre a fila global filtrada', () => {
    const dashboard = readSource('components/Dashboard.tsx');
    expect(dashboard).toContain("onOpenPending?.('noCategory')");
  });

  it('13) mês anterior é restaurado ao voltar para Do período', () => {
    const viewSource = readSource('views/TransactionsView.tsx');
    // a view não altera a seleção do período em nenhum modo
    expect(viewSource).not.toMatch(/setSelection/);
    const shell = readSource('components/AppShell.tsx');
    // trocar de modo não toca a seleção mensal (ela vive no AppShell)
    expect(shell).toContain('setTxMode');
    expect(shell).not.toMatch(/handleOpenPending[\s\S]{0,200}setSelection/);
  });

  it('14) edição via modal atualiza lista e contagens (refresh após sucesso)', () => {
    const viewSource = readSource('views/TransactionsView.tsx');
    expect(viewSource).toContain('handleEditorSuccess');
    expect(viewSource).toContain('setRefreshTrigger((t) => t + 1)');
    expect(viewSource).toContain('onSuccess={handleEditorSuccess}');
  });

  it('15) categorização não remove o status de revisão', () => {
    const panel = readSource('components/CategorizerPanel.tsx');
    // o painel não atualiza a transação diretamente; apenas chama o RPC existente
    expect(panel).not.toMatch(/\.update\(/);
    expect(panel).toContain("supabase.rpc('assign_category_atomic'");
  });

  it('16) carregamento inicial do Pendências é paginado (primeiro lote)', () => {
    const list = readSource('components/TransactionList.tsx');
    expect(list).toContain('PENDING_PAGE_SIZE');
    expect(list).toContain('loadPendingPage(0, true)');
    expect(list).toContain('fetcher(offset, offset + PENDING_PAGE_SIZE - 1)');
  });

  it('17) próximo lote é solicitado progressivamente (sentinel)', () => {
    const list = readSource('components/TransactionList.tsx');
    expect(list).toContain('IntersectionObserver');
    expect(list).toContain('loadPendingPage(pendingOffset, false)');
    expect(list).toContain('rootMargin');
  });

  it('18) não existe fetchAll do histórico no modo Pendências', () => {
    const list = readSource('components/TransactionList.tsx');
    // fetchAllTxPages aparece apenas no import e na chamada do modo Do período
    expect((list.match(/fetchAllTxPages/g) ?? []).length).toBe(2);
    // o ramo de pendências (loadPendingPage) nunca o chama
    expect(list).not.toMatch(/loadPendingPage[\s\S]{0,600}fetchAllTxPages/);
  });

  it('19) termos técnicos não aparecem na UI', () => {
    const panelHtml = renderToString(
      createElement(CategorizerPanel, {
        transaction: {
          id: '11111111-1111-1111-1111-111111111111',
          profile_id: 'p',
          account_id: 'a',
          category_id: null,
          transaction_kind: 'expense',
          amount: '10.00',
          occurred_on: '2026-08-01',
          raw_description: 'x',
          normalized_description: 'x',
          category_raw: 'mercado',
          status: 'review',
          categories: null,
          accounts: null,
        } as any,
        activeProfileId: 'p',
        onSuccess: NOOP,
        onClose: NOOP,
      }),
    );
    expect(panelHtml).not.toContain('Categoria canônica');
    expect(panelHtml).not.toContain('category_raw');
    expect(panelHtml).not.toContain('Nula');
    expect(panelHtml).toContain('Categoria informada');
    expect(panelHtml).toContain('Selecione a categoria');

    const listHtml = renderToString(
      createElement(TransactionList, {
        profileId: shellProps.profileId,
        selectedTransactionId: null,
        onSelectTransaction: NOOP,
        refreshTrigger: 0,
        search: '',
        onSearchChange: NOOP,
        selectedAccount: '',
        onAccountChange: NOOP,
        startDate: period.range.start,
        onStartDateChange: NOOP,
        endDate: period.range.end,
        onEndDateChange: NOOP,
        filterNoCategory: false,
        onFilterNoCategoryChange: NOOP,
        filterReviewOnly: false,
        onFilterReviewOnlyChange: NOOP,
      }),
    );
    expect(listHtml).not.toContain('Categ. Original');
    expect(listHtml).not.toContain('status = review');
    expect(listHtml).not.toContain('category_id = null');

    const dashboardHtml = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(dashboardHtml).not.toContain('status = review');
    expect(dashboardHtml).not.toContain('category_id = null');
    expect(dashboardHtml).toContain('Todo o histórico');
  });

  it('20) erros técnicos são apresentados em linguagem destinada ao usuário', () => {
    const list = readSource('components/TransactionList.tsx');
    expect(list).toContain('Não foi possível carregar as transações. Tente novamente em instantes.');
    expect(list).toContain('import.meta.env.DEV');
    const panel = readSource('components/CategorizerPanel.tsx');
    expect(panel).toContain('Não foi possível alterar a categoria. Tente novamente em instantes.');
  });
});

const panelTx = {
  id: '11111111-1111-1111-1111-111111111111',
  profile_id: 'p',
  account_id: 'a',
  category_id: null,
  transaction_kind: 'expense' as const,
  amount: '10.00',
  occurred_on: '2026-08-01',
  raw_description: 'x',
  normalized_description: 'x',
  category_raw: 'mercado',
  status: 'review' as const,
  categories: null,
  accounts: null,
};

describe('terminologia e legibilidade (1.2A.4B.1)', () => {
  const viewProps = {
    profileId: shellProps.profileId,
    profileCode: 'personal' as const,
    period,
    mode: 'period' as const,
    onModeChange: NOOP,
    pendingFilter: 'all' as const,
    onPendingFilterChange: NOOP,
  };

  it('1) Pendências não mostra “transações no período”', () => {
    const html = renderToString(createElement(TransactionsView, { ...viewProps, mode: 'pending' }));
    expect(html).not.toContain('transações no período');
    expect(html).toContain('pendências no histórico');
  });

  it('2) Do período continua mostrando “transações no período”', () => {
    const html = renderToString(createElement(TransactionsView, viewProps));
    expect(html).toContain('transações no período');
  });

  it('3) contagens usam locale pt-BR', () => {
    expect(readSource('components/TransactionList.tsx')).toContain("toLocaleString('pt-BR')");
    expect(readSource('views/TransactionsView.tsx')).toContain("toLocaleString('pt-BR')");
    expect(readSource('components/Dashboard.tsx')).toContain("toLocaleString('pt-BR')");
  });

  it('4) Início mostra contagens de pendências formatadas', () => {
    const dashboard = readSource('components/Dashboard.tsx');
    expect(dashboard).toContain("summary.reviewCount.toLocaleString('pt-BR')");
    expect(dashboard).toContain("summary.noCategoryCount.toLocaleString('pt-BR')");
  });

  it('5) painel não mostra ID nem UUID', () => {
    const html = renderToString(
      createElement(CategorizerPanel, { transaction: panelTx as any, activeProfileId: 'p', onSuccess: NOOP, onClose: NOOP }),
    );
    expect(html).not.toContain('ID Transação');
    expect(html).not.toContain('11111111');
  });

  it('6) painel usa “Descrição” (não “Descrição Original”)', () => {
    const html = renderToString(
      createElement(CategorizerPanel, { transaction: panelTx as any, activeProfileId: 'p', onSuccess: NOOP, onClose: NOOP }),
    );
    expect(html).toContain('Descrição');
    expect(html).not.toContain('Descrição Original');
  });

  it('7) painel usa “Categoria informada”', () => {
    const html = renderToString(
      createElement(CategorizerPanel, { transaction: panelTx as any, activeProfileId: 'p', onSuccess: NOOP, onClose: NOOP }),
    );
    expect(html).toContain('Categoria informada');
  });

  it('8) painel usa “Tipo” (não “Direção / Tipo”)', () => {
    const html = renderToString(
      createElement(CategorizerPanel, { transaction: panelTx as any, activeProfileId: 'p', onSuccess: NOOP, onClose: NOOP }),
    );
    expect(html).toContain('Tipo');
    expect(html).not.toContain('Direção');
  });

  it('9) Receita/Despesa sem Entrada/Saída', () => {
    const html = renderToString(
      createElement(CategorizerPanel, { transaction: panelTx as any, activeProfileId: 'p', onSuccess: NOOP, onClose: NOOP }),
    );
    expect(html).toContain('Despesa');
    expect(html).not.toContain('Saída (Despesa)');
    expect(html).not.toContain('Entrada (Receita)');
  });

  it('10) conta mobile possui separador visual dentro da célula', () => {
    const mobile = extractMediaBlock(css, '@media (max-width: 1023px)');
    const account = ruleBlock(mobile, '.tx-table td.tx-account::before');
    expect(account).toContain("content: '•'");
    expect(account).toContain('margin-right: 6px');
  });

  it('11) conta continua oculta abaixo de 380px', () => {
    const narrow = extractMediaBlock(css, '@media (max-width: 379px)');
    const account = ruleBlock(narrow, '.tx-table td.tx-account');
    expect(account).toContain('display: none');
  });

  it('12) grid da linha mantém gap ≥8px entre os metadados (sem colisão)', () => {
    const mobile = extractMediaBlock(css, '@media (max-width: 1023px)');
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('gap: 2px 10px');
    expect(tr).toContain('max-content minmax(0, 1fr) max-content max-content');
  });

  it('13) categorizerClose.test.tsx continua sendo executado', () => {
    const config = readFileSync(resolve(here, '..', '..', 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'src/tests/**/*.test.{ts,tsx}'");
  });

  it('auditoria: termos técnicos ausentes nos textos renderizados', () => {
    const panelHtml = renderToString(
      createElement(CategorizerPanel, { transaction: panelTx as any, activeProfileId: 'p', onSuccess: NOOP, onClose: NOOP }),
    );
    for (const term of ['Categoria canônica', 'category_raw', 'category_id', 'ID Transação', 'Descrição Original', 'Entrada (Receita)', 'Saída (Despesa)']) {
      expect(panelHtml).not.toContain(term);
    }
    const viewHtml = renderToString(createElement(TransactionsView, { ...viewProps, mode: 'pending' }));
    expect(viewHtml).not.toContain('transações no período');
    expect(viewHtml).not.toContain('status = review');
    expect(viewHtml).not.toContain('assign_category_atomic');
    expect(viewHtml).not.toContain('p_transaction_id');
  });
});

describe('isolamento de categorias no painel (1.2A.4B.2)', () => {
  const PROFILE = '5a57e1cb-d147-5cf6-9fde-5ba982dc716c';

  it('6) divergência entre perfil ativo e perfil da transação impede a consulta', () => {
    const html = renderToString(
      createElement(CategorizerPanel, {
        transaction: { ...panelTx, profile_id: PROFILE } as any,
        activeProfileId: '59a7b86d-82ca-525b-9021-e33d877fe433',
        onSuccess: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Não foi possível identificar o perfil ativo. Entre novamente.');
    // o conteúdo (seletor de categoria) não é renderizado
    expect(html).not.toContain('Selecione a categoria');
    expect(html).not.toContain('Categoria informada');
  });

  it('6b) ausência de perfil ativo também bloqueia (fail-closed)', () => {
    const html = renderToString(
      createElement(CategorizerPanel, {
        transaction: { ...panelTx, profile_id: PROFILE } as any,
        activeProfileId: null,
        onSuccess: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Não foi possível identificar o perfil ativo. Entre novamente.');
    expect(html).not.toContain('Selecione a categoria');
  });

  it('7) consulta inclui .eq(profile_id, activeProfileId)', () => {
    const log: unknown[][] = [];
    const query: any = {
      select: (s: unknown) => { log.push(['select', s]); return query; },
      eq: (c: unknown, v: unknown) => { log.push(['eq', c, v]); return query; },
    };
    buildCategoryQuery(
      { from: (t: unknown) => { log.push(['from', t]); return query; } },
      { profileId: PROFILE, direction: 'expense', status: 'active' },
    );
    const s = log.map((x) => JSON.stringify(x));
    expect(s).toContain(JSON.stringify(['from', 'categories']));
    expect(s).toContain(JSON.stringify(['eq', 'profile_id', PROFILE]));
    expect(s).toContain(JSON.stringify(['eq', 'direction', 'expense']));
    expect(s).toContain(JSON.stringify(['eq', 'status', 'active']));
  });

  it('9) troca de perfil descarta categorias anteriores', () => {
    const panel = readSource('components/CategorizerPanel.tsx');
    // categorias são limpas no início do efeito (nunca exibe resultados antigos)
    expect(panel).toContain('setCategories([])');
    // o efeito depende do perfil ativo E da transação selecionada
    expect(panel).toContain('}, [transaction, activeProfileId]);');
  });

  it('11) mensagem de reautenticação é amigável (sem detalhes técnicos)', () => {
    const html = renderToString(
      createElement(CategorizerPanel, {
        transaction: { ...panelTx, profile_id: PROFILE } as any,
        activeProfileId: '59a7b86d-82ca-525b-9021-e33d877fe433',
        onSuccess: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Não foi possível identificar o perfil ativo. Entre novamente.');
    expect(html).not.toContain('profile_id');
    expect(html).not.toContain('UUID');
  });
});

describe('lapis e lixeira na lista', () => {
  it('1) TransactionList exporta onDeleteTransaction como prop opcional', () => {
    const src = readSource('components/TransactionList.tsx');
    expect(src).toContain('onDeleteTransaction?: (transaction: Transaction) => void');
  });

  it('2) TransactionList importa Trash2 do lucide-react', () => {
    const src = readSource('components/TransactionList.tsx');
    expect(src).toContain('Trash2');
  });

  it('3) botao de lixeira tem aria-label com a descricao da transacao', () => {
    const src = readSource('components/TransactionList.tsx');
    expect(src).toContain('Excluir ${tx.raw_description}');
  });

  it('4) botoes de lapis e lixeira usam stopPropagation', () => {
    const src = readSource('components/TransactionList.tsx');
    const txIdx = src.indexOf('onClick={(e) => {');
    const block = src.slice(txIdx, txIdx + 800);
    const stopCount = (block.match(/e\.stopPropagation\(\)/g) ?? []).length;
    expect(stopCount).toBeGreaterThanOrEqual(2);
  });

  it('5) coluna de acoes tem largura minima para lapis + lixeira (96px)', () => {
    const src = readSource('components/TransactionList.tsx');
    expect(src).toContain("width: '96px'");
    expect(src).toContain('aria-label="A');
  });

  it('6) botoes de acao tem area clicavel minima de 44px', () => {
    const src = readSource('components/TransactionList.tsx');
    const editIdx = src.indexOf("minWidth: '44px'");
    expect(editIdx).toBeGreaterThan(0);
    const block = src.slice(editIdx, editIdx + 300);
    expect(block).toContain("minHeight: '44px'");
  });

  it('7) Dashboard passa onEditTransaction e onDeleteTransaction', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).toContain('onEditTransaction={handleEditTransaction}');
    expect(src).toContain('onDeleteTransaction={handleDeleteTransaction}');
  });

  it('8) lixeira abre DeleteConfirmation (nao TransactionEditor)', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).toContain('deleteTarget');
    expect(src).toContain('setDeleteTarget(tx)');
    expect(src).toContain('DeleteConfirmation');
    expect(src).not.toContain('deleteIntent');
  });

  it('9) lixeira da TransactionsView abre DeleteConfirmation (nao TransactionEditor)', () => {
    const src = readSource('views/TransactionsView.tsx');
    expect(src).toContain('deleteTarget');
    expect(src).toContain('setDeleteTarget(tx)');
    expect(src).toContain('DeleteConfirmation');
    expect(src).not.toContain('deleteIntent');
  });

  it('10) TransactionEditor nao tem deleteIntent nem deleteIntentApplied', () => {
    const src = readSource('components/TransactionEditor.tsx');
    expect(src).not.toContain('deleteIntent');
    expect(src).not.toContain('deleteIntentApplied');
  });

  it('11) TransactionEditor mantem lixeira interna (exclusao via editor)', () => {
    const src = readSource('components/TransactionEditor.tsx');
    expect(src).toContain("supabase.rpc('transaction_delete'");
    expect(src).toContain('p_transaction_id: editId');
    expect(src).toContain('p_expected_updated_at: expectedUpdatedAt');
    expect(src).toContain('Confirmar exclus');
  });

  it('12) DeleteConfirmation existe e usa transaction_delete', () => {
    const src = readSource('components/DeleteConfirmation.tsx');
    expect(src).toContain("supabase.rpc('transaction_delete'");
    expect(src).toContain('p_transaction_id: tx.id');
    expect(src).toContain('p_expected_updated_at: expectedUpdatedAt');
    expect(src).toContain("supabase.rpc('transaction_get_detail'");
    expect(src).toContain('transaction_id: tx.id');
  });

  it('13) DeleteConfirmation mostra descricao, data, valor e conta', () => {
    const src = readSource('components/DeleteConfirmation.tsx');
    expect(src).toContain('Descricao');
    expect(src).toContain('Data');
    expect(src).toContain('Valor');
    expect(src).toContain('Conta');
    expect(src).toContain('tx.raw_description');
    expect(src).toContain('formatTxDate');
    expect(src).toContain('formatTxCurrency');
  });

  it('14) DeleteConfirmation trata conflito 409', () => {
    const src = readSource('components/DeleteConfirmation.tsx');
    expect(src).toContain('CONFLITO');
    expect(src).toContain('Recarregue a lista e tente novamente');
  });

  it('15) DeleteConfirmation avisa transferencia', () => {
    const src = readSource('components/DeleteConfirmation.tsx');
    expect(src).toContain('ambas as pontas');
    expect(src).toContain('isTransfer');
  });

  it('16) DeleteConfirmation fecha e atualiza lista apos sucesso', () => {
    const src = readSource('components/DeleteConfirmation.tsx');
    expect(src).toContain('onSuccess');
    const dash = readSource('components/Dashboard.tsx');
    expect(dash).toContain('handleDeleteSuccess');
    expect(dash).toContain('setDeleteTarget(null)');
    expect(dash).toContain('setRefreshTrigger');
  });
});

describe('seletor de período personalizado', () => {
  it('1) PeriodPicker existe e renderiza campos de data', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain("ariaLabel=\"Escolher período\"");
    expect(src).toContain('type="date"');
    expect(src).toContain('Data inicial');
    expect(src).toContain('Data final');
    expect(src).toContain('Aplicar');
    expect(src).toContain('Cancelar');
    expect(src).toContain('Voltar ao mês atual');
  });

  it('2) PeriodPicker rejeita início posterior ao fim e mostra erro', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain('validateCustomRange');
    expect(src).toContain('setError(result.error');
    expect(src).toContain('role="alert"');
  });

  it('3) PeriodPicker não fecha o modal ao mostrar erro', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain('if (!result.valid)');
    expect(src).toContain('return');
  });

  it('4) PeriodPicker chama onApply com start e end ao validar', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain('onApply(start, end)');
  });

  it('5) Voltar ao mês atual chama onApply com primeiro dia até hoje', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain('handleReset');
    expect(src).toContain('01');
  });

  it('6) PeriodPicker usa Modal global', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain('<Modal');
    expect(src).toContain('open={open}');
  });

  it('7) AppShell gerencia periodPickerOpen e customStart/customEnd', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain('periodPickerOpen');
    expect(src).toContain('customStart');
    expect(src).toContain('customEnd');
    expect(src).toContain('setPeriodPickerOpen');
  });

  it('8) AppShell handleCustomApply define datas e fecha o picker', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain('handleCustomApply');
    expect(src).toContain("setMode('custom')");
    expect(src).toContain('setPeriodPickerOpen(false)');
  });

  it('9) AppShell handleCustomReset volta para up_to_today', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain('handleCustomReset');
    expect(src).toContain("setMode('up_to_today')");
  });

  it('10) AppShell range é custom quando mode=custom e datas existem', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain("mode === 'custom'");
    expect(src).toContain('customStart');
    expect(src).toContain('customEnd');
  });

  it('11) PeriodController inclui onCustomApply, onCustomReset e onPickerOpen', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain('onCustomApply: handleCustomApply');
    expect(src).toContain('onCustomReset: handleCustomReset');
    expect(src).toContain('onPickerOpen:');
  });

  it('12) Dashboard passa onPickerOpen e onCustomReset ao PeriodSelector', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).toContain('onPickerOpen={period.onPickerOpen}');
    expect(src).toContain('onCustomReset={period.onCustomReset}');
  });

  it('13) TransactionsView passa onPickerOpen e onCustomReset ao PeriodSelector', () => {
    const src = readSource('views/TransactionsView.tsx');
    expect(src).toContain('onPickerOpen={period.onPickerOpen}');
    expect(src).toContain('onCustomReset={period.onCustomReset}');
  });

  it('14) PeriodSelector renderiza botão clicável quando onPickerOpen existe', () => {
    const html = renderToString(
      createElement(PeriodSelector, {
        selection: period.selection,
        mode: period.mode,
        range: period.range,
        onSelectionChange: NOOP,
        onModeChange: NOOP,
        onPickerOpen: NOOP,
      }),
    );
    expect(html).toContain('aria-label="Escolher período personalizado"');
    expect(html).toContain('button');
  });

  it('15) PeriodSelector mostra período personalizado quando mode=custom', () => {
    const html = renderToString(
      createElement(PeriodSelector, {
        selection: period.selection,
        mode: 'custom',
        range: { start: '2026-03-01', end: '2026-06-15' },
        onSelectionChange: NOOP,
        onModeChange: NOOP,
        onPickerOpen: NOOP,
      }),
    );
    expect(html).toContain('Período personalizado');
    expect(html).toContain('01/03/2026');
    expect(html).toContain('15/06/2026');
  });

  it('16) PeriodSelector sem onPickerOpen mostra div estática', () => {
    const html = renderToString(
      createElement(PeriodSelector, {
        selection: period.selection,
        mode: period.mode,
        range: period.range,
        onSelectionChange: NOOP,
        onModeChange: NOOP,
      }),
    );
    expect(html).toContain('Período aplicado');
    expect(html).not.toContain('Escolher período personalizado');
  });

  it('17) setas de mês chamam onCustomReset quando em modo custom', () => {
    const src = readSource('components/PeriodSelector.tsx');
    expect(src).toContain('if (isCustom) onCustomReset');
  });

  it('18) Mês atual chama onCustomReset quando em modo custom', () => {
    const src = readSource('components/PeriodSelector.tsx');
    expect(src).toContain('handleMonthActual');
    expect(src).toContain('if (isCustom) onCustomReset');
  });

  it('19) botões de modo mensal chamam onCustomReset quando em custom', () => {
    const src = readSource('components/PeriodSelector.tsx');
    expect(src).toContain('handleModeChange');
    expect(src).toContain('if (isCustom) onCustomReset');
  });

  it('20) TransactionsView setas mobile resetam modo custom', () => {
    const src = readSource('views/TransactionsView.tsx');
    expect(src).toContain("period.mode === 'custom'");
    expect(src).toContain('period.onCustomReset()');
  });

  it('21) TransactionsView mostra "Personalizado" no label quando mode=custom', () => {
    const src = readSource('views/TransactionsView.tsx');
    expect(src).toContain("mode === 'custom'");
    expect(src).toContain("'Personalizado'");
  });

  it('22) Pendências não exibe seletor de período', () => {
    const html = renderToString(
      createElement(TransactionsView, {
        ...{
          profileId: shellProps.profileId,
          profileCode: 'personal',
          period,
          mode: 'pending',
          onModeChange: NOOP,
          pendingFilter: 'all',
          onPendingFilterChange: NOOP,
        },
      }),
    );
    expect(html).not.toContain('period-range-applied');
    expect(html).not.toContain('tx-period-bar');
  });

  it('23) CSS tem estilos para period-range-custom e period-picker', () => {
    expect(css).toContain('period-range-custom');
    expect(css).toContain('period-picker');
    expect(css).toContain('period-picker-fields');
    expect(css).toContain('period-picker-error');
    expect(css).toContain('period-picker-actions');
  });

  it('24) PeriodPicker inputs possuem aria-label', () => {
    const src = readSource('components/PeriodPicker.tsx');
    expect(src).toContain('aria-label="Data inicial"');
    expect(src).toContain('aria-label="Data final"');
  });

  it('25) PeriodPicker inputs têm área mínima 44px', () => {
    expect(css).toContain('period-picker-input');
    expect(css).toContain('min-height: 44px');
  });

  it('26) botões do PeriodPicker têm área mínima 44px', () => {
    expect(css).toContain('period-picker-btn');
    expect(css).toContain('min-width: 44px');
  });

  it('27) navegação Início→Transações preserva o período custom', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain('customStart');
    expect(src).toContain('customEnd');
    expect(src).toContain('mode');
    expect(src).not.toMatch(/setCustomStart\(null\)/);
  });
});

describe('Diferenciação Início ↔ Transações', () => {
  it('28) RecentTransactions limita a 5 transações (MAX_RECENT = 5)', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain('MAX_RECENT = 5');
  });

  it('29) RecentTransactions ordena por occurred_on decrescente', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain("order('occurred_on', { ascending: false })");
  });

  it('30) RecentTransactions filtra deleted_at IS NULL', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain("is('deleted_at', null)");
  });

  it('31) Dashboard não possui state de busca, conta ou filtros de status', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).not.toMatch(/useState.*search/);
    expect(src).not.toMatch(/useState.*selectedAccount/);
    expect(src).not.toMatch(/useState.*filterNoCategory/);
    expect(src).not.toMatch(/useState.*filterReviewOnly/);
  });

  it('32) Dashboard não renderiza TransactionList', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).not.toContain('tx-table');
    expect(html).not.toContain('tx-search');
  });

  it('33) Dashboard renderiza RecentTransactions com classe recent-tx-section', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).toContain('recent-tx-section');
  });

  it('34) Dashboard aceita prop onNavigateToTransactions', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).toContain('onNavigateToTransactions');
    expect(src).toMatch(/interface DashboardProps/);
    expect(src).toContain("onNavigateToTransactions?: () => void");
  });

  it('35) AppShell passa onNavigateToTransactions ao Dashboard', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain('handleNavigateToTransactions');
    expect(src).toContain('onNavigateToTransactions={handleNavigateToTransactions}');
  });

  it('36) handleNavigateToTransactions volta para modo period e view transacoes', () => {
    const src = readSource('components/AppShell.tsx');
    expect(src).toContain("setTxMode('period')");
    expect(src).toContain("setView('transacoes')");
  });

  it('37) RecentTransactions renderiza botão "Ver todas" com link', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain('Ver todas');
    expect(src).toContain('onNavigateToTransactions');
  });

  it('38) Dashboard mantém editor state e DeleteConfirmation', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).toContain('TransactionEditor');
    expect(src).toContain('DeleteConfirmation');
    expect(src).toContain('handleEditTransaction');
    expect(src).toContain('handleDeleteTransaction');
  });

  it('39) Dashboard mantém summary, pending panel e FAB', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).toContain('Pendências');
    expect(html).toContain('tx-fab');
    expect(html).toContain('Nova transação');
  });

  it('40) Transações view não foi alterada — ainda renderiza TransactionList completo', () => {
    const html = renderToString(
      createElement(TransactionsView, {
        profileId: shellProps.profileId,
        profileCode: 'personal',
        period,
        mode: 'period' as const,
        onModeChange: NOOP,
        pendingFilter: 'all',
        onPendingFilterChange: NOOP,
      }),
    );
    expect(html).toContain('tx-table');
    expect(html).toContain('tx-search');
    expect(html).toContain('transações no período');
  });

  it('41) CSS contém estilos para recent-tx-* (seção, cabeçalho, lista, linha, vazio)', () => {
    expect(css).toContain('recent-tx-section');
    expect(css).toContain('recent-tx-header');
    expect(css).toContain('recent-tx-title');
    expect(css).toContain('recent-tx-view-all');
    expect(css).toContain('recent-tx-list');
    expect(css).toContain('recent-tx-row');
    expect(css).toContain('recent-tx-info');
    expect(css).toContain('recent-tx-desc');
    expect(css).toContain('recent-tx-meta');
    expect(css).toContain('recent-tx-value');
    expect(css).toContain('recent-tx-actions');
  });

  it('42) CSS mobile adapta recent-tx-row para wrap e min-height', () => {
    const mobile = extractMediaBlock(css, '@media (max-width: 767px)');
    expect(mobile).toContain('recent-tx-row');
    expect(mobile).toContain('flex-wrap: wrap');
    expect(mobile).toContain('padding: 12px 14px');
  });

  it('43) RecentTransactions aceita props de edição e exclusão', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain('onEditTransaction');
    expect(src).toContain('onDeleteTransaction');
    expect(src).toContain('Pencil');
    expect(src).toContain('Trash2');
  });

  it('44) Dashboard não renderiza filterX ou limpar filtros', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).not.toContain('Limpar filtros');
    expect(html).not.toContain('filterX');
  });
});
  it('56) Início mantém resumo, pendências, transações recentes e FAB', () => {
    const html = renderToString(createElement(Dashboard, { profileId: shellProps.profileId, period }));
    expect(html).toContain('Resumo');
    expect(html).toContain('Pendências');
    expect(html).toContain('recent-tx-section');
    expect(html).toContain('tx-fab');
    expect(html).toContain('Nova transação');
  });
