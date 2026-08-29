// categoryCrud.ts - CRUD de categorias (Configurações) com RPCs controlados.
// Regra de domínio (igual ao backend): categoria pertence a UM perfil;
// direction income/expense; parent do mesmo perfil e mesma direção;
// sem self-parent, sem ciclo; arquivar nunca apaga e nunca toca transactions.
// Nenhum write direto em categories: tudo via RPC public.category_* (INVOKER
// -> app.* DEFINER; perfil sempre do JWT).

export type CategoryDirection = 'income' | 'expense';
export type CategoryStatus = 'active' | 'archived' | 'review';

export interface CategoryRow {
  id: string;
  profile_id: string;
  direction: string;
  parent_id: string | null;
  display_name: string;
  source_name: string | null;
  normalized_name: string;
  status: CategoryStatus;
  canonical_path: string | null;
}

export interface CategoryCrudClientLike {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface CategoryActionResult {
  data: unknown;
  error: string | null;
}

// ---------- Helpers puros (testáveis) ----------

/** Categorias do perfil e direção (isolamento Pessoal/Negócio). */
export function filterCategoriesByProfileAndDirection(
  cats: CategoryRow[],
  profileId: string,
  direction: string,
): CategoryRow[] {
  return cats.filter((c) => c.profile_id === profileId && c.direction === direction);
}

/** Verifica se o novo pai é compatível (mesmo perfil, mesma direção, não self, sem ciclo). */
export function isParentAllowed(
  cats: CategoryRow[],
  categoryId: string,
  parentId: string | null,
): { ok: boolean; reason: string | null } {
  if (parentId === null) return { ok: true, reason: null };
  if (parentId === categoryId) return { ok: false, reason: 'A categoria não pode ser filha dela mesma.' };
  const cat = cats.find((c) => c.id === categoryId);
  const parent = cats.find((c) => c.id === parentId);
  if (!cat || !parent) return { ok: false, reason: 'Categoria ou destino inválido.' };
  if (cat.profile_id !== parent.profile_id) return { ok: false, reason: 'A categoria pertence a outro perfil.' };
  if (cat.direction !== parent.direction) {
    return { ok: false, reason: `Categoria de ${cat.direction === 'income' ? 'receita' : 'despesa'} não pode ficar sob ${parent.direction === 'income' ? 'receita' : 'despesa'}.` };
  }
  // anti-ciclo: o novo pai não pode ser descendente do nó
  let ancestor: string | null = parentId;
  const guard = new Set<string>();
  while (ancestor) {
    if (ancestor === categoryId) return { ok: false, reason: 'A movimentação criaria um ciclo na árvore.' };
    if (guard.has(ancestor)) return { ok: false, reason: 'A movimentação criaria um ciclo na árvore.' };
    guard.add(ancestor);
    const p = cats.find((c) => c.id === ancestor);
    ancestor = p?.parent_id ?? null;
  }
  return { ok: true, reason: null };
}

/** Categoria possui filhos ativos? (bloqueia arquivamento) */
export function hasActiveChildren(cats: CategoryRow[], categoryId: string): boolean {
  return cats.some((c) => c.parent_id === categoryId && c.status === 'active');
}

/** Reativação permitida? (pai precisa existir e não estar arquivado) */
export function canReactivate(cats: CategoryRow[], categoryId: string): { ok: boolean; reason: string | null } {
  const cat = cats.find((c) => c.id === categoryId);
  if (!cat) return { ok: false, reason: 'Categoria não encontrada.' };
  if (cat.parent_id === null) return { ok: true, reason: null };
  const parent = cats.find((c) => c.id === cat.parent_id);
  if (!parent) return { ok: false, reason: 'A categoria pai não existe mais.' };
  if (parent.status === 'archived') return { ok: false, reason: 'A categoria pai está arquivada; reative-a antes.' };
  return { ok: true, reason: null };
}

export function categoryFriendlyDirection(direction: CategoryDirection): string {
  return direction === 'income' ? 'Receitas' : 'Despesas';
}

export function categoryFriendlyStatus(status: CategoryStatus): string {
  if (status === 'active') return 'Ativa';
  if (status === 'archived') return 'Arquivada';
  return 'Em revisão';
}

export function categoryErrorMessage(error: { message: string } | null): string | null {
  if (!error) return null;
  const m = error.message;
  if (m.includes('perfil nao identificado')) return 'Sessão expirada. Entre novamente.';
  if (m.includes('nome da categoria obrigatorio')) return 'Informe o nome da categoria.';
  if (m.includes('direcao invalida')) return 'Tipo de categoria inválido.';
  if (m.includes('categoria pai nao encontrada')) return 'A categoria pai não existe.';
  if (m.includes('outro perfil')) return 'A categoria pai pertence a outro perfil.';
  if (m.includes('sob ancestral')) return 'Não é possível usar essa categoria pai (direção incompatível).';
  if (m.includes('ja existe categoria com esse nome')) return 'Já existe uma categoria com esse nome neste nível.';
  if (m.includes('categoria nao pode ser filha de si mesma')) return 'A categoria não pode ser filha dela mesma.';
  if (m.includes('criaria ciclo')) return 'A movimentação criaria um ciclo na árvore.';
  if (m.includes('subcategorias ativas')) return 'Esta categoria possui subcategorias ativas; trate-as primeiro.';
  if (m.includes('pai esta arquivada')) return 'A categoria pai está arquivada; reative-a antes.';
  if (m.includes('pertence a outro perfil')) return 'A categoria pertence a outro perfil.';
  return 'Não foi possível concluir a operação.';
}

// ---------- Actions (RPCs; perfil sempre do JWT, nunca enviado) ----------

export async function createCategory(
  client: CategoryCrudClientLike,
  displayName: string,
  direction: CategoryDirection,
  parentId: string | null,
): Promise<CategoryActionResult> {
  const { data, error } = await client.rpc('category_create', {
    p_display_name: displayName,
    p_direction: direction,
    p_parent_id: parentId,
  });
  return { data, error: categoryErrorMessage(error) };
}

export async function updateCategory(
  client: CategoryCrudClientLike,
  categoryId: string,
  displayName: string,
  parentId: string | null,
): Promise<CategoryActionResult> {
  const { data, error } = await client.rpc('category_update', {
    p_category_id: categoryId,
    p_display_name: displayName,
    p_parent_id: parentId,
  });
  return { data, error: categoryErrorMessage(error) };
}

export async function setCategoryArchived(
  client: CategoryCrudClientLike,
  categoryId: string,
  archived: boolean,
): Promise<CategoryActionResult> {
  const { data, error } = await client.rpc('category_set_archived', {
    p_category_id: categoryId,
    p_archived: archived,
  });
  return { data, error: categoryErrorMessage(error) };
}