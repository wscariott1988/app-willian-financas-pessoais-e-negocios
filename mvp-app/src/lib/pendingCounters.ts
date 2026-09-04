// pendingCounters.ts — Contadores de pendências da Início (F-03).
// "Não pagos" = status ativos não-posted a partir do cutoff; "Sem categoria" =
// todo o histórico. A resposta distingue erro de "zero resultados": uma falha
// de consulta NUNCA é convertida em zero de sucesso.

export type CounterState =
  | { kind: 'ok'; unpaidCount: number; noCategoryCount: number }
  | { kind: 'error' }
  | { kind: 'aborted' };

// Resultado mínimo de uma consulta de contagem (supabase `count: 'exact'`).
export interface CounterResult {
  count: number | null;
  error: unknown;
}

// Interpreta os dois resultados de contagem. Erro em qualquer um deles => estado
// de erro (a UI exibe indisponível, nunca 0). Sucesso — mesmo vazio — => números.
export function resolveCounterState(
  unpaid: CounterResult | null | undefined,
  noCategory: CounterResult | null | undefined,
): CounterState {
  if (unpaid?.error || noCategory?.error) return { kind: 'error' };
  return {
    kind: 'ok',
    unpaidCount: unpaid?.count ?? 0,
    noCategoryCount: noCategory?.count ?? 0,
  };
}
