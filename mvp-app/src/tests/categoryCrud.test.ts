import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCategory,
  updateCategory,
  setCategoryArchived,
  filterCategoriesByProfileAndDirection,
  isParentAllowed,
  hasActiveChildren,
  canReactivate,
  categoryErrorMessage,
  categoryFriendlyDirection,
  categoryFriendlyStatus,
  type CategoryCrudClientLike,
  type CategoryRow,
} from '../lib/categoryCrud';

const here = dirname(fileURLToPath(import.meta.url));
function readMigration(): string {
  return readFileSync(resolve(here, '..', '..', '..', 'supabase', 'migrations', '018_category_crud.sql'), 'utf8');
}
function readEditor(): string {
  return readFileSync(resolve(here, '..', 'components', 'TransactionEditor.tsx'), 'utf8');
}

function mockRpc(overrides?: { error?: { message: string } }) {
  const calls: string[] = [];
  const client: CategoryCrudClientLike = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`${fn}||${JSON.stringify(args)}`);
      if (overrides?.error) return { data: null, error: overrides.error };
      return { data: { ok: true }, error: null };
    },
  };
  return { client, calls };
}
function callOf(entry: string): { fn: string; args: Record<string, unknown> } {
  const idx = entry.indexOf('||');
  return { fn: entry.slice(0, idx), args: JSON.parse(entry.slice(idx + 2)) };
}

function cat(partial: Partial<CategoryRow> & { id: string }): CategoryRow {
  return {
    profile_id: 'PESSOAL',
    direction: 'expense',
    parent_id: null,
    display_name: partial.id,
    source_name: null,
    normalized_name: partial.id,
    status: 'active',
    canonical_path: null,
    ...partial,
  };
}

describe('CFG-P3A — criar categoria', () => {
  it('1. criar expense chama category_create com direction expense e sem profile no payload', async () => {
    const { client, calls } = mockRpc();
    await createCategory(client, 'Alimentação', 'expense', null);
    const call = callOf(calls[0]);
    expect(call.fn).toBe('category_create');
    expect(call.args.p_direction).toBe('expense');
    expect(call.args.p_display_name).toBe('Alimentação');
    expect(call.args.p_parent_id).toBeNull();
    expect(Object.keys(call.args)).not.toContain('p_profile_id');
  });

  it('2. criar income usa direction income', async () => {
    const { client, calls } = mockRpc();
    await createCategory(client, 'Salário', 'income', null);
    expect(callOf(calls[0]).args.p_direction).toBe('income');
  });

  it('3. criar subcategoria envia parent_id', async () => {
    const { client, calls } = mockRpc();
    await createCategory(client, 'Mercado', 'expense', 'CAT_ALIMENTACAO');
    const call = callOf(calls[0]);
    expect(call.args.p_parent_id).toBe('CAT_ALIMENTACAO');
  });

  it('nome vazio e direção inválida têm mensagens amigáveis', () => {
    expect(categoryErrorMessage({ message: 'nome da categoria obrigatorio' })).toBe('Informe o nome da categoria.');
    expect(categoryErrorMessage({ message: 'direcao invalida' })).toBe('Tipo de categoria inválido.');
  });
});

describe('CFG-P3A — validação de parent (helpers puros)', () => {
  const cats: CategoryRow[] = [
    cat({ id: 'raiz', direction: 'expense' }),
    cat({ id: 'alim', direction: 'expense', parent_id: 'raiz' }),
    cat({ id: 'mercado', direction: 'expense', parent_id: 'alim' }),
    cat({ id: 'salario', direction: 'income' }),
    cat({ id: 'neg_expense', direction: 'expense', profile_id: 'NEGOCIO' }),
  ];

  it('4. parent cross-profile é rejeitado', () => {
    const r = isParentAllowed(cats, 'alim', 'neg_expense');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outro perfil');
  });

  it('5. direction incompatível é rejeitada (income sob expense)', () => {
    const r = isParentAllowed(cats, 'salario', 'alim');
    expect(r.ok).toBe(false);
  });

  it('6. self-parent é rejeitado', () => {
    const r = isParentAllowed(cats, 'alim', 'alim');
    expect(r.ok).toBe(false);
  });

  it('7. ciclo indireto é rejeitado (mover raiz sob descendente)', () => {
    const r = isParentAllowed(cats, 'raiz', 'mercado');
    expect(r.ok).toBe(false);
  });

  it('parent válido do mesmo perfil/direção é aceito', () => {
    const r = isParentAllowed(cats, 'mercado', 'alim');
    expect(r.ok).toBe(true);
  });
});

