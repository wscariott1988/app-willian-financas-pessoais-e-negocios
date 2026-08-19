import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { ClipboardList, RefreshCw, AlertCircle, ChevronDown } from 'lucide-react';

interface AuditLogEntry {
  id: string;
  from_category_id: string | null;
  to_category_id: string;
  reason: string | null;
  created_at: string;
  transactions: {
    raw_description: string;
    amount: string;
    transaction_kind: string;
  } | null;
}

interface AuditLogsProps {
  refreshTrigger: number;
  profileId: string;
}

const PAGE_SIZE = 10;

export const AuditLogs: React.FC<AuditLogsProps> = ({ refreshTrigger, profileId }) => {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

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

  const fetchLogs = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);

    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('category_assignment_audit')
        .select('id, from_category_id, to_category_id, reason, created_at, transactions(raw_description, amount, transaction_kind)')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (fetchError) throw fetchError;

      const rows = (data ?? []) as unknown as AuditLogEntry[];
      setLogs((prev) => append ? [...prev, ...rows] : rows);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (err: unknown) {
      if (import.meta.env.DEV) console.error('[Erro técnico auditoria]', err);
      setError('Não foi possível carregar o histórico de alterações. Tente novamente em instantes.');
      if (!append) setLogs([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await fetchAllCategories();
      await fetchLogs(0, false);
    };
    init();
  }, [refreshTrigger, fetchAllCategories, fetchLogs]);

  const handleLoadMore = () => {
    fetchLogs(logs.length, true);
  };

  const formatAmount = (val?: string, kind?: string) => {
    if (!val) return '';
    const num = parseFloat(val);
    const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
    return `${prefix} R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleString('pt-BR');
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
              <div key={log.id} className="settings-audit-entry">
                <div className="settings-audit-entry-top">
                  <span className="settings-audit-entry-desc">
                    {log.transactions?.raw_description || 'Transação'}
                  </span>
                  <span
                    className="settings-audit-entry-amount"
                    style={{
                      color: log.transactions?.transaction_kind === 'expense'
                        ? 'var(--color-danger)'
                        : 'var(--color-success)',
                    }}
                  >
                    {formatAmount(log.transactions?.amount, log.transactions?.transaction_kind)}
                  </span>
                </div>

                <div className="settings-audit-entry-change">
                  <span className="settings-audit-from">
                    {log.from_category_id ? (categories[log.from_category_id] || 'Categoria anterior') : 'Sem categoria'}
                  </span>
                  <span className="settings-audit-arrow">→</span>
                  <span className="settings-audit-to">
                    {categories[log.to_category_id] || 'Categoria nova'}
                  </span>
                </div>

                <div className="settings-audit-entry-footer">
                  {log.reason && <span>Motivo: {log.reason}</span>}
                  <span>{formatDate(log.created_at)}</span>
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
