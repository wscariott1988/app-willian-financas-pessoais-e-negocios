import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import {
  computeFeed,
  formatDateTime,
  type AuditEntry,
  type CatAuditRow,
  type SettingsAuditRow,
  type TxAuditRow,
} from '../lib/auditFeed';

const PAGE_SIZE = 10;

type HistoryFilter = 'all' | 'transactions' | 'accounts' | 'categories';

export function HistorySection({ profileId }: { profileId: string }) {
  const [txRows, setTxRows] = useState<TxAuditRow[]>([]);
  const [catRows, setCatRows] = useState<CatAuditRow[]>([]);
  const [settingsRows, setSettingsRows] = useState<SettingsAuditRow[]>([]);
  const [catNames, setCatNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTxRows([]);
    setCatRows([]);
    setSettingsRows([]);
    setCatNames({});
    setLoaded(PAGE_SIZE);
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        const [txRes, catRes, setRes, catMeta] = await Promise.all([
          supabase
            .from('transaction_audit')
            .select('id, action, before_state, after_state, created_at')
            .eq('profile_id', profileId)
            .order('created_at', { ascending: false })
            .limit(loaded),
          supabase
            .from('category_assignment_audit')
            .select('id, from_category_id, to_category_id, reason, created_at')
            .eq('profile_id', profileId)
            .order('created_at', { ascending: false })
            .limit(loaded),
          supabase
            .from('settings_audit')
            .select('id, entity_type, entity_id, action, before_state, after_state, created_at')
            .eq('profile_id', profileId)
            .order('created_at', { ascending: false })
            .limit(loaded),
          supabase.from('categories').select('id, display_name').eq('profile_id', profileId),
        ]);
        if (txRes.error) throw txRes.error;
        if (catRes.error) throw catRes.error;
        if (setRes.error) throw setRes.error;
        if (catMeta.error) throw catMeta.error;
        if (cancelled) return;
        setTxRows((txRes.data ?? []) as TxAuditRow[]);
        setCatRows((catRes.data ?? []) as CatAuditRow[]);
        setSettingsRows((setRes.data ?? []) as SettingsAuditRow[]);
        const names: Record<string, string> = {};
        for (const c of (catMeta.data ?? []) as { id: string; display_name: string }[]) {
          names[c.id] = c.display_name;
        }
        setCatNames(names);
      } catch {
        if (!cancelled) setError('Não foi possível carregar o histórico.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [profileId, loaded]);

  const allEntries = useCallback((): AuditEntry[] => {
    const feed = computeFeed(
      { tx: txRows, cat: catRows, settings: settingsRows },
      catNames,
      Math.max(loaded, txRows.length + catRows.length + settingsRows.length),
    );
    return feed.entries;
  }, [txRows, catRows, settingsRows, catNames, loaded]);

  const entries = allEntries().filter((e) => {
    if (filter === 'transactions') return e.source === 'transaction';
    if (filter === 'accounts') return e.source === 'settings' && e.title.includes('Conta');
    if (filter === 'categories') return e.source === 'category' || (e.source === 'settings' && e.title.includes('Categoria'));
    return true;
  });

  const hasMore = (): boolean => {
    if (filter === 'transactions') return txRows.length >= loaded;
    if (filter === 'accounts') return settingsRows.length >= loaded;
    if (filter === 'categories') return catRows.length + settingsRows.length >= loaded;
    return txRows.length >= loaded || catRows.length >= loaded || settingsRows.length >= loaded;
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Histórico</h2>
      {loading ? (
        <p className="settings-state">Carregando...</p>
      ) : error ? (
        <p className="settings-state settings-state-error">{error}</p>
      ) : entries.length === 0 ? (
        <p className="settings-state">Nenhum evento de histórico registrado.</p>
      ) : (
        <>
          <div className="settings-history-filters">
            <select
              className="settings-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value as HistoryFilter)}
            >
              <option value="all">Todos</option>
              <option value="transactions">Transações</option>
              <option value="accounts">Contas</option>
              <option value="categories">Categorias</option>
            </select>
          </div>
          <ul className="settings-list settings-history-list">
            {entries.slice(0, loaded).map((e) => (
              <li key={`${e.source}:${e.id}`} className="settings-item settings-history-row">
                <div className="settings-history-main">
                  <span className="settings-history-title">{e.title}</span>
                  {e.detail && <span className="settings-history-detail">{e.detail}</span>}
                </div>
                <span className="settings-history-date">{formatDateTime(e.created_at)}</span>
              </li>
            ))}
          </ul>
          {hasMore() && (
            <button className="settings-btn" onClick={() => setLoaded((n) => n + PAGE_SIZE)}>
              Carregar mais
            </button>
          )}
        </>
      )}
    </section>
  );
}