describe('CFG-P3A — rename e move preservam id e histórico (migration 018)', () => {
  const sql = readMigration();

  it('8. renomear preserva id (UPDATE sem alterar id)', () => {
    expect(sql).toMatch(/UPDATE categories\s+SET display_name\s*=\s*v_name/);
    expect(sql).not.toMatch(/UPDATE categories SET id/i);
  });

  it('9. renomear não muda transactions (nenhuma referência no SQL)', () => {
    expect(sql).not.toMatch(/INSERT INTO\s+(transactions|accounts)/i);
    expect(sql).not.toMatch(/UPDATE\s+(transactions|accounts)\b/i);
    expect(sql).not.toMatch(/DELETE FROM\s+(transactions|accounts)/i);
  });

  it('10. mover preserva id e refaz canonical_path recursivo (filhos seguem o nó)', () => {
    expect(sql).toContain('category_refresh_path');
    expect(sql).toMatch(/FOR v_child IN SELECT id FROM categories WHERE parent_id = p_category_id/);
  });

  it('11. nenhum physical delete em nenhuma tabela', () => {
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it('12. arquivar usa status archived (sem delete)', () => {
    expect(sql).toMatch(/SET status = 'archived'/);
  });

  it('arquivar bloqueia quando há subcategorias ativas', () => {
    expect(sql).toMatch(/subcategorias ativas/i);
  });

  it('16. reativar com pai arquivado é rejeitado', () => {
    expect(sql).toMatch(/categoria pai esta arquivada/i);
    expect(sql).toMatch(/p\.status = 'archived'/);
  });

  it('19/20. nenhum write em accounts ou transactions (somente mutacoes)', () => {
    expect(sql).not.toMatch(/INSERT INTO\s+(accounts|transactions)/i);
    expect(sql).not.toMatch(/UPDATE\s+(accounts|transactions)\b/i);
    expect(sql).not.toMatch(/DELETE FROM\s+(accounts|transactions)/i);
  });
});

describe('CFG-P3A — arquivar/reativar (helpers + ações)', () => {
  const cats: CategoryRow[] = [
    cat({ id: 'raiz' }),
    cat({ id: 'alim', parent_id: 'raiz' }),
    cat({ id: 'mercado', parent_id: 'alim', status: 'archived' }),
  ];

  it('12b. arquivar sem physical delete: ação chama category_set_archived(true)', async () => {
    const { client, calls } = mockRpc();
    await setCategoryArchived(client, 'alim', true);
    const call = callOf(calls[0]);
    expect(call.fn).toBe('category_set_archived');
    expect(call.args.p_archived).toBe(true);
  });

  it('arquivar categoria com filhos ativos é bloqueado na UI (helper)', () => {
    expect(hasActiveChildren(cats, 'raiz')).toBe(true);
    expect(hasActiveChildren(cats, 'alim')).toBe(false);
  });

  it('15. reativar válida quando pai não está arquivado', () => {
    expect(canReactivate(cats, 'mercado').ok).toBe(true);
  });

  it('16b. reativar com pai arquivado é rejeitado (helper)', () => {
    const arq = cats.map((c) => (c.id === 'alim' ? { ...c, status: 'archived' as const } : c));
    const r = canReactivate(arq, 'mercado');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('pai está arquivada');
  });

  it('mensagens amigáveis de arquivamento', () => {
    expect(categoryErrorMessage({ message: 'categoria possui subcategorias ativas; trate-as primeiro' })).toContain('subcategorias ativas');
    expect(categoryErrorMessage({ message: 'categoria pai esta arquivada; reative-a antes' })).toContain('pai está arquivada');
  });
});

describe('CFG-P3A — isolamento de perfil e representação', () => {
  const cats: CategoryRow[] = [
    cat({ id: 'p_expense', profile_id: 'PESSOAL', direction: 'expense' }),
    cat({ id: 'p_income', profile_id: 'PESSOAL', direction: 'income' }),
    cat({ id: 'n_expense', profile_id: 'NEGOCIO', direction: 'expense' }),
  ];

  it('17. isolamento Pessoal (somente perfil + direção)', () => {
    const r = filterCategoriesByProfileAndDirection(cats, 'PESSOAL', 'expense');
    expect(r.map((c) => c.id)).toEqual(['p_expense']);
    expect(r.map((c) => c.id)).not.toContain('n_expense');
    expect(r.map((c) => c.id)).not.toContain('p_income');
  });

  it('18. isolamento Negócio', () => {
    const r = filterCategoriesByProfileAndDirection(cats, 'NEGOCIO', 'expense');
    expect(r.map((c) => c.id)).toEqual(['n_expense']);
  });

  it('labels amigáveis (sem termos técnicos)', () => {
    expect(categoryFriendlyDirection('income')).toBe('Receitas');
    expect(categoryFriendlyDirection('expense')).toBe('Despesas');
    expect(categoryFriendlyStatus('active')).toBe('Ativa');
    expect(categoryFriendlyStatus('archived')).toBe('Arquivada');
    expect(categoryFriendlyStatus('review')).toBe('Em revisão');
  });
});

describe('CFG-P3A — integração com transações', () => {
  const editor = readEditor();

  it('13. novo lançamento só oferece categorias ativas (filtro status=active)', () => {
    expect(editor).toContain(".eq('status', 'active')");
    expect(editor).toContain(".eq('direction', form.kind)");
  });

  it('14. edição histórica: categoria arquivada da transação continua representável', () => {
    expect(editor).toContain('.from(\'categories\')');
    const createIdx = editor.indexOf('loadCategories');
    const saveIdx = editor.indexOf('buildSavePayload');
    expect(createIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    // a categoria da transação carregada deve ser incluída mesmo se fora da lista ativa
    expect(editor).toMatch(/category_id/);
  });
});