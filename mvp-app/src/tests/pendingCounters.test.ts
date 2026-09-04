import { describe, it, expect } from 'vitest';
import { resolveCounterState } from '../lib/pendingCounters';

describe('F-03 — contadores de pendência distinguem zero de erro', () => {
  it('A) sucesso com zero resultados => contador 0 (não é erro)', () => {
    const state = resolveCounterState(
      { count: 0, error: null },
      { count: 0, error: null },
    );
    expect(state).toEqual({ kind: 'ok', unpaidCount: 0, noCategoryCount: 0 });
  });

  it('A) sucesso com contagens reais => números exatos', () => {
    const state = resolveCounterState(
      { count: 3, error: null },
      { count: 5, error: null },
    );
    expect(state).toEqual({ kind: 'ok', unpaidCount: 3, noCategoryCount: 5 });
  });

  it('A) count ausente (null) => 0 (sem NaN/undefined)', () => {
    const state = resolveCounterState(
      { count: null, error: null },
      { count: null, error: null },
    );
    expect(state).toEqual({ kind: 'ok', unpaidCount: 0, noCategoryCount: 0 });
  });

  it('B) erro na consulta => estado de erro, nunca zero de sucesso', () => {
    const state = resolveCounterState(
      { count: null, error: new Error('network') },
      { count: 4, error: null },
    );
    expect(state).toEqual({ kind: 'error' });
  });

  it('B) erro em qualquer um dos dois contadores => erro', () => {
    const state = resolveCounterState(
      { count: 2, error: null },
      { count: null, error: new Error('rpc') },
    );
    expect(state).toEqual({ kind: 'error' });
  });
});
