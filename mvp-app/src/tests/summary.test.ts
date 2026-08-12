import { describe, it, expect, vi } from 'vitest';
import {
  fetchAllPeriodRows,
  sumPeriodRows,
  buildPeriodSummary,
  PERIOD_PAGE_SIZE,
  type PeriodPageFetcher,
  type SummaryRow,
} from '../lib/summary';

// O módulo real de supabaseClient exige VITE_SUPABASE_URL na importação;
// os testes usam fetchers injetáveis, então só o módulo é substituído.
vi.mock('../supabaseClient', () => ({ supabase: {} }));

function genRows(n: number): SummaryRow[] {
  return Array.from({ length: n }, (_, i) => ({
    amount: String(i + 1),
    transaction_kind: 'income' as const,
  }));
}

function fakeFetcher(
  rows: SummaryRow[],
  total: number | null,
  opts?: { failOnCall?: number; failMsg?: string },
): { fetcher: PeriodPageFetcher; calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  const fetcher: PeriodPageFetcher = async (from, to) => {
    calls.push([from, to]);
    if (opts?.failOnCall !== undefined && calls.length === opts.failOnCall) {
      return { rows: null, totalCount: total, error: new Error(opts.failMsg ?? 'falha de página') };
    }
    return { rows: rows.slice(from, to + 1), totalCount: total, error: null };
  };
  return { fetcher, calls };
}

describe('fetchAllPeriodRows — paginação', () => {
  it('menos de uma página: busca única e retorna todas as linhas', async () => {
    const rows = genRows(2);
    const { fetcher, calls } = fakeFetcher(rows, 2);

    const result = await fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE);

    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(2);
    expect(calls).toEqual([[0, PERIOD_PAGE_SIZE - 1]]);
  });

  it('exatamente uma página completa (1000 linhas): uma única chamada', async () => {
    const rows = genRows(PERIOD_PAGE_SIZE);
    const { fetcher, calls } = fakeFetcher(rows, PERIOD_PAGE_SIZE);

    const result = await fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE);

    expect(result.rows).toHaveLength(PERIOD_PAGE_SIZE);
    expect(result.totalCount).toBe(PERIOD_PAGE_SIZE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([0, PERIOD_PAGE_SIZE - 1]);
  });

  it('mais de 1000 linhas (2500): múltiplas páginas até esgotar o total', async () => {
    const rows = genRows(2500);
    const { fetcher, calls } = fakeFetcher(rows, 2500);

    const result = await fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE);

    expect(result.rows).toHaveLength(2500);
    expect(result.totalCount).toBe(2500);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('erro na segunda página aborta a busca (sem resultado parcial)', async () => {
    const rows = genRows(2500);
    const { fetcher } = fakeFetcher(rows, 2500, { failOnCall: 2, failMsg: 'falha de página 2' });

    await expect(fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE)).rejects.toThrow('falha de página 2');
  });

  it('página vazia antes do total esperado é tratada como erro (sem soma parcial)', async () => {
    const emptyPageFetcher: PeriodPageFetcher = async (from) => {
      if (from === 0) return { rows: genRows(500), totalCount: 1000, error: null };
      return { rows: [], totalCount: 1000, error: null };
    };

    await expect(fetchAllPeriodRows(emptyPageFetcher, PERIOD_PAGE_SIZE)).rejects.toThrow(
      'página vazia antes do total esperado',
    );
  });

  it('nenhuma linha duplicada ou ignorada entre páginas', async () => {
    const rows = genRows(2500);
    const { fetcher, calls } = fakeFetcher(rows, 2500);

    const result = await fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE);

    const amounts = result.rows.map((r) => String(r.amount));
    expect(new Set(amounts).size).toBe(2500);
    // Soma 1..2500 = 2500*2501/2 — prova que nenhuma linha sumiu nem se repetiu
    const sum = result.rows.reduce((acc, r) => acc + Number(r.amount), 0);
    expect(sum).toBe((2500 * 2501) / 2);
    expect(calls).toHaveLength(3);
  });

  it('sem total informado (count ausente): termina quando a página vem incompleta', async () => {
    const rows = genRows(1200);
    const { fetcher } = fakeFetcher(rows, null);

    const result = await fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE);

    expect(result.rows).toHaveLength(1200);
    expect(result.totalCount).toBe(1200);
  });

  it('intervalo vazio retorna soma zerada', async () => {
    const { fetcher } = fakeFetcher([], 0);

    const result = await fetchAllPeriodRows(fetcher, PERIOD_PAGE_SIZE);

    expect(result.rows).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('rejeita pageSize inválido (evita loop infinito)', async () => {
    const { fetcher } = fakeFetcher([], 0);

    await expect(fetchAllPeriodRows(fetcher, 0)).rejects.toThrow('pageSize');
    await expect(fetchAllPeriodRows(fetcher, -5)).rejects.toThrow('pageSize');
    await expect(fetchAllPeriodRows(fetcher, 500.5)).rejects.toThrow('pageSize');
  });
});

