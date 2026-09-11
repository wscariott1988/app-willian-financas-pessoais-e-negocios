import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';

const RPC_TIMEOUT_MS = 15000;
const SERIES_TIMEOUT_MS = 10000;

export interface TransactionDetailData {
  transaction: Record<string, unknown>;
  transfer?: Record<string, unknown>;
  series?: {
    series_id: string;
    occurrence_index: number;
    total_occurrences: number | null;
    kind: string | null;
  } | null;
  [key: string]: unknown;
}

interface UseTransactionDetailResult {
  data: TransactionDetailData | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function fetchSeriesInfo(transactionId: string): Promise<TransactionDetailData['series']> {
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), SERIES_TIMEOUT_MS);
  try {
    const { data: occ, error } = await supabase
      .from('transaction_series_occurrences')
      .select('series_id, occurrence_index, occurred_on, transaction_series(total_occurrences, kind)')
      .eq('transaction_id', transactionId)
      .abortSignal(ac.signal)
      .maybeSingle();
    if (error) throw error;
    if (!occ?.series_id) return null;
    const ser = occ.transaction_series as unknown as { total_occurrences: number | null; kind: string | null } | null;
    return {
      series_id: occ.series_id,
      occurrence_index: occ.occurrence_index,
      total_occurrences: ser?.total_occurrences ?? null,
      kind: ser?.kind ?? 'recurring',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function useTransactionDetail(
  transactionId: string | null,
  includeSeries = false,
): UseTransactionDetailResult {
  const [data, setData] = useState<TransactionDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!transactionId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const ac = new AbortController();
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      if (mountedRef.current) {
        setLoading(true);
        setError(null);
      }

      try {
        const rpcPromise = supabase.rpc('transaction_get_detail', {
          transaction_id: transactionId,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            ac.abort();
            reject(new Error('Tempo limite ao carregar detalhes da transação.'));
          }, RPC_TIMEOUT_MS);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);
        const { data: rpcData, error: rpcError } = result as {
          data: TransactionDetailData | null;
          error: { message?: string } | null;
        };

        if (rpcError) throw rpcError;
        if (disposed) return;
        if (!rpcData?.transaction) {
          throw new Error('Transação não encontrada.');
        }

        let resolved: TransactionDetailData = rpcData;
        if (includeSeries && mountedRef.current) {
          const series = await fetchSeriesInfo(transactionId);
          resolved = { ...rpcData, series };
        }
        if (disposed) return;

        if (mountedRef.current) {
          setData(resolved);
        }
      } catch (err: unknown) {
        if (disposed || isAbortError(err)) return;
        if (mountedRef.current) {
          setError(
            (err as Error).message ||
              'Falha ao carregar detalhes da transação.'
          );
        }
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (!disposed && mountedRef.current) setLoading(false);
      }
    };

    load();

    return () => {
      disposed = true;
      ac.abort();
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [transactionId, retryKey, includeSeries]);

  const retry = useCallback(() => {
    setData(null);
    setError(null);
    setRetryKey((k) => k + 1);
  }, []);

  return { data, loading, error, retry };
}