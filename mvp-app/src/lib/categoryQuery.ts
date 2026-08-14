// categoryQuery.ts — Construção testável da consulta de categorias.
// A consulta aplica SEMPRE o filtro explícito por perfil (defesa adicional);
// o isolamento real é garantido pela policy RLS categories_select_own.

export interface CategoryClientLike {
  from(table: string): any;
}

export interface CategoryQueryOptions {
  profileId: string;
  direction: string;
  status?: string;
}

export function buildCategoryQuery(client: CategoryClientLike, opts: CategoryQueryOptions) {
  return client
    .from('categories')
    .select('*')
    .eq('profile_id', opts.profileId)
    .eq('direction', opts.direction)
    .eq('status', opts.status ?? 'active');
}
