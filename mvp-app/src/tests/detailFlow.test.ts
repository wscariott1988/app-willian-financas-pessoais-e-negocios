import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSeriesMeta, seriesDisplayLabel } from '../lib/series';

vi.mock('../supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/status', () => ({
  displayPaymentStatus: vi.fn((status: string) => {
    const m: Record<string, string> = { posted: 'Pago', pending: 'Pendente', scheduled: 'Agendado' };
    return m[status] || status;
  }),
}));
vi.mock('../lib/accountCrud', () => ({
  accountDisplayLabel: vi.fn((acc: any) => acc?.display_name || ''),
}));
vi.mock('lucide-react', () => {
  const EmptyIcon = () => null;
  const ComponentProxy = new Proxy(
    {},
    { get: () => EmptyIcon }
  );
  return {
    default: ComponentProxy,
    Eye: EmptyIcon,
    AlertCircle: EmptyIcon,
    RefreshCw: EmptyIcon,
    X: EmptyIcon,
    Pencil: EmptyIcon,
    ArrowLeftRight: EmptyIcon,
  };
});

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const detailHook = readSource('hooks/useTransactionDetail.ts');
const editorSrc = readSource('components/TransactionEditor.tsx');
const deleteSrc = readSource('components/DeleteConfirmation.tsx');
const recentTx = readSource('components/RecentTransactions.tsx');
const txListSrc = readSource('components/TransactionList.tsx');
const txDetailViewSrc = readSource('views/TransactionsView.tsx');
const dashboardSrc = readSource('components/Dashboard.tsx');
const txDetailComponent = readSource('components/TransactionDetail.tsx');

describe('PESSOAL-07 — clique na linha abre detalhes', () => {
  it('TransactionList rows are keyboard-accessible with onSelectTransaction', () => {
    expect(txListSrc).toContain('tabIndex={0}');
    expect(txListSrc).toContain('onKeyDown');
    expect(txListSrc).toContain("onSelectTransaction(tx)");
    expect(txListSrc).toContain("e.key === 'Enter' || e.key === ' '");
    expect(txListSrc).toContain('e.preventDefault()');
  });

  it('RecentTransactions wires onSelectTransaction on each row', () => {
    expect(recentTx).toContain('onSelectTransaction');
    expect(recentTx).toContain('tabIndex={0}');
    expect(recentTx).toContain('onClick');
    expect(recentTx).toContain("e.key === 'Enter' || e.key === ' '");
  });

  it('TransactionsView passes a real handler, not a noop', () => {
    expect(txDetailViewSrc).toContain('onSelectTransaction={handleSelectTransaction}');
    expect(txDetailViewSrc).not.toContain('onSelectTransaction={() => {}}');
    expect(txDetailViewSrc).toContain('handleSelectTransaction');
    expect(txDetailViewSrc).toContain('setDetailTarget');
  });

  it('Dashboard wires onSelectTransaction to detailTarget', () => {
    expect(dashboardSrc).toContain('onSelectTransaction={handleSelectTransaction}');
    expect(dashboardSrc).toContain('handleSelectTransaction');
    expect(dashboardSrc).toContain('setDetailTarget');
  });

  it('TransactionsView renders TransactionDetail modal', () => {
    expect(txDetailViewSrc).toContain('TransactionDetail');
    expect(txDetailViewSrc).toContain('detailTarget');
  });

  it('Dashboard renders TransactionDetail modal', () => {
    expect(dashboardSrc).toContain('TransactionDetail');
    expect(dashboardSrc).toContain('detailTarget');
  });

  it('TransactionDetail shows loading / error / content / empty states', () => {
    expect(txDetailComponent).toContain('Carregando detalhes...');
    expect(txDetailComponent).toContain('Nenhum dado encontrado.');
    expect(txDetailComponent).toContain('Detalhes da transação');
  });

  it('TransactionDetail has a retry button wired to hook retry()', () => {
    expect(txDetailComponent).toContain('retry');
    expect(txDetailComponent).toContain('Tentar novamente');
  });

  it('TransactionDetail Edit button calls onEdit', () => {
    expect(txDetailComponent).toContain('handleEdit');
    expect(txDetailComponent).toContain('onEdit(transactionId)');
    expect(txDetailComponent).toContain('Pencil');
  });

  it('TransactionDetail Close button calls onClose', () => {
    expect(txDetailComponent).toContain('onClick={onClose}');
    expect(txDetailComponent).toContain('Fechar');
    expect(txDetailComponent).toContain('aria-label="Fechar detalhes"');
  });
});

