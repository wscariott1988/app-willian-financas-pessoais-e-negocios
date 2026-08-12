import { describe, it, expect, vi } from 'vitest';
import {
  txFilterInitial,
  toggleReviewFilter,
  toggleNoCategoryFilter,
  clearTxFilters,
  hasActiveTxFilters,
  buildTxListOptions,
  createTxPageFetcher,
  fetchAllTxPages,
  TX_PAGE_SIZE,
  STATUS_LABELS,
  statusLabel,
  type TxListFilters,
} from '../lib/txList';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const BASE = { search: 'mercado', accountId: 'acc-1', start: '2026-08-01', end: '2026-08-31' };

function genRows(n: number): Array<{ id: string; status: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `tx-${String(i).padStart(6, '0')}`,
    status: 'posted',
  }));
}

function fakeFetcher(rows: unknown[], total: number | null, opts?: { failOnCall?: number; failMsg?: string }) {
  const calls: Array<[number, number]> = [];
  const fetcher = async (from: number, to: number) => {
    calls.push([from, to]);
    if (opts?.failOnCall !== undefined && calls.length === opts.failOnCall) {
      return { rows: null, totalCount: total, error: new Error(opts.failMsg ?? 'falha de página') };
    }
    return { rows: rows.slice(from, to + 1), totalCount: total, error: null };
  };
  return { fetcher, calls };
}

// Cliente Supabase fake com cadeia registrável e .then resolvível por página.
function makeFakeClient(rows: unknown[], total: number) {
  const log: unknown[][] = [];
  let lastRange: [number, number] = [0, 0];
  const query: any = {
    ilike: (c: string, v: unknown) => { log.push(['ilike', c, v]); return query; },
    eq: (c: string, v: unknown) => { log.push(['eq', c, v]); return query; },
    is: (c: string, v: unknown) => { log.push(['is', c, v]); return query; },
    gte: (c: string, v: unknown) => { log.push(['gte', c, v]); return query; },
    lte: (c: string, v: unknown) => { log.push(['lte', c, v]); return query; },
    order: (c: string, v: unknown) => { log.push(['order', c, v]); return query; },
    range: (a: number, b: number) => { log.push(['range', a, b]); lastRange = [a, b]; return query; },
    select: (s: unknown, o: unknown) => { log.push(['select', s, o]); return query; },
    then: (resolve: (r: any) => void) =>
      resolve({ data: rows.slice(lastRange[0], lastRange[1] + 1), count: total, error: null }),
  };
  return {
    client: { from: (t: string) => { log.push(['from', t]); return query; } },
    log,
  };
}

