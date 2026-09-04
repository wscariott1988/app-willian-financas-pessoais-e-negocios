import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import {
  computeFeed,
  filterHistoryEntries,
  formatDateTime,
  hasFilteredHistoryMore,
  type AuditEntry,
  type CatAuditRow,
  type HistoryFilter,
  type SettingsAuditRow,
  type TxAuditRow,
} from '../lib/auditFeed';

const PAGE_SIZE = 10;

export function HistorySection({ profileId }: { profileId: string }) {
  const [txRows, setTxRows] = useState<TxAuditRow[]>([]);
  const [catRows, setCatRows] = useState<CatAuditRow[]>([]);
  const [settingsRows, setSettingsRows] = useState<SettingsAuditRow[]>([]);
  const [catNames, setCatNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const profileRef = useRef(profileId);

  useEffect(() => {
    let cancelled = false;
    if (profileRef.current !== profileId) {
      profileRef.current = profileId;
      setLoaded(PAGE_SIZE);
    }
    setTxRows([]);
    setCatRows([]);
    setSettingsRows([]);
    setCatNames({});
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
            .limit(loaded + 1),
          supabase
            .from('category_assignment_audit')
            .select('id, from_category_id, to_category_id, reason, created_at')
            .eq('profile_id', profileId)
            .order('created_at', { ascending: false })
            .limit(loaded + 1),
          supabase
            .from('settings_audit')
            .select('id, entity_type, entity_id, action, before_state, after_state, created_at')
            .eq('profile_id', profileId)
            .order('created_at', { ascending: false })
            .limit(loaded + 1),
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

  const entries = filterHistoryEntries(allEntries(), filter);

  // U-02: cada fonte é buscada com .limit(loaded + 1) — uma linha "sonda" além
  // da página exibida. Assim o feed JÁ contém (quando existir) a próxima
  // entrada do filtro ativo, e hasMore deriva do conjunto JÁ filtrado/em mãos,
  // nunca de contagens cruas por fonte nem de página anterior. Com o filtro
  // "Contas", "Carregar mais" só aparece quando há de fato mais uma entrada de
  // conta do que as exibidas — não por haver categorias/transações carregadas
  // por baixo dos panos — e clicar sempre revela algo novo (nada de página
  // enganosa). O clique aumenta `loaded`; o efeito refaz o fetch com o novo
  // limite (loaded NÃO é travado de volta em PAGE_SIZE no reload).
  const hasMore = hasFilteredHistoryMore(entries, loaded);

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
              onChange={(e) => { setFilter(e.target.value as HistoryFilter); setLoaded(PAGE_SIZE); }}
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
          {hasMore && (
            <button className="settings-btn" onClick={() => setLoaded((n) => n + PAGE_SIZE)}>
              Carregar mais
            </button>
          )}
        </>
      )}
    </section>
  );
}