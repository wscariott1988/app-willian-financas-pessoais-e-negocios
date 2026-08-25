import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { buildAccountQuery, mapAccountPeriods, type AccountPeriodRow, type ProfileAccount } from '../lib/accountQuery';

interface SettingsViewProps {
  profileId: string;
  refreshTrigger?: number;
}

// ---------- Helpers puros (testáveis) ----------

export interface SettingsCategory {
  id: string;
  profile_id: string;
  direction: 'income' | 'expense' | 'transfer';
  parent_id: string | null;
  display_name: string;
  source_name: string | null;
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

// STATUS-P0: códigos técnicos de categoria nunca aparecem na UI; somente labels
// amigáveis em português. Valores de dados (status/direction/hierarchy) inalterados.
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

// ---------- Seção Contas (read-only) ----------

function AccountsSection({ profileId }: { profileId: string }) {
  const [accounts, setAccounts] = useState<ProfileAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAccounts([]);
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        const { data, error: fetchError } = await buildAccountQuery(supabase as any, profileId);
        if (fetchError) throw fetchError;
        if (!cancelled) setAccounts(mapAccountPeriods((data ?? []) as AccountPeriodRow[]));
      } catch {
        if (!cancelled) setError('Não foi possível carregar as contas.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [profileId]);

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Contas</h2>
      {loading ? (
        <p className="settings-state">Carregando...</p>
      ) : error ? (
        <p className="settings-state settings-state-error">{error}</p>
      ) : accounts.length === 0 ? (
        <p className="settings-state">Nenhuma conta encontrada para este perfil.</p>
      ) : (
        <ul className="settings-list">
          {accounts.map((a) => (
            <li key={a.id} className="settings-item">{a.display_name}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- Seção Categorias e subcategorias (read-only) ----------

function CategoryTreeView({ roots }: { roots: CategoryNode[] }) {
  if (roots.length === 0) return null;
  return (
    <ul className="settings-tree">
      {roots.map((node) => (
        <li key={node.cat.id} className="settings-tree-item">
          <span className="settings-tree-label">
            {node.cat.display_name}
            {categoryStatusLabel(node.cat.status) && (
              <span className="settings-status-badge">{categoryStatusLabel(node.cat.status)}</span>
            )}
          </span>
          {node.children.length > 0 && <CategoryTreeView roots={node.children} />}
        </li>
      ))}
    </ul>
  );
}

function CategoriesSection({ profileId }: { profileId: string }) {
  const [categories, setCategories] = useState<SettingsCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCategories([]);
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        const { data, error: fetchError } = await supabase
          .from('categories')
          .select('id, profile_id, direction, parent_id, display_name, source_name, canonical_path, status')
          .eq('profile_id', profileId)
          .order('canonical_path', { ascending: true });
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

  const groups = groupCategoriesByDirection(categories);

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Categorias e subcategorias</h2>
      {loading ? (
        <p className="settings-state">Carregando...</p>
      ) : error ? (
        <p className="settings-state settings-state-error">{error}</p>
      ) : categories.length === 0 ? (
        <p className="settings-state">Nenhuma categoria encontrada para este perfil.</p>
      ) : (
        groups.map((g) => (
          <div key={g.direction} className="settings-dir-group">
            <h3 className="settings-dir-title">{g.label}</h3>
            <CategoryTreeView roots={g.roots} />
          </div>
        ))
      )}
    </section>
  );
}

// ---------- View principal ----------

export const SettingsView: React.FC<SettingsViewProps> = ({ profileId }) => {
  return (
    <div className="settings-view">
      <div className="settings-view-header">
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
          Configurações
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
          Contas, categorias e preferências do perfil ativo
        </p>
      </div>
      <AccountsSection profileId={profileId} />
      <CategoriesSection profileId={profileId} />
    </div>
  );
};
