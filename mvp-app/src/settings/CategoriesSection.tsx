import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import {
  canReactivate,
  categoryFriendlyDirection,
  categoryFriendlyStatus,
  createCategory,
  filterCategoriesByProfileAndDirection,
  hasActiveChildren,
  isParentAllowed,
  setCategoryArchived,
  updateCategory,
  type CategoryDirection,
  type CategoryRow,
} from '../lib/categoryCrud';

// ---------- Helpers puros (testáveis; reexportados pela SettingsView) ----------

export interface SettingsCategory {
  id: string;
  profile_id: string;
  direction: 'income' | 'expense' | 'transfer';
  parent_id: string | null;
  display_name: string;
  source_name: string | null;
  normalized_name: string;
  canonical_path: string | null;
  status: 'active' | 'archived' | 'review';
}

export interface CategoryNode {
  cat: SettingsCategory;
  children: CategoryNode[];
}

export const DIRECTION_LABELS: Record<string, string> = {
  income: 'Receitas',
  expense: 'Despesas',
  transfer: 'Transferências',
};

export const CATEGORY_STATUS_LABELS: Record<string, string> = {
  archived: 'Arquivada',
  review: 'Em revisão',
};

export function categoryStatusLabel(status: string): string | null {
  if (status === 'active') return null;
  return CATEGORY_STATUS_LABELS[status] ?? null;
}

export function buildCategoryTree(cats: SettingsCategory[]): CategoryNode[] {
  const byParent = new Map<string | null, SettingsCategory[]>();
  for (const c of cats) {
    const key = c.parent_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  const build = (parentId: string | null): CategoryNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => (a.canonical_path || a.display_name).localeCompare(b.canonical_path || b.display_name))
      .map((c) => ({ cat: c, children: build(c.id) }));
  return build(null);
}

export function groupCategoriesByDirection(cats: SettingsCategory[]): { direction: string; label: string; roots: CategoryNode[] }[] {
  const order: SettingsCategory['direction'][] = ['income', 'expense', 'transfer'];
  const present = [...new Set(cats.map((c) => c.direction))];
  const dirs = order.filter((d) => present.includes(d)).concat(present.filter((d) => !order.includes(d))).sort();
  return dirs.map((d) => ({
    direction: d,
    label: DIRECTION_LABELS[d] ?? d,
    roots: buildCategoryTree(cats.filter((c) => c.direction === d)),
  }));
}

// ---------- Seção Categorias (CRUD seguro; sem termos técnicos) ----------

interface EditingState {
  id: string;
  name: string;
  parentId: string | null;
}

interface CreatingState {
  direction: CategoryDirection;
  name: string;
  parentId: string | null;
}

