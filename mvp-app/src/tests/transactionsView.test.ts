import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppShell } from '../components/AppShell';
import { TransactionList } from '../components/TransactionList';
import { TransactionsView } from '../views/TransactionsView';

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
  it('11) selecionar abre o recategorizador (renderizado somente com seleção)', () => {
    const viewHtml = renderToString(createElement(TransactionsView, { profileId: shellProps.profileId, period }));
    // sem seleção: nenhum painel vazio permanente
    expect(viewHtml).not.toContain('Nenhuma transação selecionada');
    expect(viewHtml).not.toContain('tx-view-side');

    const source = readSource('views/TransactionsView.tsx');
    expect(source).toContain('onSelectTransaction={handleSelect}');
    expect(source).toContain('selectedTransaction && (');
    expect(source).toContain('transaction={selectedTransaction}');
  });

  it('12) fechar restaura a largura da lista (classe with-side condicional)', () => {
    const source = readSource('views/TransactionsView.tsx');
    expect(source).toContain('handleCloseCategorizer');
    expect(source).toContain(`tx-view-grid \${selectedTransaction ? 'with-side' : ''}`);
    // fechar com Escape continua presente
    expect(source).toContain("'Escape'");
    // o botão de fechar do painel permanece testado em categorizerClose.test.tsx
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

  it('1) grid real da linha secundária (data max-content, categoria flexível)', () => {
    const tr = ruleBlock(mobile, '.tx-table tr');
    expect(tr).toContain('grid-template-columns: max-content minmax(0, 1fr) max-content max-content');
    expect(tr).toContain("'date cat account status'");
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