describe('filtros — estado inicial e toggles', () => {
  it('1) lista inicia sem filtro de status e sem filtro de categoria', () => {
    expect(txFilterInitial()).toEqual({ reviewOnly: false, noCategory: false });

    const opts = buildTxListOptions(txFilterInitial(), BASE);
    expect(opts.statusFilter).toBeNull();
    expect(opts.noCategory).toBeUndefined();
    // busca, conta e período continuam presentes
    expect(opts.search).toBe('mercado');
    expect(opts.accountId).toBe('acc-1');
    expect(opts.start).toBe('2026-08-01');
    expect(opts.end).toBe('2026-08-31');
  });

  it('2) “Em revisão” ativa e desativa corretamente', () => {
    const initial: TxListFilters = txFilterInitial();
    const on = toggleReviewFilter(initial);
    expect(on).toEqual({ reviewOnly: true, noCategory: false });
    expect(buildTxListOptions(on, BASE).statusFilter).toBe('review');
    expect(buildTxListOptions(on, BASE).noCategory).toBeUndefined();

    const off = toggleReviewFilter(on);
    expect(off).toEqual({ reviewOnly: false, noCategory: false });
    expect(buildTxListOptions(off, BASE).statusFilter).toBeNull();
  });

  it('3) “Sem categoria” ativa e desativa corretamente', () => {
    const on = toggleNoCategoryFilter(txFilterInitial());
    expect(on).toEqual({ reviewOnly: false, noCategory: true });
    expect(buildTxListOptions(on, BASE).noCategory).toBe(true);
    expect(buildTxListOptions(on, BASE).statusFilter).toBeNull();

    const off = toggleNoCategoryFilter(on);
    expect(off).toEqual({ reviewOnly: false, noCategory: false });
    expect(buildTxListOptions(off, BASE).noCategory).toBeUndefined();
  });

  it('4) os dois filtros podem ser combinados', () => {
    let f = toggleReviewFilter(txFilterInitial());
    f = toggleNoCategoryFilter(f);
    expect(f).toEqual({ reviewOnly: true, noCategory: true });

    const opts = buildTxListOptions(f, BASE);
    expect(opts.statusFilter).toBe('review');
    expect(opts.noCategory).toBe(true);
  });

  it('5) limpar filtros desativa ambos mantendo o restante', () => {
    let f = toggleReviewFilter(toggleNoCategoryFilter(txFilterInitial()));
    expect(hasActiveTxFilters(f)).toBe(true);

    const cleared = clearTxFilters();
    expect(cleared).toEqual({ reviewOnly: false, noCategory: false });
    expect(hasActiveTxFilters(cleared)).toBe(false);

    const opts = buildTxListOptions(cleared, { ...BASE, search: '' });
    expect(opts.statusFilter).toBeNull();
    expect(opts.noCategory).toBeUndefined();
    expect(opts.start).toBe('2026-08-01');
    expect(opts.end).toBe('2026-08-31');
  });

  it('filtros ativos não alteram mês, período, busca e conta', () => {
    const opts = buildTxListOptions(toggleReviewFilter(toggleNoCategoryFilter(txFilterInitial())), BASE);
    expect(opts.start).toBe('2026-08-01');
    expect(opts.end).toBe('2026-08-31');
    expect(opts.search).toBe('mercado');
    expect(opts.accountId).toBe('acc-1');
  });
});

describe('status legíveis', () => {
  it('6) traduz os cinco status sem alterar valores', () => {
    expect(statusLabel('posted')).toEqual({ label: 'Confirmada', hint: expect.any(String) });
    expect(statusLabel('pending')).toEqual({ label: 'Pendente', hint: expect.any(String) });
    expect(statusLabel('review')).toEqual({ label: 'Em revisão', hint: expect.any(String) });
    expect(statusLabel('scheduled')).toEqual({ label: 'Agendada', hint: expect.any(String) });
    expect(statusLabel('ignored')).toEqual({ label: 'Ignorada', hint: expect.any(String) });
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(['ignored', 'pending', 'posted', 'review', 'scheduled']);
  });

  it('a explicação de “Agendada” cobre o significado', () => {
    expect(STATUS_LABELS.scheduled.hint).toContain('prevista');
    expect(STATUS_LABELS.scheduled.hint).toContain('ainda não confirmada');
  });

  it('status desconhecido/nulo cai para o próprio valor', () => {
    expect(statusLabel('desconhecido')).toEqual({ label: 'desconhecido', hint: '' });
    expect(statusLabel(null)).toEqual({ label: '', hint: '' });
  });
});

