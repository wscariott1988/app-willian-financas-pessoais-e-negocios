import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { SettingsView, buildCategoryTree, groupCategoriesByDirection, categoryStatusLabel, type SettingsCategory } from '../views/SettingsView';
import { buildAccountQuery, mapAccountPeriods, type AccountPeriodRow } from '../lib/accountQuery';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}
function readView(): string {
  return readFileSync(resolve(here, '..', 'views', 'SettingsView.tsx'), 'utf8');
}
function readAccountsSection(): string {
  return readFileSync(resolve(here, '..', 'settings', 'AccountsSection.tsx'), 'utf8');
}
function readCategoriesSection(): string {
  return readFileSync(resolve(here, '..', 'settings', 'CategoriesSection.tsx'), 'utf8');
}

function mockChain() {
  const calls: string[] = [];
  const q = {
    from: (t: string) => { calls.push(`from:${t}`); return q; },
    select: () => { calls.push('select'); return q; },
    eq: (c: string, v: unknown) => { calls.push(`eq:${c}=${String(v)}`); return q; },
    order: () => { calls.push('order'); return q; },
  };
  return { q, calls };
}

describe('SettingsView — estrutura (CFG-P0b)', () => {
  it('renderiza as seções Contas e Categorias e subcategorias', () => {
    const html = renderToString(createElement(SettingsView, { profileId: 'PERFIL' }));
    expect(html).toContain('Contas');
    expect(html).toContain('Categorias e subcategorias');
    expect(html).toContain('Configurações');
  });

  it('não reexpõe o antigo Histórico de alterações', () => {
    const src = readView();
    expect(src).not.toContain('Histórico de alterações');
    expect(src).not.toContain('AuditLogs');
  });

  it('a view principal delega às seções extraídas (sem duplicação)', () => {
    const src = readView();
    expect(src).toContain("<AccountsSection profileId={profileId} />");
    expect(src).toContain("<CategoriesSection profileId={profileId} />");
    expect(src).not.toContain("from('categories')");
  });
});

describe('SettingsView — Contas (CFG-P0b/CFG-P2C)', () => {
  it('consulta contas pela relação de perfil (account_profile_periods + profile_id)', () => {
    const { q, calls } = mockChain();
    buildAccountQuery(q as any, 'PERFIL_PESSOAL');
    expect(calls).toContain('from:account_profile_periods');
    expect(calls).toContain('eq:profile_id=PERFIL_PESSOAL');
    expect(calls).not.toContain('from:accounts');
  });

  it('conta exclusiva do outro perfil não aparece (conjunto escopado por profile_id)', () => {
    const rows = [
      { account_id: 'ACC_PESSOAL', starts_on: '2022-01-01', ends_on: null, accounts: { display_name: 'Conta Pessoal', source_name: 'Banco' } },
    ] as AccountPeriodRow[];
    const result = mapAccountPeriods(rows);
    expect(result.map((a) => a.id)).toEqual(['ACC_PESSOAL']);
    expect(result.map((a) => a.id)).not.toContain('ACC_NEGOCIO');
  });

  it('dedupe de múltiplos períodos da mesma conta', () => {
    const rows = [
      { account_id: 'ACC', starts_on: '2022-01-01', ends_on: null, accounts: { display_name: 'Conta', source_name: 'X' } },
      { account_id: 'ACC', starts_on: '2022-06-01', ends_on: null, accounts: { display_name: 'Conta', source_name: 'X' } },
    ] as AccountPeriodRow[];
    expect(mapAccountPeriods(rows).length).toBe(1);
  });

  it('fallback seguro: sem UUID no rótulo quando display_name ausente', () => {
    const rows = [
      { account_id: 'a8b449c9-b9ce-5390-b763-3d3ca2254ef9', starts_on: '2022-01-01', ends_on: null, accounts: { display_name: '', source_name: 'Banco X' } },
    ] as AccountPeriodRow[];
    const result = mapAccountPeriods(rows);
    expect(result[0].display_name).toBe('Banco X');
    expect(result[0].display_name).not.toContain('a8b449c9');
  });

  it('estado vazio e erro amigáveis presentes', () => {
    const src = readAccountsSection();
    expect(src).toContain('Nenhuma conta encontrada para este perfil.');
    expect(src).toContain('Não foi possível carregar as contas.');
  });

  it('ações de contas presentes (Nova conta / Vincular / Desativar / Reativar / Editar)', () => {
    const src = readAccountsSection();
    expect(src).toContain('Nova conta');
    expect(src).toContain('Vincular conta de outro perfil');
    expect(src).toContain('Vincular');
    expect(src).toContain('Desativar');
    expect(src).toContain('Reativar');
    expect(src).toContain('Editar');
  });

  it('mensagem de desativação preserva histórico', () => {
    const src = readAccountsSection();
    expect(src).toContain('Desativar esta conta impede novos lançamentos nela neste perfil. Os lançamentos anteriores continuam no histórico.');
  });
});

