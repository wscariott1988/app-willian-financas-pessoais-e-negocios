import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { ClipboardList, RefreshCw } from 'lucide-react';

interface AuditLogEntry {
  id: string;
  transaction_id: string;
  queue_item_id: string | null;
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

interface Category {
  id: string;
  display_name: string;
  canonical_path: string | null;
}

interface AuditLogsProps {
  refreshTrigger: number;
  profileId: string;
}

export const AuditLogs: React.FC<AuditLogsProps> = ({ refreshTrigger, profileId }) => {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Load all categories for local mapping of category names
  const fetchAllCategories = async () => {
    try {
      const { data } = await supabase.from('categories').select('id, display_name, canonical_path');
      if (data) {
        const mapping: Record<string, string> = {};
        data.forEach((cat: any) => {
          mapping[cat.id] = cat.canonical_path || cat.display_name;
        });
        setCategories(mapping);
      }
    } catch (err) {
      console.error('Erro ao carregar categorias para mapeamento de logs:', err);
    }
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      // Query standard audit log joined with transactions, scoped to the profile
      const { data, error } = await supabase
        .from('category_assignment_audit')
        .select('*, transactions(raw_description, amount, transaction_kind)')
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;
      // A RLS (audit_select_own) já limita os logs ao perfil autenticado no servidor.
      setLogs(data || []);
    } catch (err) {
      console.error('Erro ao buscar logs de auditoria:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const initialize = async () => {
      await fetchAllCategories();
      await fetchLogs();
    };
    initialize();
  }, [refreshTrigger]);

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
    <div className="glass" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <ClipboardList size={18} style={{ color: 'var(--color-primary)' }} />
        <h3 style={{ fontSize: '15px', fontWeight: 800 }}>Logs Recentes de Auditoria</h3>
      </div>

      <div style={{ maxHeight: '350px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '20px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
            <RefreshCw size={16} className="spin-animation" />
            Carregando auditorias...
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px' }}>
            Nenhuma atribuição de auditoria registrada ainda.
          </div>
        ) : (
          logs.map((log) => (
            <div key={log.id} style={{
              backgroundColor: 'rgba(255,255,255,0.01)',
              border: '1px solid var(--border-card)',
              borderRadius: '8px',
              padding: '12px',
              fontSize: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              animation: 'fadeIn 0.2s ease'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span>{log.transactions?.raw_description || 'Transação'}</span>
                <span style={{ color: log.transactions?.transaction_kind === 'expense' ? 'var(--color-danger)' : 'var(--color-success)' }}>
                  {formatAmount(log.transactions?.amount, log.transactions?.transaction_kind)}
                </span>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', color: 'var(--color-text-muted)' }}>
                <span>De:</span>
                <span style={{ textDecoration: log.from_category_id ? 'line-through' : 'none', color: '#fff', fontWeight: 500 }}>
                  {log.from_category_id ? (categories[log.from_category_id] || 'Categoria Antiga') : 'Sem Categoria'}
                </span>
                <span style={{ margin: '0 4px' }}>→</span>
                <span>Para:</span>
                <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>
                  {categories[log.to_category_id] || 'Categoria Nova'}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                <span>Motivo: {log.reason}</span>
                <span>{formatDate(log.created_at)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
