import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { Check, Info, AlertCircle, Tag, RefreshCw, X, ShieldAlert } from 'lucide-react';
import { buildCategoryQuery } from '../lib/categoryQuery';

interface Transaction {
  id: string;
  profile_id: string;
  account_id: string;
  category_id: string | null;
  transaction_kind: 'income' | 'expense' | 'transfer';
  amount: string;
  occurred_on: string;
  raw_description: string;
  normalized_description: string;
  category_raw: string | null;
  status: 'posted' | 'pending' | 'review' | 'scheduled' | 'ignored';
  categories: { display_name: string } | null;
  accounts: { display_name: string } | null;
}

interface Category {
  id: string;
  profile_id: string;
  direction: 'income' | 'expense' | 'transfer';
  display_name: string;
  canonical_path: string | null;
  parent_id: string | null;
  status: 'active' | 'archived' | 'review';
}

interface CategorizerPanelProps {
  transaction: Transaction | null;
  onSuccess: () => void;
  onClose?: () => void;
  activeProfileId?: string | null;
}

export const CategorizerPanel: React.FC<CategorizerPanelProps> = ({
  transaction,
  onSuccess,
  onClose,
  activeProfileId = null,
}) => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingCats, setLoadingCats] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Isolamento: perfil ativo autorizado da sessão precisa existir e ser o
  // mesmo da transação selecionada. Caso contrário, falha fechado (sem consulta).
  const profileBlocked =
    !!transaction &&
    (!activeProfileId || !transaction.profile_id || activeProfileId !== transaction.profile_id);

  // Fetch compatible categories when transaction changes
  useEffect(() => {
    setError(null);
    setSuccessMsg(null);
    setSelectedCategoryId('');
    // descarta categorias anteriores imediatamente (nunca exibir resultados velhos)
    setCategories([]);

    if (!transaction) return;

    if (!activeProfileId || !transaction.profile_id || activeProfileId !== transaction.profile_id) {
      if (import.meta.env.DEV) {
        console.error(
          '[CategorizerPanel] perfil divergente: active=',
          activeProfileId,
          'tx=',
          transaction.profile_id,
        );
      }
      return;
    }

    if (transaction.transaction_kind === 'transfer') {
      return;
    }

    const fetchCategories = async () => {
      setLoadingCats(true);
      try {
        const { data, error: catError } = await buildCategoryQuery(supabase as any, {
          profileId: activeProfileId,
          direction: transaction.transaction_kind,
          status: 'active',
        });

        if (catError) throw catError;

        // Sort categories by canonical_path or display_name
        const sorted = (data || []).sort((a: any, b: any) => {
          const pathA = a.canonical_path || a.display_name;
          const pathB = b.canonical_path || b.display_name;
          return pathA.localeCompare(pathB);
        });

        setCategories(sorted);
      } catch (err: any) {
        console.error('Erro ao carregar categorias:', err);
        setError('Não foi possível carregar as categorias. Tente novamente.');
      } finally {
        setLoadingCats(false);
      }
    };

    fetchCategories();
  }, [transaction, activeProfileId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transaction || !selectedCategoryId) return;

    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      // Call standard rpc assign_category_atomic(p_transaction_id, p_category_id, p_profile_id)
      // Note: in our gateway, the third parameter p_profile_id is derived from claims automatically in gateway.mjs,
      // but let's send what the gateway expects. In gateway.mjs handleRpc:
      // p_transaction_id and p_category_id are read from body. p_profile_id is passed to SQL using claims.profile_id!
      const { data, error: rpcError } = await supabase.rpc('assign_category_atomic', {
        p_transaction_id: transaction.id,
        p_category_id: selectedCategoryId
      });

      if (rpcError) throw rpcError;

      setSuccessMsg('Categoria atribuída com sucesso! Fila encerrada e log de auditoria criado.');
      setSelectedCategoryId('');
      
      // Delay callback to show success state briefly
      setTimeout(() => {
        onSuccess();
        setSuccessMsg(null);
      }, 1500);

    } catch (err: any) {
      console.error('Erro no RPC assign_category_atomic:', err);
      setError('Não foi possível alterar a categoria. Tente novamente em instantes.');
    } finally {
      setLoading(false);
    }
  };

  if (!transaction) {
    return (
      <div className="glass" style={{
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--color-text-muted)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: '300px',
        position: 'relative'
      }}>
        {onClose && (
          <button
            type="button"
            className="categorizer-close"
            style={{ position: 'absolute', top: '12px', right: '12px' }}
            onClick={onClose}
            aria-label="Fechar painel de recategorização"
            title="Fechar"
          >
            <X size={18} />
          </button>
        )}
        <Tag size={40} style={{ opacity: 0.3, marginBottom: '16px' }} />
        <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'white', marginBottom: '8px' }}>
          Nenhuma transação selecionada
        </h3>
        <p style={{ fontSize: '13px', maxWidth: '280px' }}>
          Selecione uma transação na lista para analisar e atribuir a categoria correspondente.
        </p>
      </div>
    );
  }

  const isTransfer = transaction.transaction_kind === 'transfer';
  const formatAmount = (val: string) => {
    const num = parseFloat(val);
    return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="glass" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
        <div>
          <h3 style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '-0.01em', marginBottom: '4px' }}>
            Alterar categoria
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Escolha a categoria correta para esta transação
          </p>
        </div>

        {onClose && (
          <button
            type="button"
            className="categorizer-close"
            onClick={onClose}
            aria-label="Fechar painel de recategorização"
            title="Fechar"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Perfil ausente ou divergente: falha fechada, sem consulta de categorias */}
      {profileBlocked && (
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.25)',
          color: 'var(--color-warning)',
          padding: '12px 16px',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: 600,
          lineHeight: 1.4,
        }}>
          <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>Não foi possível identificar o perfil ativo. Entre novamente.</span>
        </div>
      )}

      {!profileBlocked && (<>
      {/* Transaction Details Card */}
      <div style={{
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-card)',
        borderRadius: '12px',
        padding: '16px',
        fontSize: '13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Descrição</span>
          <strong style={{ color: '#fff', fontSize: '14px' }}>{transaction.raw_description}</strong>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Valor</span>
          <strong style={{ 
            color: transaction.transaction_kind === 'expense' ? 'var(--color-danger)' : 'var(--color-success)',
            fontSize: '15px'
          }}>
            {transaction.transaction_kind === 'expense' ? '-' : '+'} {formatAmount(transaction.amount)}
          </strong>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Categoria informada</span>
          <span style={{
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            padding: '3px 8px',
            borderRadius: '4px',
            fontWeight: 600,
            color: 'var(--color-text-muted)'
          }}>
            {transaction.category_raw || 'Não informada'}
          </span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Tipo</span>
          <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>
            {transaction.transaction_kind === 'expense' ? 'Despesa' : transaction.transaction_kind === 'income' ? 'Receita' : 'Transferência'}
          </span>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: 'var(--color-danger)',
          padding: '12px 16px',
          borderRadius: '8px',
          fontSize: '13px',
          display: 'flex',
          gap: '8px',
          alignItems: 'center'
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          border: '1px solid rgba(16, 185, 129, 0.2)',
          color: 'var(--color-success)',
          padding: '12px 16px',
          borderRadius: '8px',
          fontSize: '13px',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          animation: 'fadeIn 0.3s ease'
        }}>
          <Check size={16} style={{ flexShrink: 0 }} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Categorization Form */}
      {isTransfer ? (
        <div style={{
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.15)',
          borderRadius: '8px',
          padding: '14px 16px',
          color: 'var(--color-secondary)',
          fontSize: '13px',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-start',
          lineHeight: 1.4
        }}>
          <Info size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong>Transferência identificada.</strong> Transações do tipo transferência não recebem categoria canônica e são liquidadas de forma separada na reconciliação.
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '13px', fontWeight: 700 }}>
              Selecione a categoria
            </label>
            
            {loadingCats ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                <RefreshCw size={16} className="spin-animation" />
                Carregando categorias compatíveis...
              </div>
            ) : (
              <div style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid var(--border-card)', borderRadius: '8px' }}>
                {categories.length === 0 ? (
                  <div style={{ padding: '14px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                    Nenhuma categoria ativa compatível com este tipo de transação.
                  </div>
                ) : (
                  categories.map((cat) => {
                    const path = cat.canonical_path || cat.display_name;
                    const depth = path.split(' / ').length - 1;
                    return (
                      <div
                        key={cat.id}
                        onClick={() => { setSelectedCategoryId(cat.id); setError(null); setSuccessMsg(null); }}
                        style={{
                          padding: '9px 12px',
                          paddingLeft: `${12 + depth * 18}px`,
                          cursor: 'pointer',
                          fontSize: '13px',
                          fontWeight: selectedCategoryId === cat.id ? 700 : 500,
                          color: selectedCategoryId === cat.id ? 'var(--color-primary)' : '#f8fafc',
                          backgroundColor: selectedCategoryId === cat.id ? 'rgba(99, 102, 241, 0.12)' : 'transparent',
                          borderLeft: selectedCategoryId === cat.id ? `3px solid var(--color-primary)` : '3px solid transparent',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => { if (selectedCategoryId !== cat.id) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(255,255,255,0.04)'; }}
                        onMouseLeave={(e) => { if (selectedCategoryId !== cat.id) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
                      >
                        {path}
                      </div>
                    );
                  })
                )}
              </div>
            )}
            
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
              Mostrando apenas categorias ativas compatíveis com o perfil e a direção de <strong>{transaction.transaction_kind === 'expense' ? 'saída' : 'entrada'}</strong>.
            </span>
          </div>

          <div style={{ marginTop: 'auto', paddingTop: '20px' }}>
            <button
              type="submit"
              className="btn-primary categorizer-submit"
              style={{ width: '100%', padding: '12px' }}
              disabled={!selectedCategoryId || loading || !!successMsg || profileBlocked}
            >
              {loading ? (
                <>
                  <RefreshCw size={16} className="spin-animation" />
                  Salvando...
                </>
              ) : (
                <>
                  <Check size={16} />
                  Alterar categoria
                </>
              )}
            </button>
          </div>
        </form>
      )}
      </>)}
    </div>
  );
};
