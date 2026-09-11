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

export interface DetailLoaderClient {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  from: (table: string) => any;
}

interface DetailLoadOptions {
  rpcTimeoutMs?: number;
  seriesTimeoutMs?: number;
  client?: DetailLoaderClient;
  signal?: AbortSignal | null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function fetchSeriesInfo(
  transactionId: string,
  client: DetailLoaderClient,
  seriesTimeoutMs: number,
  cancelSignal?: AbortSignal | null,
): Promise<TransactionDetailData['series']> {
  const ac = new AbortController();
  const onCancel = () => ac.abort();
  if (cancelSignal) {
    if (cancelSignal.aborted) ac.abort();
    else cancelSignal.addEventListener('abort', onCancel, { once: true });
  }
  const timeoutId = setTimeout(() => ac.abort(), seriesTimeoutMs);
  try {
    const { data: occ, error } = await client
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
    if (cancelSignal) cancelSignal.removeEventListener('abort', onCancel);
  }
}

// Única implementação confiável de carregamento do detalhe da transação.
// Usada pelo useTransactionDetail (modal de detalhes e editor). Falha séria
// não fatal: série ausente/pendente nunca impede o retorno do detalhe básico.
export async function loadTransactionDetail(
  transactionId: string,
  includeSeries: boolean,
  options: DetailLoadOptions = {},
): Promise<TransactionDetailData> {
  const {
    rpcTimeoutMs = RPC_TIMEOUT_MS,
    seriesTimeoutMs = SERIES_TIMEOUT_MS,
    client = supabase as unknown as DetailLoaderClient,
    signal,
  } = options;

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const rpcPromise = client.rpc('transaction_get_detail', {
      transaction_id: transactionId,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        ac.abort();
        reject(new Error('Tempo limite ao carregar detalhes da transação.'));
      }, rpcTimeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);
    const { data: rpcData, error: rpcError } = result as {
      data: TransactionDetailData | null;
      error: { message?: string } | null;
    };

    if (rpcError) throw rpcError;
    if (!rpcData?.transaction) {
      throw new Error('Transação não encontrada.');
    }

    let resolved: TransactionDetailData = rpcData;
    if (includeSeries) {
      const series = await fetchSeriesInfo(transactionId, client, seriesTimeoutMs, ac.signal);
      resolved = { ...rpcData, series };
    }
    return resolved;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
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

    const load = async () => {
      if (mountedRef.current) {
        setLoading(true);
        setError(null);
      }

      try {
        const resolved = await loadTransactionDetail(transactionId, includeSeries, {
          signal: ac.signal,
        });
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
        if (!disposed && mountedRef.current) setLoading(false);
      }
    };

    load();

    return () => {
      disposed = true;
      ac.abort();
    };
  }, [transactionId, retryKey, includeSeries]);

  const retry = useCallback(() => {
    setData(null);
    setError(null);
    setRetryKey((k) => k + 1);
  }, []);

  return { data, loading, error, retry };
}