describe('sumPeriodRows — regras de direção', () => {
  it('transferências não entram como receita nem despesa', () => {
    const rows: SummaryRow[] = [
      { amount: '10.00', transaction_kind: 'income' },
      { amount: '4.00', transaction_kind: 'expense' },
      { amount: '7.50', transaction_kind: 'transfer' },
      { amount: '2.00', transaction_kind: 'income' },
    ];

    const { income, expense, transfer } = sumPeriodRows(rows);

    expect(income).toBe(12);
    expect(expense).toBe(4);
    expect(transfer).toBe(7.5);
  });

  it('amount sempre positivo; despesa não subtrai na soma bruta, só no resultado', async () => {
    const rows: SummaryRow[] = [
      { amount: '100.00', transaction_kind: 'income' },
      { amount: '30.00', transaction_kind: 'expense' },
    ];
    const { fetcher } = fakeFetcher(rows, 2);

    const summary = await buildPeriodSummary(fetcher, PERIOD_PAGE_SIZE);

    expect(summary.income).toBe(100);
    expect(summary.expense).toBe(30);
    expect(summary.balance).toBe(70);
  });
});

describe('buildPeriodSummary — pipeline completo', () => {
  it('menos de uma página: totais e totalCount corretos', async () => {
    const rows: SummaryRow[] = [
      { amount: '5.00', transaction_kind: 'income' },
      { amount: '3.00', transaction_kind: 'expense' },
    ];
    const { fetcher } = fakeFetcher(rows, 2);

    const summary = await buildPeriodSummary(fetcher, PERIOD_PAGE_SIZE);

    expect(summary.income).toBe(5);
    expect(summary.expense).toBe(3);
    expect(summary.balance).toBe(2);
    expect(summary.transfer).toBe(0);
    expect(summary.totalCount).toBe(2);
  });

  it('mais de 1000 linhas: soma final correta após múltiplas páginas', async () => {
    const rows = genRows(2500);
    const { fetcher } = fakeFetcher(rows, 2500);

    const summary = await buildPeriodSummary(fetcher, PERIOD_PAGE_SIZE);

    expect(summary.income).toBe((2500 * 2501) / 2);
    expect(summary.expense).toBe(0);
    expect(summary.balance).toBe((2500 * 2501) / 2);
    expect(summary.totalCount).toBe(2500);
  });

  it('erro na segunda página: buildPeriodSummary rejeita (nunca soma parcial)', async () => {
    const rows = genRows(2500);
    const { fetcher } = fakeFetcher(rows, 2500, { failOnCall: 2, failMsg: 'falha de página 2' });

    await expect(buildPeriodSummary(fetcher, PERIOD_PAGE_SIZE)).rejects.toThrow('falha de página 2');
  });

  it('transferências continuam fora das somas no pipeline completo', async () => {
    const rows: SummaryRow[] = [
      { amount: '10.00', transaction_kind: 'income' },
      { amount: '4.00', transaction_kind: 'expense' },
      { amount: '7.50', transaction_kind: 'transfer' },
      { amount: '2.00', transaction_kind: 'income' },
    ];
    const { fetcher } = fakeFetcher(rows, 4);

    const summary = await buildPeriodSummary(fetcher, PERIOD_PAGE_SIZE);

    expect(summary.income).toBe(12);
    expect(summary.expense).toBe(4);
    expect(summary.transfer).toBe(7.5);
    expect(summary.balance).toBe(8);
    expect(summary.totalCount).toBe(4);
  });

  it('intervalo vazio: resumo zerado', async () => {
    const { fetcher } = fakeFetcher([], 0);

    const summary = await buildPeriodSummary(fetcher, PERIOD_PAGE_SIZE);

    expect(summary).toEqual({ income: 0, expense: 0, transfer: 0, balance: 0, totalCount: 0 });
  });
});
