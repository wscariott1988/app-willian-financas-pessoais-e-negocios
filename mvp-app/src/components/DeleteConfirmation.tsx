import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { Trash2, AlertCircle, RefreshCw, ArrowLeftRight } from 'lucide-react';
import { formatAmountForInput } from './TransactionEditor';
import { accountDisplayLabel } from '../lib/accountCrud';
import { SERIES_SCOPE_LABELS, type SeriesScope } from '../lib/series';
import {
  buildSeriesDeleteArgs,
  buildImpactArgs,
  normalizeSeriesImpact,
  requiredConfirms,
  confirmsSatisfied,
  impactSummaryLines,
  impactWarnings,
  type SeriesEditInfoLike,
  type SeriesScopeImpact,
} from '../lib/seriesScope';

const RPC_TIMEOUT_MS = 15000;

export interface DeleteTarget {
  id: string;
  raw_description: string;
  occurred_on: string;
  amount: string;
  transaction_kind: string;
  accounts?: { display_name: string } | null;
  account_id: string;
}

interface DeleteConfirmationProps {
  transaction: DeleteTarget;
  onClose: () => void;
  onSuccess: () => void;
}

export function formatTxDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('T')[0].split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatTxCurrency(val: string, kind: string): string {
  const num = parseFloat(val);
  const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
  return `${prefix} R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const DeleteConfirmation: React.FC<DeleteConfirmationProps> = ({
  transaction: tx,
  onClose,
  onSuccess,
}) => {
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);
  const [isTransfer, setIsTransfer] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const mounted = useRef(true);
  const [retryKey, setRetryKey] = useState(0);
  // PESSOAL-13C4A-E10B: escopo de série também na exclusão.
  const [seriesInfo, setSeriesInfo] = useState<SeriesEditInfoLike | null>(null);
  const [seriesScope, setSeriesScope] = useState<SeriesScope>('this');
  const [impact, setImpact] = useState<SeriesScopeImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [confirms, setConfirms] = useState({ past: false, posted: false, edited: false });

  const activeScope: SeriesScope = seriesInfo ? seriesScope : 'this';
  const collectiveScope = !!seriesInfo && seriesScope !== 'this';
  const impactRequired = requiredConfirms(impact);
  const impactReady = confirmsSatisfied(impact, confirms);
  const deleteBlocked = collectiveScope && !impactReady;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setLoadingDetail(true);
    setError(null);
    setLoadFailed(false);

    const load = async () => {
      try {
        const rpcPromise = supabase.rpc('transaction_get_detail', {
          transaction_id: tx.id,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            ac.abort();
            reject(new Error('Tempo limite ao carregar detalhes da transação.'));
          }, RPC_TIMEOUT_MS);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);
        const { data, error: rpcError } = result as { data: any; error: any };

        if (rpcError) throw rpcError;
        if (disposed) return;
        if (!data?.transaction) return;

        if (mounted.current) {
          setExpectedUpdatedAt(data.transaction.updated_at || null);
          setIsTransfer(data.transaction.transaction_kind === 'transfer' && !!data.transfer);
        }
      } catch (err: any) {
        if (disposed) return;
        console.error('Erro ao carregar detalhe para exclusao:', err);
        if (mounted.current) {
          setError(err.message || 'Falha ao carregar detalhes da transação.');
          setLoadFailed(true);
        }
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (!disposed && mounted.current) setLoadingDetail(false);
      }
    };
    load();
    return () => {
      disposed = true;
      ac.abort();
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [tx.id, retryKey]);

  // PESSOAL-13C4A-E10B: detecta a série da transação e carrega a prévia de
  // impacto. Falha aqui NÃO impede excluir a transação isolada ('this').
  useEffect(() => {
    let active = true;
    const ac = new AbortController();
    supabase
      .from('transaction_series_occurrences')
      .select('series_id, occurrence_index, transaction_series(kind, updated_at)')
      .eq('transaction_id', tx.id)
      .abortSignal(ac.signal)
      .maybeSingle()
      .then(({ data, error: occErr }: any) => {
        if (!active || occErr || !data?.series_id) {
          if (active) setSeriesInfo(null);
          return;
        }
        const ser = Array.isArray(data.transaction_series) ? data.transaction_series[0] : data.transaction_series;
        if (active) {
          setSeriesInfo({
            series_id: data.series_id,
            occurrence_index: data.occurrence_index,
            total: null,
            kind: ser?.kind ?? 'recurring',
            series_updated_at: ser?.updated_at ?? null,
          } as SeriesEditInfoLike);
        }
      }, () => {
        if (active) setSeriesInfo(null);
      });
    return () => {
      active = false;
      ac.abort();
    };
  }, [tx.id]);

  // PESSOAL-13C4A-E10B: prévia de impacto por escopo (somente leitura)
  useEffect(() => {
    if (!seriesInfo) {
      setImpact(null);
      return;
    }
    let active = true;
    setImpactLoading(true);
    setConfirms({ past: false, posted: false, edited: false });
    supabase
      .rpc('series_scope_impact', buildImpactArgs(seriesInfo.series_id, seriesScope, seriesInfo.occurrence_index))
      .then(({ data, error: rpcError }: any) => {
        if (!active) return;
        setImpactLoading(false);
        setImpact(rpcError ? null : normalizeSeriesImpact(data));
      }, () => {
        if (!active) return;
        setImpactLoading(false);
        setImpact(null);
      });
    return () => {
      active = false;
    };
  }, [seriesInfo, seriesScope]);

  const handleRetry = useCallback(() => {
    setExpectedUpdatedAt(null);
    setIsTransfer(false);
    setLoadFailed(false);
    setError(null);
    setRetryKey((k) => k + 1);
  }, []);

  const handleConfirm = async () => {
    if (!expectedUpdatedAt) return;
    if (deleteBlocked) return;
    setDeleting(true);
    setError(null);
    try {
      // PESSOAL-13C4A-E10B: transação de série exclusa pelo escopo escolhido.
      const { error: rpcError } = seriesInfo
        ? await supabase.rpc('transaction_series_delete', {
            ...buildSeriesDeleteArgs(
              seriesInfo,
              activeScope,
              expectedUpdatedAt,
              seriesInfo.series_updated_at ?? null,
              confirms,
            ),
          })
        : await supabase.rpc('transaction_delete', {
            p_transaction_id: tx.id,
            p_expected_updated_at: expectedUpdatedAt,
          });
      if (rpcError) {
        const msg = String(rpcError.message || rpcError);
        if (msg.includes('CONFLITO')) {
          setError('Conflito: a transacao foi modificada por outra operacao. Recarregue a lista e tente novamente.');
        } else {
          setError(msg || 'Erro ao excluir a transacao.');
        }
        if (mounted.current) setDeleting(false);
        return;
      }
      if (mounted.current) onSuccess();
    } catch (err: any) {
      console.error('Erro ao excluir transacao:', err);
      if (mounted.current) {
        setError(String(err.message || 'Erro ao excluir a transacao.'));
        setDeleting(false);
      }
    }
  };

  const accountName = accountDisplayLabel(tx.accounts);

  return (
    <div className="glass" style={{ padding: 'clamp(16px, 4vw, 24px)', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '480px', width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: '40px', height: '40px', borderRadius: '10px', backgroundColor: 'rgba(239, 68, 68, 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Trash2 size={20} style={{ color: 'var(--color-danger)' }} />
        </div>
        <div>
          <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>Excluir transacao</h3>
          <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: 0 }}>
            A exclusao e logica e pode ser revertida.
          </p>
        </div>
      </div>

      {error && loadFailed && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: 'var(--color-danger)',
          padding: '12px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4 }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleRetry}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '13px', alignSelf: 'flex-start' }}
          >
            <RefreshCw size={14} /> Tentar novamente
          </button>
        </div>
      )}

      {error && !loadFailed && !loadingDetail && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: 'var(--color-danger)',
          padding: '12px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{error}</span>
        </div>
      )}

      {loadingDetail ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
          <RefreshCw size={16} className="spin-animation" />
          Carregando detalhes...
        </div>
      ) : !loadFailed ? (
        <div style={{
          backgroundColor: 'rgba(13, 18, 34, 0.6)',
          border: '1px solid var(--border-card)',
          borderRadius: '8px', padding: '14px',
          fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', minWidth: 0 }}>
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Descricao</span>
            <span style={{ fontWeight: 600, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{tx.raw_description}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', minWidth: 0 }}>
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Data</span>
            <span style={{ fontWeight: 600, textAlign: 'right', minWidth: 0 }}>{formatTxDate(tx.occurred_on)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', minWidth: 0 }}>
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Valor</span>
            <span style={{ fontWeight: 700, textAlign: 'right', minWidth: 0 }}>{formatTxCurrency(tx.amount, tx.transaction_kind)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', minWidth: 0 }}>
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>Conta</span>
            <span style={{ fontWeight: 600, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{accountName}</span>
          </div>
        </div>
      ) : null}

      {isTransfer && (
        <div style={{
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.15)',
          borderRadius: '8px', padding: '12px 14px',
          color: 'var(--color-secondary)', fontSize: '12px',
          display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
        }}>
          <ArrowLeftRight size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>Transferencia: ambas as pontas (saida e entrada) e o vinculo serao excluidos.</span>
        </div>
      )}

      {seriesInfo && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{
            backgroundColor: 'rgba(6, 182, 212, 0.08)',
            border: '1px solid rgba(6, 182, 212, 0.15)',
            borderRadius: '8px', padding: '12px 14px', fontSize: '12px',
            display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            <span style={{ color: 'var(--color-secondary)', fontWeight: 600 }}>
              Este lançamento pertence a uma série. Escolha o escopo da exclusão:
            </span>
            <select
              data-testid="delete-series-scope"
              value={seriesScope}
              onChange={(e) => setSeriesScope(e.target.value as SeriesScope)}
              style={{ width: '100%' }}
            >
              {Object.entries(SERIES_SCOPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <span style={{ color: 'var(--color-secondary)' }}>
              A exclusão é lógica (soft delete) e pode ser revertida. Nada é apagado em definitivo.
            </span>
          </div>

          {(impactLoading || impact) && (
            <div
              data-testid="delete-series-impact"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '8px', padding: '10px 12px', fontSize: '12px',
                display: 'flex', flexDirection: 'column', gap: '4px',
                color: 'var(--color-danger)',
              }}
            >
              {impactLoading && <span>Calculando impacto…</span>}
              {impact && impactSummaryLines(impact, 'delete').map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          )}

          {collectiveScope && impactWarnings(impact, 'delete').map((w) => (
            <span key={w} style={{ fontSize: '12px', color: 'var(--color-warning)' }}>{w}</span>
          ))}

          {collectiveScope && impactRequired.past && (
            <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--color-warning)', cursor: 'pointer' }}>
              <input type="checkbox" checked={confirms.past} onChange={(e) => setConfirms((c) => ({ ...c, past: e.target.checked }))} style={{ marginTop: '1px' }} />
              <span>Confirmo que desejo excluir também ocorrências passadas.</span>
            </label>
          )}
          {collectiveScope && impactRequired.posted && (
            <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--color-warning)', cursor: 'pointer' }}>
              <input type="checkbox" checked={confirms.posted} onChange={(e) => setConfirms((c) => ({ ...c, posted: e.target.checked }))} style={{ marginTop: '1px' }} />
              <span>Confirmo que desejo excluir também ocorrências com status posted.</span>
            </label>
          )}
          {collectiveScope && impactRequired.edited && (
            <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--color-warning)', cursor: 'pointer' }}>
              <input type="checkbox" checked={confirms.edited} onChange={(e) => setConfirms((c) => ({ ...c, edited: e.target.checked }))} style={{ marginTop: '1px' }} />
              <span>Confirmo que desejo excluir também ocorrências editadas individualmente.</span>
            </label>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '4px' }}>
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          style={{ flex: '1 1 140px', minWidth: 0, padding: '12px' }}
          disabled={deleting}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleConfirm}
          style={{ flex: '1 1 140px', minWidth: 0, padding: '12px', backgroundColor: 'var(--color-danger)', border: 'none' }}
          disabled={loadingDetail || deleting || !expectedUpdatedAt || deleteBlocked}
        >
          {deleting ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <RefreshCw size={14} className="spin-animation" /> Excluindo...
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <Trash2 size={14} /> Excluir
            </span>
          )}
        </button>
      </div>
    </div>
  );
};
