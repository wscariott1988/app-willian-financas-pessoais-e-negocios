import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { ClipboardList, RefreshCw, AlertCircle, ChevronDown } from 'lucide-react';
import {
  type AuditEntry,
  type RawCatAudit,
  type RawTxAudit,
  computeFeed,
  formatAuditDate,
} from '../lib/auditFeed';

interface AuditLogsProps {
  refreshTrigger: number;
  profileId: string;
}

const PAGE_SIZE = 10;

export const AuditLogs: React.FC<AuditLogsProps> = ({ refreshTrigger, profileId }) => {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Feed restrito ao perfil ativo via RLS (profile_id = app.jwt_profile_id()).
  void profileId;

  const fetchAllCategories = useCallback(async () => {
    try {
      const { data } = await supabase.from('categories').select('id, display_name');
      if (data) {
        const mapping: Record<string, string> = {};
        data.forEach((cat: any) => {
          mapping[cat.id] = cat.display_name;
        });
        setCategories(mapping);
      }
    } catch {
      // Categories are optional enrichment; ignore failures silently
    }
  }, []);

  // Paginação CUMULATIVA: busca 10/20/30... registros de CADA fonte (0..size-1),
  // mescla, ordena estavelmente e exibe os primeiros `size`. Eventos com
  // created_at idêntico NÃO são pulados (recorte cumulativo, sem cursor lt).
  const loadPage = useCallback(async (targetSize: number) => {
    setLoading(true);
    setLoadingMore(false);
    setError(null);

    try {
      const txRes = await supabase
        .from('transaction_audit')
        .select('id, action, before_state, after_state, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(0, targetSize - 1);
      if (txRes.error) throw txRes.error;

      const catRes = await supabase
        .from('category_assignment_audit')
        .select('id, from_category_id, to_category_id, reason, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(0, targetSize - 1);
      if (catRes.error) throw catRes.error;

      const txRows = (txRes.data ?? []) as RawTxAudit[];
      const catRows = (catRes.data ?? []) as RawCatAudit[];
      const txTotal = txRes.count ?? txRows.length;
      const catTotal = catRes.count ?? catRows.length;

      const { entries, hasMore: more } = computeFeed(txRows, catRows, txTotal, catTotal, targetSize);
      setLogs(entries);
      setHasMore(more);
      setPageSize(targetSize);
    } catch (err: unknown) {
      if (import.meta.env.DEV) console.error('[Erro técnico auditoria]', err);
      setError('Não foi possível carregar o histórico de alterações. Tente novamente em instantes.');
      setLogs([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await fetchAllCategories();
      await loadPage(PAGE_SIZE);
    };
    init();
  }, [refreshTrigger, fetchAllCategories, loadPage]);

  const handleLoadMore = () => {
    if (loading || loadingMore) return;
    setLoadingMore(true);
    loadPage(pageSize + PAGE_SIZE);
  };

  const catName = (id: string | null): string => {
    if (!id) return 'Sem categoria';
    return categories[id] || 'Categoria';
  };

  return (
    <div className="settings-audit">
      <div className="settings-audit-header">
        <ClipboardList size={18} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
        <div>
          <h2 className="settings-audit-title">Histórico de alterações</h2>
          <p className="settings-audit-desc">
            Consulte as alterações realizadas nas suas transações e categorias.
          </p>
        </div>
      </div>

      <div className="settings-audit-list">
        {loading ? (
          <div className="settings-audit-state">
            <RefreshCw size={16} className="spin-animation" />
            <span>Carregando...</span>
          </div>
        ) : error ? (
          <div className="settings-audit-state settings-audit-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="settings-audit-state">
            <ClipboardList size={18} style={{ opacity: 0.4 }} />
            <span>Nenhuma alteração registrada.</span>
          </div>
        ) : (
          <>
            {logs.map((log) => (
              <div key={`${log.source}:${log.id}`} className="settings-audit-entry">
                <div className="settings-audit-entry-top">
                  <span className="settings-audit-entry-desc">
                    {log.source === 'tx' && log.description ? log.description : log.label}
                  </span>
                  {log.amountText ? (
                    <span
                      className="settings-audit-entry-amount"
                      style={{
                        color: log.kind === 'expense'
                          ? 'var(--color-danger)'
                          : log.kind === 'income'
                            ? 'var(--color-success)'
                            : undefined,
                      }}
                    >
                      {log.amountText}
                    </span>
                  ) : null}
                </div>

                <div className="settings-audit-entry-change">
                  {log.source === 'cat' ? (
                    <>
                      <span className="settings-audit-from">{catName(log.fromCat)}</span>
                      <span className="settings-audit-arrow">→</span>
                      <span className="settings-audit-to">{catName(log.toCat)}</span>
                    </>
                  ) : (
                    <span className="settings-audit-from">{log.label}</span>
                  )}
                </div>

                <div className="settings-audit-entry-footer">
                  {log.source === 'cat' && log.reason && <span>Motivo: {log.reason}</span>}
                  <span>{formatAuditDate(log.created_at)}</span>
                </div>
              </div>
            ))}

            {hasMore && (
              <button
                type="button"
                className="settings-audit-load-more"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <RefreshCw size={14} className="spin-animation" />
                ) : (
                  <ChevronDown size={14} />
                )}
                {loadingMore ? 'Carregando...' : 'Carregar mais'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
