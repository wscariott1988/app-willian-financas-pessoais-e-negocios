import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categorizerKeyAction } from '../components/CategorizerPanel';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const panel = readSource('components/CategorizerPanel.tsx');
const css = readSource('index.css');

describe('A-01 — seletor de categorias operável por teclado', () => {
  it('A) controle é um listbox focável com nome acessível (role + tabIndex + aria-labelledby)', () => {
    expect(panel).toContain('role="listbox"');
    expect(panel).toContain('tabIndex={0}');
    expect(panel).toContain('id="categorizer-label"');
    expect(panel).toContain('aria-labelledby="categorizer-label"');
    expect(panel).toContain('Selecione a categoria');
    // foco visível (WCAG 2.4.7)
    expect(css).toContain('.categorizer-listbox:focus-visible');
    expect(css).toMatch(/\.categorizer-listbox:focus-visible[\s\S]{0,80}outline/);
  });

  it('B) abrir/preview por teclado: ArrowDown saindo do repouso ativa a 1ª opção', () => {
    // o seletor está sempre aberto; focar + seta destaca (aria-activedescendant)
    expect(categorizerKeyAction('ArrowDown', -1, 5)).toEqual({ type: 'move', index: 0 });
    expect(panel).toContain('aria-activedescendant={');
  });

  it('C) ArrowUp/ArrowDown navegam e não estouram os limites da lista', () => {
    expect(categorizerKeyAction('ArrowDown', 0, 5)).toEqual({ type: 'move', index: 1 });
    expect(categorizerKeyAction('ArrowDown', 4, 5)).toEqual({ type: 'move', index: 4 });
    expect(categorizerKeyAction('ArrowUp', 4, 5)).toEqual({ type: 'move', index: 3 });
    expect(categorizerKeyAction('ArrowUp', 0, 5)).toEqual({ type: 'move', index: 0 });
    expect(categorizerKeyAction('ArrowUp', -1, 5)).toEqual({ type: 'move', index: 4 });
    expect(categorizerKeyAction('ArrowDown', -1, 0)).toEqual({ type: 'none' });
  });

  it('D) Enter (ou Espaço) confirma a opção ativa; sem ativa nada não é confirmado', () => {
    expect(categorizerKeyAction('Enter', 2, 5)).toEqual({ type: 'commit', index: 2 });
    expect(categorizerKeyAction(' ', 1, 5)).toEqual({ type: 'commit', index: 1 });
    expect(categorizerKeyAction('Enter', -1, 5)).toEqual({ type: 'commit', index: -1 });
    // o handler só confirma quando há opção ativa (>= 0)
    expect(panel).toContain('action.index >= 0 && categories[action.index]');
    expect(panel).toContain('commitCategory(categories[action.index].id, action.index)');
  });

  it('E) Escape fecha o seletor sem confirmar seleção indevida', () => {
    expect(categorizerKeyAction('Escape', 3, 5)).toEqual({ type: 'close' });
    // caminho do Escape: limpa o destaque e devolve o foco; NÃO chama commitCategory
    const closeIdx = panel.indexOf("action.type === 'close'");
    expect(closeIdx).toBeGreaterThan(-1);
    const closeBlock = panel.slice(closeIdx, closeIdx + 200);
    expect(closeBlock).toContain('setActiveIndex(-1)');
    expect(closeBlock).toContain('blur()');
    expect(closeBlock).not.toContain('commitCategory');
    expect(closeBlock).not.toContain('setSelectedCategoryId');
  });

  it('opções expõem estado selecionado e o teclado é escopado ao listbox', () => {
    expect(panel).toContain('role="option"');
    expect(panel).toContain('aria-selected={');
    // handler ligado somente no próprio listbox (nunca global)
    expect(panel).toContain('onKeyDown={handleCategoryKeyDown}');
    expect(panel).not.toContain("addEventListener('keydown'");
  });
});