export function CategoriesSection({ profileId }: { profileId: string }) {
  const [categories, setCategories] = useState<SettingsCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [confirmingArchivedId, setConfirmingArchivedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCategories([]);
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        const { data, error: fetchError } = await supabase
          .from('categories')
          .select('id, profile_id, direction, parent_id, display_name, source_name, normalized_name, status, canonical_path')
          .eq('profile_id', profileId);
        if (fetchError) throw fetchError;
        if (!cancelled) setCategories((data ?? []) as SettingsCategory[]);
      } catch {
        if (!cancelled) setError('Não foi possível carregar as categorias.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [profileId]);

  const refresh = async () => {
    setActionError(null);
    setBusyId(null);
    setEditing(null);
    setCreating(null);
    setConfirmingArchivedId(null);
    setLoading(true);
    try {
      const { data, error: fetchError } = await supabase
        .from('categories')
        .select('id, profile_id, direction, parent_id, display_name, source_name, normalized_name, status, canonical_path')
        .eq('profile_id', profileId);
      if (fetchError) throw fetchError;
      setCategories((data ?? []) as SettingsCategory[]);
    } catch {
      setActionError('Não foi possível atualizar a lista de categorias.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!creating || creating.name.trim() === '' || busyId) return;
    setBusyId('new');
    setActionError(null);
    const result = await createCategory(supabase as any, creating.name.trim(), creating.direction, creating.parentId);
    if (result.error) {
      setActionError(result.error);
      setBusyId(null);
      return;
    }
    await refresh();
  };

  const handleUpdate = async (id: string) => {
    if (!editing || editing.name.trim() === '' || busyId) return;
    const check = isParentAllowed(categories, id, editing.parentId);
    if (!check.ok) {
      setActionError(check.reason);
      return;
    }
    setBusyId(id);
    setActionError(null);
    const result = await updateCategory(supabase as any, id, editing.name.trim(), editing.parentId);
    if (result.error) {
      setActionError(result.error);
      setBusyId(null);
      return;
    }
    await refresh();
  };

  const handleArchive = async (id: string, archived: boolean) => {
    if (busyId) return;
    if (archived && hasActiveChildren(categories, id)) {
      setActionError('Esta categoria possui subcategorias ativas; trate-as primeiro.');
      return;
    }
    if (!archived) {
      const check = canReactivate(categories, id);
      if (!check.ok) {
        setActionError(check.reason);
        return;
      }
    }
    setBusyId(id);
    setActionError(null);
    const result = await setCategoryArchived(supabase as any, id, archived);
    if (result.error) {
      setActionError(result.error);
      setBusyId(null);
      return;
    }
    await refresh();
  };

  const parentOptions = (cat: SettingsCategory | null): { id: string; label: string }[] => {
    const direction: CategoryDirection = (cat?.direction ?? 'expense') === 'income' ? 'income' : 'expense';
    return filterCategoriesByProfileAndDirection(categories, profileId, direction)
      .filter((c) => {
        if (!cat) return true;
        if (c.id === cat.id) return false;
        const check = isParentAllowed(categories, cat.id, c.id);
        return check.ok;
      })
      .map((c) => ({ id: c.id, label: c.canonical_path || c.display_name }));
  };

  const renderNode = (node: CategoryNode, depth: number) => {
    const cat = node.cat;
    const status = categoryStatusLabel(cat.status);
    return (
      <li key={cat.id} className="settings-tree-item">
        <div className="settings-cat-row" style={{ paddingLeft: `${depth * 18}px` }}>
          <span className="settings-cat-label">
            {cat.display_name}
            {status && <span className="settings-status-badge">{status}</span>}
          </span>
          <span className="settings-account-actions">
            <button
              className="settings-btn settings-btn-sm"
              disabled={busyId !== null}
              onClick={() => { setEditing({ id: cat.id, name: cat.display_name, parentId: cat.parent_id }); setActionError(null); }}
            >
              Editar
            </button>
            {cat.status === 'active' ? (
              confirmingArchivedId === cat.id ? (
                <>
                  <button
                    className="settings-btn settings-btn-sm settings-btn-danger"
                    disabled={busyId !== null}
                    onClick={() => handleArchive(cat.id, true)}
                  >
                    Arquivar
                  </button>
                  <button className="settings-btn settings-btn-sm" onClick={() => setConfirmingArchivedId(null)}>Cancelar</button>
                </>
              ) : (
                <button className="settings-btn settings-btn-sm" onClick={() => { setConfirmingArchivedId(cat.id); setActionError(null); }}>
                  Arquivar
                </button>
              )
            ) : (
              <button className="settings-btn settings-btn-sm" disabled={busyId !== null} onClick={() => handleArchive(cat.id, false)}>
                Reativar
              </button>
            )}
            <button
              className="settings-btn settings-btn-sm"
              disabled={busyId !== null}
              onClick={() => { setCreating({ direction: cat.direction === 'income' ? 'income' : 'expense', name: '', parentId: cat.id }); setActionError(null); }}
            >
              Nova subcategoria
            </button>
          </span>
        </div>
        {editing && editing.id === cat.id && (
          <div className="settings-cat-edit" style={{ paddingLeft: `${depth * 18}px` }}>
            <input
              className="settings-input"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Nome da categoria"
            />
            <select
              className="settings-input"
              value={editing.parentId ?? ''}
              onChange={(e) => setEditing({ ...editing, parentId: e.target.value || null })}
            >
              <option value="">Sem categoria pai</option>
              {parentOptions(cat).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <button className="settings-btn settings-btn-sm" disabled={busyId !== null || editing.name.trim() === ''} onClick={() => handleUpdate(cat.id)}>
              Salvar
            </button>
            <button className="settings-btn settings-btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        )}
        {creating && creating.parentId === cat.id && (
          <div className="settings-cat-edit" style={{ paddingLeft: `${depth * 18}px` }}>
            <input
              className="settings-input"
              value={creating.name}
              onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              placeholder="Nome da subcategoria"
            />
            <button className="settings-btn settings-btn-sm" disabled={busyId !== null || creating.name.trim() === ''} onClick={handleCreate}>
              Adicionar
            </button>
            <button className="settings-btn settings-btn-sm" onClick={() => setCreating(null)}>Cancelar</button>
          </div>
        )}
        {node.children.length > 0 && <CategoryTreeView roots={node.children} depth={depth + 1} />}
      </li>
    );
  };

  const CategoryTreeView = ({ roots, depth }: { roots: CategoryNode[]; depth: number }) => {
    if (roots.length === 0) return null;
    return (
      <ul className="settings-tree">
        {roots.map((node) => renderNode(node, depth))}
      </ul>
    );
  };

  const groups = groupCategoriesByDirection(categories);

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Categorias e subcategorias</h2>
      {loading ? (
        <p className="settings-state">Carregando...</p>
      ) : error ? (
        <p className="settings-state settings-state-error">{error}</p>
      ) : (
        <>
          {categories.length === 0 ? (
            <p className="settings-state">Nenhuma categoria encontrada para este perfil.</p>
          ) : (
            groups.map((g) => {
              const direction: CategoryDirection = g.direction === 'income' ? 'income' : 'expense';
              return (
                <div key={g.direction} className="settings-dir-group">
                  <div className="settings-dir-head">
                    <h3 className="settings-dir-title">{categoryFriendlyDirection(direction)}</h3>
                    <button
                      className="settings-btn settings-btn-sm"
                      disabled={busyId !== null}
                      onClick={() => { setCreating({ direction, name: '', parentId: null }); setActionError(null); }}
                    >
                      Nova categoria
                    </button>
                  </div>
                  <CategoryTreeView roots={g.roots} depth={0} />
                  {creating && creating.parentId === null && creating.direction === direction && (
                    <div className="settings-cat-edit">
                      <input
                        className="settings-input"
                        value={creating.name}
                        onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                        placeholder="Nome da categoria"
                      />
                      <button className="settings-btn settings-btn-sm" disabled={busyId !== null || creating.name.trim() === ''} onClick={handleCreate}>
                        Adicionar
                      </button>
                      <button className="settings-btn settings-btn-sm" onClick={() => setCreating(null)}>Cancelar</button>
                    </div>
                  )}
                </div>
              );
            })
          )}
          {actionError && <p className="settings-state settings-state-error">{actionError}</p>}
          <p className="settings-hint">Arquivar uma categoria não apaga o histórico: os lançamentos anteriores permanecem.</p>
        </>
      )}
    </section>
  );
}