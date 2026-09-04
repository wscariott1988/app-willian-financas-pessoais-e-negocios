// latestRequest.ts - guarda contra race condition entre requisições assíncronas.
// Garante que a resposta de uma consulta defasada (ex.: período anterior que
// terminou depois da atual) nunca sobrescreva o estado da consulta corrente.
// Lógica pura/testável; não faz I/O.

export interface LatestRequestGuard {
  /** Inicia uma nova consulta e devolve seu número de sequência. */
  next(): number;
  /** true se `seq` ainda é a consulta mais recente (não defasada). */
  isCurrent(seq: number): boolean;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    isCurrent: (seq: number) => seq === current,
  };
}