describe('PESSOAL-07 — lápis abre editor sem abrir detalhes', () => {
  it('RecentTransactions pencil uses stopPropagation', () => {
    expect(recentTx).toContain('e.stopPropagation()');
    expect(recentTx).toContain('onEdit');
  });

  it('TransactionList pencil uses stopPropagation', () => {
    expect(txListSrc).toContain('e.stopPropagation()');
    expect(txListSrc).toContain('onEdit');
  });
});

describe('PESSOAL-07 — erro do RPC encerra loading e oferece retry', () => {
  it('useTransactionDetail uses AbortController + timeout + catch sets error', () => {
    expect(detailHook).toContain('AbortController');
    expect(detailHook).toContain('setTimeout');
    expect(detailHook).toContain('rpc(\'transaction_get_detail\'');
    expect(detailHook).toContain('setError(');
    expect(detailHook).toContain('setLoading(false)');
    expect(detailHook).toMatch(/const retry\s*=\s*useCallback/);
  });

  it('useTransactionDetail distinguishes unmount from error via disposed flag', () => {
    expect(detailHook).toContain('let disposed = false');
    expect(detailHook).toContain('disposed = true');
    expect(detailHook).toContain('if (disposed || isAbortError(err)) return');
    expect(detailHook).toContain('if (!disposed && mountedRef.current)');
  });

  it('TransactionEditor shows error + retry when the shared detail load fails', () => {
    expect(editorSrc).toContain('detailError && !detailData');
    expect(editorSrc).toContain('Tentar novamente');
    expect(editorSrc).toContain('onClick={retryDetail}');
  });

  it('DeleteConfirmation shows retry button when loadFailed', () => {
    expect(deleteSrc).toContain('loadFailed');
    expect(deleteSrc).toContain('setLoadFailed(true)');
    expect(deleteSrc).toContain('Tentar novamente');
    expect(deleteSrc).toContain('handleRetry');
    expect(deleteSrc).toContain('onClick={handleRetry}');
  });
});

describe('PESSOAL-07 — timeout encerra loading', () => {
  it('useTransactionDetail has 15s timeout', () => {
    expect(detailHook).toContain('RPC_TIMEOUT_MS');
    expect(detailHook).toMatch(/RPC_TIMEOUT_MS\s*=\s*15_?000/);
    expect(detailHook).toContain("reject(new Error('Tempo limite ao carregar detalhes da transação.'))");
  });

  it('TransactionEditor delegates detail loading to the shared hook', () => {
    expect(editorSrc).toContain('useTransactionDetail');
    expect(editorSrc).not.toContain("rpc('transaction_get_detail'");
  });

  it('DeleteConfirmation has timeout', () => {
    expect(deleteSrc).toContain('RPC_TIMEOUT_MS');
    expect(deleteSrc).toContain("reject(new Error('Tempo limite ao carregar detalhes da transação.'))");
  });

  it('TransactionEditor cleans up the series sub-query timeout', () => {
    expect(editorSrc).toContain('clearTimeout(occTimeout)');
    expect(editorSrc).toContain('occAc.abort()');
  });

  it('DeleteConfirmation clears timeout in finally', () => {
    expect(deleteSrc).toContain('clearTimeout(timeoutId)');
    expect(deleteSrc).toContain('if (timeoutId !== undefined) clearTimeout(timeoutId)');
  });
});

describe('PESSOAL-07 — retry realiza nova tentativa', () => {
  it('useTransactionDetail has retryKey + retry function', () => {
    expect(detailHook).toContain('retryKey');
    expect(detailHook).toMatch(/const retry\s*=\s*useCallback/);
    expect(detailHook).toMatch(/setRetryKey\(\(?k\)?\s*=>\s*k\s*\+\s*1\)/);
  });

  it('TransactionEditor reuses the hook retry instead of its own loader', () => {
    expect(editorSrc).toContain('retry: retryDetail');
    expect(editorSrc).not.toContain('detailRetryKey');
    expect(editorSrc).not.toContain('detailTxId');
  });

  it('DeleteConfirmation has retryKey', () => {
    expect(deleteSrc).toContain('retryKey');
    expect(deleteSrc).toMatch(/setRetryKey\(\(?k\)?\s*=>\s*k\s*\+\s*1\)/);
  });
});

describe('PESSOAL-07 — success popula editor', () => {
  it('TransactionEditor sets form from data.transaction on success', () => {
    expect(editorSrc).toContain('setForm({');
    expect(editorSrc).toContain('raw_description');
    expect(editorSrc).toContain('amount');
    expect(editorSrc).toContain('occurred_on');
    expect(editorSrc).toContain('account_id');
    expect(editorSrc).toContain('category_id');
    expect(editorSrc).toContain('status');
    expect(editorSrc).toContain('memo');
    expect(editorSrc).toContain('detailData?.transaction');
  });
});

