import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransactionDetail, type DetailLoaderClient } from '../hooks/useTransactionDetail';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const editorSrc = readSource('components/TransactionEditor.tsx');
const detailHookSrc = readSource('hooks/useTransactionDetail.ts');
const detailViewSrc = readSource('components/TransactionDetail.tsx');
const txViewSrc = readSource('views/TransactionsView.tsx');

function abortErr(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

interface FakeClientCtx {
  rpcResult?: () => Promise<any>;
  seriesPromise?: (signal: AbortSignal) => Promise<{ data?: any; error?: any }>;
}

function makeFakeClient(ctx: FakeClientCtx): DetailLoaderClient {
  const from = () => {
    let signal: AbortSignal | undefined;
    const attach = () => {
      return new Promise<{ data?: any; error?: any }>((resolvePromise, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
          cleanup();
          reject(abortErr());
        };
        if (signal?.aborted) {
          reject(abortErr());
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (!ctx.seriesPromise) {
          cleanup();
          resolvePromise({ data: null, error: null });
          return;
        }
        ctx.seriesPromise(signal!).then(
          (v) => {
            cleanup();
            resolvePromise(v);
          },
          (e: unknown) => {
            cleanup();
            reject(e);
          },
        );
      });
    };
    const chain = {
      select: () => chain,
      eq: () => chain,
      abortSignal: (s: AbortSignal) => {
        signal = s;
        return chain;
      },
      maybeSingle: () => attach(),
    };
    return chain;
  };
  return {
    rpc: async () => {
      if (!ctx.rpcResult) {
        return { data: { transaction: { id: 'tx1', transaction_kind: 'expense', amount: '10', raw_description: 'Teste' } }, error: null };
      }
      return ctx.rpcResult();
    },
    from,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('loadTransactionDetail — função pura do detalhe', () => {
  it('RPC com sucesso → retorna o detalhe (formulário pode aparecer)', async () => {
    const client = makeFakeClient({});
    const data = await loadTransactionDetail('tx1', false, { client });
    expect(data.transaction.id).toBe('tx1');
    expect(data.series).toBeUndefined();
  });

  it('RPC com sucesso + série pendurada → detalhe básico ainda é liberado', async () => {
    const client = makeFakeClient({
      seriesPromise: () => new Promise(() => {}), // nunca resolve
    });
    // includeSeries=false: o retorno NÃO depende da série (caso do editor).
    const data = await loadTransactionDetail('tx1', false, { client });
    expect(data.transaction.id).toBe('tx1');
  });

  it('RPC com sucesso + série pendurada (includeSeries) → cai após timeout e não falha', async () => {
    vi.useFakeTimers();
    const client = makeFakeClient({
      seriesPromise: () => new Promise(() => {}),
    });
    const p = loadTransactionDetail('tx1', true, { client });
    await vi.advanceTimersByTimeAsync(10000);
    const data = await p;
    expect(data.transaction.id).toBe('tx1');
    expect(data.series).toBeNull();
  });

  it('RPC falha → rejeita (erro → Tentar novamente no editor)', async () => {
    const client = makeFakeClient({
      rpcResult: async () => ({ data: null, error: { message: 'permission denied' } }),
    });
    await expect(loadTransactionDetail('tx1', false, { client })).rejects.toThrow('permission denied');
  });

  it('RPC sem transaction → rejeita como não encontrada', async () => {
    const client = makeFakeClient({
      rpcResult: async () => ({ data: null, error: null }),
    });
    await expect(loadTransactionDetail('tx1', false, { client })).rejects.toThrow('Transação não encontrada.');
  });

  it('timeout (RPC pendurada além de 15s) → rejeita com mensagem de tempo limite', async () => {
    vi.useFakeTimers();
    const client = makeFakeClient({
      rpcResult: () => new Promise(() => {}),
    });
    const p = loadTransactionDetail('tx1', false, { client });
    const assertion = expect(p).rejects.toThrow('Tempo limite ao carregar detalhes da transação.');
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });

  it('retry bem-sucedido → segunda chamada depois da falha retorna o detalhe', async () => {
    let fail = true;
    const client = makeFakeClient({
      rpcResult: () =>
        fail
          ? Promise.resolve({ data: null, error: { message: 'boom' } })
          : Promise.resolve({ data: { transaction: { id: 'tx1' } }, error: null }),
    });
    await expect(loadTransactionDetail('tx1', false, { client })).rejects.toThrow('boom');
    fail = false;
    const data = await loadTransactionDetail('tx1', false, { client });
    expect(data.transaction.id).toBe('tx1');
  });
});

describe('PESSOAL-08 — TransactionEditor reusa o hook (loader único)', () => {
  it('não possui mais loader inline próprio de RPC', () => {
    expect(editorSrc).toContain('useTransactionDetail');
    expect(editorSrc).not.toContain("rpc('transaction_get_detail'");
  });

  it('formulário não depende da série para liberar (includeSeries=false)', () => {
    expect(editorSrc).toContain('useTransactionDetail(editId, false)');
  });

  it('série é consulta separada e não-bloqueante, com timeout próprio', () => {
    expect(editorSrc).toContain("from('transaction_series_occurrences')");
    expect(editorSrc).toContain('.abortSignal(occAc.signal)');
    expect(editorSrc).toContain('occAc');
    expect(editorSrc).toContain('occTimeout');
    expect(editorSrc).toContain('10000');
  });

  it('loading só é liberado pelo detalhe, nunca por série', () => {
    expect(editorSrc).toContain('{loadingDetail ? (');
  });

  it('erro + Tentar novamente viram estados explícitos ligados ao retry do hook', () => {
    expect(editorSrc).toContain('detailError && !detailData');
    expect(editorSrc).toContain('onClick={retryDetail}');
    expect(editorSrc).toContain('Tentar novamente');
  });

  it('regressão: loader duplicado não existe mais (sem spinner infinito)', () => {
    expect(editorSrc).not.toContain('detailTxId');
    expect(editorSrc).not.toContain('detailRetryKey');
    expect(editorSrc).not.toContain('setLoadingDetail(');
    expect(editorSrc).not.toContain('detailTxId === editId');
  });

  it('formulário é populado de detailData?.transaction (sucesso)', () => {
    expect(editorSrc).toContain('detailData?.transaction');
    expect(editorSrc).toContain('setForm({');
    expect(editorSrc).toContain('raw_description');
  });
});

describe('PESSOAL-08 — os dois fluxos usam a MESMA implementação', () => {
  it('detalhes e editor chamam o mesmo hook', () => {
    expect(detailViewSrc).toContain('useTransactionDetail(transactionId, true)');
    expect(editorSrc).toContain('useTransactionDetail(editId, false)');
    expect(detailHookSrc).toContain('loadTransactionDetail');
  });

  it('hook expõe retry reutilizável (retryKey) — nunca spinner infinito no retry', () => {
    expect(detailHookSrc).toContain('retryKey');
    expect(detailHookSrc).toMatch(/setRetryKey\(\(?k\)?\s*=>\s*k\s*\+\s*1\)/);
  });

  it('Detalhes → Editar encerra detalhes e abre editor com a mesma transação', () => {
    expect(txViewSrc).toContain('setDetailTarget(null)');
    expect(txViewSrc).toContain('setEditor({ tx, creating: false })');
  });

  it('lápis → editor abre direto, sem passar por detalhes', () => {
    expect(txViewSrc).toContain('handleEditTransaction');
    expect(txViewSrc).toContain('setEditor({ tx, creating: false })');
  });
});