describe('SettingsView — Categorias (CFG-P0b/CFG-P3A)', () => {
  it('consulta categorias filtradas pelo perfil ativo', () => {
    const src = readCategoriesSection();
    expect(src).toContain(".from('categories')");
    expect(src).toContain(".eq('profile_id', profileId)");
    expect(src).toContain('.select(');
  });

  it('hierarquia pai/filho é construída corretamente', () => {
    const cats: SettingsCategory[] = [
      c('moradia', 'expense', null, 'Moradia'),
      c('energia', 'expense', 'moradia', 'Energia'),
      c('agua', 'expense', 'moradia', 'Água'),
      c('mercado', 'expense', null, 'Mercado'),
    ];
    const tree = buildCategoryTree(cats);
    expect(tree.map((n) => n.cat.display_name)).toEqual(['Mercado', 'Moradia']);
    const moradia = tree.find((n) => n.cat.id === 'moradia')!;
    expect(moradia.children.map((n) => n.cat.display_name)).toEqual(['Água', 'Energia']);
  });

  it('receita e despesa não são confundidas (agrupamento por direção)', () => {
    const cats: SettingsCategory[] = [
      c('salario', 'income', null, 'Salário'),
      c('aluguel', 'expense', null, 'Aluguel'),
      c('energia', 'expense', null, 'Energia'),
    ];
    const groups = groupCategoriesByDirection(cats);
    const income = groups.find((g) => g.direction === 'income')!;
    const expense = groups.find((g) => g.direction === 'expense')!;
    expect(income.roots.map((n) => n.cat.id)).toEqual(['salario']);
    expect(expense.roots.map((n) => n.cat.id).sort()).toEqual(['aluguel', 'energia']);
    expect(expense.roots.map((n) => n.cat.id)).not.toContain('salario');
  });

  it('estado vazio e erro amigáveis presentes', () => {
    const src = readCategoriesSection();
    expect(src).toContain('Nenhuma categoria encontrada para este perfil.');
    expect(src).toContain('Não foi possível carregar as categorias.');
  });

  it('ações de categorias presentes (Nova categoria / Nova subcategoria / Editar / Arquivar / Reativar)', () => {
    const src = readCategoriesSection();
    expect(src).toContain('Nova categoria');
    expect(src).toContain('Nova subcategoria');
    expect(src).toContain('Arquivar');
    expect(src).toContain('Reativar');
    expect(src).toContain('Editar');
  });
});

describe('SettingsView — STATUS-P0: sem códigos técnicos de categoria (CFG)', () => {
  it('categoryStatusLabel: ativo sem badge; códigos viram labels amigáveis', () => {
    expect(categoryStatusLabel('active')).toBeNull();
    expect(categoryStatusLabel('archived')).toBe('Arquivada');
    expect(categoryStatusLabel('review')).toBe('Em revisão');
    expect(categoryStatusLabel('desconhecido')).toBeNull();
  });

  it('seções de Configurações não renderizam (review), (archive) nem códigos crus', () => {
    const cats = readCategoriesSection();
    expect(cats).not.toContain('(review)');
    expect(cats).not.toContain('(archive)');
    expect(cats).not.toContain('(archived)');
    const jsx = cats.slice(cats.lastIndexOf('return ('));
    expect(jsx).not.toContain('{node.cat.status}');
    expect(jsx).not.toContain("'review'");
    expect(jsx).not.toContain("'archived'");
    expect(cats).toContain('Arquivada');
    expect(cats).toContain('Em revisão');
  });

  it('não altera consulta de categorias (status/direction/hierarchy intocados no dado)', () => {
    const src = readCategoriesSection();
    expect(src).toContain(".from('categories')");
    expect(src).toContain(".eq('profile_id', profileId)");
    expect(src).toContain('select(');
  });
});

describe('SettingsView — troca de perfil e higiene de UI (CFG-P0b)', () => {
  it('ambas as seções recarregam quando profileId muda (useEffect [profileId] + limpeza)', () => {
    expect(readAccountsSection()).toContain('}, [profileId]);');
    expect(readCategoriesSection()).toContain('}, [profileId]);');
    expect(readAccountsSection()).toContain('setAccounts([])');
    expect(readCategoriesSection()).toContain('setCategories([])');
  });

  it('não mantém dados do perfil anterior (lista limpa ao iniciar o load)', () => {
    expect(readAccountsSection()).toContain('setAccounts([])');
    expect(readCategoriesSection()).toContain('setCategories([])');
  });

  it('não expõe SQL/RLS/RPC/UUID/JSON no JSX renderizado', () => {
    const src = readView();
    const jsx = src.slice(src.lastIndexOf('return ('));
    expect(jsx).not.toContain('transaction_audit');
    expect(jsx).not.toContain('category_assignment_audit');
    expect(jsx).not.toContain('.from(');
    expect(jsx).not.toContain('profile_id =');
    expect(jsx).not.toContain('RPC');
    for (const section of [readAccountsSection(), readCategoriesSection()]) {
      const sectionJsx = section.slice(section.lastIndexOf('return ('));
      expect(sectionJsx).not.toContain('.from(');
      expect(sectionJsx).not.toContain('profile_id =');
    }
  });
});

function c(id: string, direction: 'income' | 'expense' | 'transfer', parent_id: string | null, display_name: string): SettingsCategory {
  return { id, profile_id: 'P', direction, parent_id, display_name, source_name: null, normalized_name: id, canonical_path: null, status: 'active' };
}