describe('PESSOAL-07 — DeleteConfirmation nunca fica em loading eterno', () => {
  it('DeleteConfirmation uses disposed flag + finally sets loading false', () => {
    expect(deleteSrc).toContain('let disposed = false');
    expect(deleteSrc).toContain('disposed = true');
    expect(deleteSrc).toContain('if (!disposed && mounted.current) setLoadingDetail(false)');
  });

  it('DeleteConfirmation distinguishes unmount from timeout', () => {
    expect(deleteSrc).toContain('if (disposed) return');
  });

  it('DeleteConfirmation has AbortController', () => {
    expect(deleteSrc).toContain('AbortController');
  });

  it('DeleteConfirmation cleanup aborts', () => {
    expect(deleteSrc).toContain('ac.abort()');
  });
});

describe('PESSOAL-07 — detalhes funcionam para transação comum', () => {
  it('TransactionDetail shows all key fields', () => {
    expect(txDetailComponent).toContain('Descrição');
    expect(txDetailComponent).toContain('Tipo');
    expect(txDetailComponent).toContain('Valor');
    expect(txDetailComponent).toContain('Data');
    expect(txDetailComponent).toContain('Conta');
    expect(txDetailComponent).toContain('Categoria');
  });
});

describe('PESSOAL-07 — transferência sem série não quebra', () => {
  it('TransactionDetail renders to_account_name for transfers', () => {
    expect(txDetailComponent).toContain('isTransfer');
    expect(txDetailComponent).toContain('Conta de destino');
    expect(txDetailComponent).toContain('toAccountName');
  });
});

describe('PESSOAL-07 — ocorrência de série continua identificável', () => {
  it('useTransactionDetail fetches series info by default (includeSeries=true)', () => {
    expect(detailHook).toContain('includeSeries');
    expect(detailHook).toContain('fetchSeriesInfo');
    expect(detailHook).toContain('transaction_series_occurrences');
  });

  it('TransactionDetail renders series info block when data.series is present', () => {
    expect(txDetailComponent).toContain('data.series');
    expect(txDetailComponent).toContain('series_id');
    expect(txDetailComponent).toContain('occurrence_index');
    expect(txDetailComponent).toContain('Esta transação faz parte de uma série');
  });

  it('TransactionEditor series sub-query uses its own AbortController + timeout', () => {
    expect(editorSrc).toContain('occAc');
    expect(editorSrc).toContain('occTimeout');
    expect(editorSrc).toContain('10000');
    expect(editorSrc).toContain('.abortSignal(occAc.signal)');
  });
});

describe('PESSOAL-10 — índice 1-based no detalhe (mesma regra da lista)', () => {
  it('TransactionDetail reutiliza seriesDisplayLabel (uma única fonte de rótulo)', () => {
    expect(txDetailComponent).toContain('seriesDisplayLabel');
    expect(txDetailComponent).toContain('extractSeriesMeta');
  });

  it('nenhum "+ 1" sobre occurrence_index no detalhe (índice é 1-based no banco)', () => {
    expect(txDetailComponent).not.toMatch(/occurrence_index\s*\+\s*1/);
    expect(txDetailComponent).toContain('occurrence_index: data.series.occurrence_index');
  });

  it('parcela exibe "Parcela N de TOTAL" e recorrente exibe "Recorrente" via helper', () => {
    const label = seriesDisplayLabel(
      extractSeriesMeta({
        occurrence_index: 2,
        transaction_series: { kind: 'installment', total_occurrences: 10 },
      }),
    );
    expect(label).toBe('Parcela 2 de 10');
    expect(seriesDisplayLabel(extractSeriesMeta({ occurrence_index: 2, transaction_series: { kind: 'recurring', total_occurrences: null } }))).toBe('Recorrente');
  });

  it('bloco de série continua presente no detalhe', () => {
    expect(txDetailComponent).toContain('Esta transação faz parte de uma série');
    expect(txDetailComponent).toContain('data.series.series_id');
  });
});

describe('PESSOAL-07 — technical subtitle removed', () => {
  it('TransactionEditor does not show the old technical subtitle', () => {
    expect(editorSrc).not.toContain('Edição atômica');
    expect(editorSrc).not.toContain('bloqueio otimista');
    expect(editorSrc).not.toContain('auditoria completa');
  });
});

describe('PESSOAL-07 — TransactionsView Escape handling', () => {
  it('Escape closes detail before closing editor', () => {
    expect(txDetailViewSrc).toContain('detailTarget');
    expect(txDetailViewSrc).toContain('setDetailTarget(null)');
    expect(txDetailViewSrc).toContain("'Escape'");
  });
});