describe('lista contínua — paginação em lotes', () => {
  it('7) mais de 1000 transações são carregadas em lotes', async () => {
    const rows = genRows(2500);
    const { fetcher, calls } = fakeFetcher(rows, 2500);

    const result = await fetchAllTxPages(fetcher, TX_PAGE_SIZE);

    expect(result.rows).toHaveLength(2500);
    expect(result.totalCount).toBe(2500);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('8) nenhuma duplicação ou omissão entre lotes', async () => {
    const rows = genRows(2500);
    const { fetcher } = fakeFetcher(rows, 2500);

    const result = await fetchAllTxPages(fetcher, TX_PAGE_SIZE);

    const ids = result.rows.map((r) => String(r.id));
    expect(new Set(ids).size).toBe(2500);
  });

  it('9) erro em lote intermediário não produz lista parcial', async () => {
    const rows = genRows(2500);
    const { fetcher } = fakeFetcher(rows, 2500, { failOnCall: 2, failMsg: 'falha de página 2' });

    await expect(fetchAllTxPages(fetcher, TX_PAGE_SIZE)).rejects.toThrow('falha de página 2');
  });

  it('exatamente uma página completa: uma única chamada', async () => {
    const rows = genRows(TX_PAGE_SIZE);
    const { fetcher, calls } = fakeFetcher(rows, TX_PAGE_SIZE);

    const result = await fetchAllTxPages(fetcher, TX_PAGE_SIZE);

    expect(result.rows).toHaveLength(TX_PAGE_SIZE);
    expect(calls).toHaveLength(1);
  });
});

describe('consultas — período e perfil presentes em todas as páginas', () => {
  it('10) todas as páginas aplicam período (gte/lte), ordenação e os mesmos filtros base', async () => {
    const rows = genRows(2500);
    const { client, log } = makeFakeClient(rows, 2500);
    const opts = buildTxListOptions(
      { reviewOnly: true, noCategory: true },
      { search: 'mercado', accountId: 'acc-1', start: '2026-08-01', end: '2026-08-31' },
    );
    const fetcher = createTxPageFetcher(client, opts);

    await fetcher(0, 999);
    const page1 = log.slice();
    log.length = 0;

    await fetcher(1000, 1999);
    const page2 = log.slice();

    for (const pageLog of [page1, page2]) {
      const asStrings = pageLog.map((c) => JSON.stringify(c));
      expect(asStrings).toContain(JSON.stringify(['from', 'transactions']));
      expect(asStrings).toContain(JSON.stringify(['gte', 'occurred_on', '2026-08-01']));
      expect(asStrings).toContain(JSON.stringify(['lte', 'occurred_on', '2026-08-31']));
      expect(asStrings).toContain(JSON.stringify(['order', 'occurred_on', { ascending: false }]));
      expect(asStrings).toContain(JSON.stringify(['order', 'created_at', { ascending: false }]));
      // filtros combinados presentes em todas as páginas
      expect(asStrings).toContain(JSON.stringify(['eq', 'status', 'review']));
      expect(asStrings).toContain(JSON.stringify(['is', 'category_id', null]));
      expect(asStrings).toContain(JSON.stringify(['ilike', 'raw_description', '%mercado%']));
      expect(asStrings).toContain(JSON.stringify(['eq', 'account_id', 'acc-1']));
    }

    expect(JSON.stringify(page1)).toContain(JSON.stringify(['range', 0, 999]));
    expect(JSON.stringify(page2)).toContain(JSON.stringify(['range', 1000, 1999]));
  });

  it('o período é aplicado mesmo sem nenhum filtro de status/categoria', async () => {
    const rows = genRows(10);
    const { client, log } = makeFakeClient(rows, 10);
    const opts = buildTxListOptions(txFilterInitial(), BASE);
    const fetcher = createTxPageFetcher(client, opts);

    await fetcher(0, 9);

    const asStrings = log.map((c) => JSON.stringify(c));
    expect(asStrings).toContain(JSON.stringify(['gte', 'occurred_on', '2026-08-01']));
    expect(asStrings).toContain(JSON.stringify(['lte', 'occurred_on', '2026-08-31']));
    expect(asStrings).not.toContain(JSON.stringify(['eq', 'status', 'review']));
    expect(asStrings).not.toContain(JSON.stringify(['is', 'category_id', null]));
    // o perfil NÃO é filtrado no cliente: o isolamento é imposto pelo RLS
    // (transactions_select_own) usando o profile_id do JWT.
    expect(asStrings.some((s) => s.includes('profile_id'))).toBe(false);
  });

  it('opções sem busca nem conta não geram filtros desnecessários', () => {
    const opts = buildTxListOptions(txFilterInitial(), { ...BASE, search: '  ', accountId: '' });
    expect(opts.search).toBeUndefined();
    expect(opts.accountId).toBeUndefined();
  });
});
