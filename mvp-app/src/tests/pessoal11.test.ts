import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { SettingsView } from '../views/SettingsView';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}
function readRoot(rel: string): string {
  return readFileSync(resolve(here, '..', '..', rel), 'utf8');
}

const shell = readSource('components/AppShell.tsx');
const settings = readSource('views/SettingsView.tsx');
const accounts = readSource('settings/AccountsSection.tsx');
const css = readRoot('src/index.css');

describe('PESSOAL-11 — navegação inferior com 4 destinos', () => {
  it('NAV_ITEMS tem exatamente 4 destinos (Início, Transações, Análises, Configurações)', () => {
    const nav = shell.slice(shell.indexOf('const NAV_ITEMS'), shell.indexOf('];'));
    expect((nav.match(/\{ id: '/g) ?? []).length).toBe(4);
    expect(nav).toContain("id: 'inicio'");
    expect(nav).toContain("id: 'transacoes'");
    expect(nav).toContain("id: 'analises'");
    expect(nav).toContain("id: 'configuracoes'");
  });

  it('Contas deixou de ser destino de navegação (sem item contas em NAV_ITEMS)', () => {
    const nav = shell.slice(shell.indexOf('const NAV_ITEMS'), shell.indexOf('];'));
    expect(nav).not.toContain("id: 'contas'");
  });

  it('r0ta Contas continua válida como atalho interno (view=contas)', () => {
    expect(shell).toContain("view === 'contas' && <SettingsView profileId={profileId} focusSection=\"accounts\" />");
  });

  it('bottom-nav e side-nav usam a mesma lista NAV_ITEMS', () => {
    expect(shell).toContain('NAV_ITEMS.map((item) => navItem(item, \'bottom-nav-item\'))');
    expect(shell).toContain('NAV_ITEMS.map((item) => navItem(item, \'side-nav-item\'))');
  });
});

describe('PESSOAL-11 — Configurações com sub-abas (Contas | Categorias | Histórico)', () => {
  it('SettingsView contém as três abas com role/a11y', () => {
    expect(settings).toContain("label: 'Contas'");
    expect(settings).toContain("label: 'Categorias'");
    expect(settings).toContain("label: 'Histórico'");
    expect(settings).toContain('role="tablist"');
    expect(settings).toContain('role="tab"');
  });

  it('default é a aba Contas (ativa no SSR sem focusSection)', () => {
    expect(settings).toContain("useState<SettingsTab>('accounts')");
    const html = renderToString(createElement(SettingsView, { profileId: 'PERFIL' }));
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('settings-tab-accounts');
  });

  it('abas têm teclado: setas, Home e End movem; aria-controls liga aba ao painel', () => {
    expect(settings).toContain("event.key === 'ArrowRight'");
    expect(settings).toContain("event.key === 'ArrowLeft'");
    expect(settings).toContain("event.key === 'Home'");
    expect(settings).toContain("event.key === 'End'");
    expect(settings).toContain('aria-controls={`settings-panel-${tab.id}`}');
  });

  it('painéis usam role=tabpanel com aria-labelledby e ocultação por hidden', () => {
    expect(settings).toContain('role="tabpanel"');
    expect(settings).toContain('aria-labelledby="settings-tab-accounts"');
    expect(settings).toContain('hidden={activeTab !== \'categories\'}');
  });

  it('todas as seções continuam delegadas (sem duplicação)', () => {
    expect(settings.split('<AccountsSection').length - 1).toBe(1);
    expect(settings.split('<CategoriesSection').length - 1).toBe(1);
    expect(settings.split('<HistorySection').length - 1).toBe(1);
  });

  it('sem resquício do antigo "Histórico de alterações"', () => {
    expect(settings).not.toContain('Histórico de alterações');
  });
});

describe('PESSOAL-11 — títulos redundantes removidos', () => {
  it('Dashboard não exibe h1 "Visão Geral" (mantém FAB Nova transação)', () => {
    const dash = readSource('components/Dashboard.tsx');
    expect(dash).not.toContain('Visão Geral');
    expect(dash).toContain('aria-label="Nova transação"');
  });

  it('Transações mantém subtítulo descritivo sem h1 redundante', () => {
    const tx = readSource('views/TransactionsView.tsx');
    expect(tx).not.toContain("<h1>{isPending");
    expect(tx).toContain('Todas as transações do perfil ativo no período selecionado');
  });

  it('Análises começa direto pelo seletor de período (sem h1 e sem subtítulo redundante)', () => {
    const anl = readSource('views/AnalyticsView.tsx');
    expect(anl).not.toContain('>Análises</h1>');
    expect(anl).not.toContain('somente leitura');
    expect(anl).not.toContain('Leitura do período no perfil');
    expect(anl).not.toContain('dash-title');
  });
});

describe('PESSOAL-11 — Contas compactas com grupos Ativas/Inativas e menu ⋮', () => {
  it('agrupa contas por status com cabeçalho colapsável (aria-expanded)', () => {
    expect(accounts).toContain("const actives = accounts.filter((a) => a.active)");
    expect(accounts).toContain("const inactives = accounts.filter((a) => !a.active)");
    expect(accounts).toContain('settings-account-group-header');
    expect(accounts).toContain('aria-expanded={open}');
    expect(accounts).toContain("'Ativas'");
    expect(accounts).toContain("'Inativas'");
  });

  it('menu ⋮ por conta (aria-haspopup) com Editar/Desativar/Reativar', () => {
    expect(accounts).toContain('aria-haspopup="menu"');
    expect(accounts).toContain('MoreVertical');
    expect(accounts).toContain('Editar');
    expect(accounts).toContain('Reativar');
    expect(accounts).toContain('Desativar');
  });

  it('badge de status preservado (favorites/CFG-P8A)', () => {
    expect(accounts).toContain("a.active ? 'Ativa' : 'Inativa'");
  });

  it('preferência (favorito) e hint de desativação intactos', () => {
    expect(accounts).toContain('if (favoriteBusyId) return;');
    expect(accounts).toContain('Desativar esta conta impede novos lançamentos nela neste perfil. Os lançamentos anteriores continuam no histórico.');
  });

  it('linhas compactas (~55-70px): altura mínima 44px no corpo + paddings pequenos', () => {
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('.settings-account-main');
    expect(css).toContain('.settings-menu');
  });
});

describe('PESSOAL-11 — CSS de sub-abas presente', () => {
  it('estilos .settings-tabs e .settings-tab-active existem', () => {
    expect(css).toContain('.settings-tabs');
    expect(css).toContain('.settings-tab-active');
  });
});