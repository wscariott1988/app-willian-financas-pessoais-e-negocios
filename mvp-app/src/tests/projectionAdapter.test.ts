import { describe, it, expect } from 'vitest';
import {
  fetchProjection,
  fetchAllProjectionPages,
  fetchPersistedProjectionPeriods,
  buildTransactionPageFetcher,
  saoPauloTodayISO,
  ProjectionDataError,
  PROJECTION_PAGE_SIZE,
} from '../../server/finance-ai/projectionAdapter';
import { UNCATEGORIZED_LABEL, type ProjectionEngineResult, type ProjectionSuccess } from '../lib/analyticsProjection';

function expectSuccess(r: ProjectionEngineResult): asserts r is ProjectionSuccess {
  expect(r.status).toBe('success');
}

const PAD = (v: number) => String(v).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${PAD(m)}-${PAD(d)}`;
const centsOf = (reais: number) => Math.round(reais * 100);

type DbRow = Record<string, unknown>;

interface CallRecord {
  table: string;
  selectColumns: string | null;
  predicates: Array<{ op: 'is' | 'eq' | 'lte' | 'gte'; key: string; value: unknown }>;
  orders: Array<{ column: string; ascending: boolean }>;
  rangeFrom: number;
  rangeTo: number;
}

function makeSupabaseMock(
  rowsByTable: Record<string, DbRow[]>,
  opts: { failTables?: string[] } = {},
): { client: any; calls: CallRecord[]; accessed: string[] } {
  const calls: CallRecord[] = [];
  const accessed: string[] = [];

  const builder = (table: string) => {
    const rec: CallRecord = {
      table,
      selectColumns: null,
      predicates: [],
      orders: [],
      rangeFrom: 0,
      rangeTo: 0,
    };
    const pool = rowsByTable[table] ?? [];
    const apply = () => {
      let out = pool;
      for (const p of rec.predicates) {
        if (p.op === 'is' && p.value === null) out = out.filter((r) => r[p.key] == null);
        else if (p.op === 'is') out = out.filter((r) => r[p.key] === p.value);
        else if (p.op === 'lte') out = out.filter((r) => (r[p.key] as string) <= (p.value as string));
        else if (p.op === 'gte') out = out.filter((r) => (r[p.key] as string) >= (p.value as string));
        else out = out.filter((r) => r[p.key] === p.value);
      }
      const sorted = [...out].sort((a, b) => {
        for (const o of rec.orders) {
          const av = a[o.column] as string;
          const bv = b[o.column] as string;
          if (av === bv) continue;
          const cmp: number = av < bv ? -1 : 1;
          return o.ascending ? cmp : -cmp;
        }
        return 0;
      });
      return sorted;
    };
    const b: any = {
      select(columns: string) {
        rec.selectColumns = columns;
        return b;
      },
      is(key: string, value: unknown) {
        rec.predicates.push({ op: 'is', key, value });
        return b;
      },
      eq(key: string, value: unknown) {
        rec.predicates.push({ op: 'eq', key, value });
        return b;
      },
      lte(key: string, value: unknown) {
        rec.predicates.push({ op: 'lte', key, value });
        return b;
      },
      gte(key: string, value: unknown) {
        rec.predicates.push({ op: 'gte', key, value });
        return b;
      },
      order(column: string, o: { ascending?: boolean } = {}) {
        rec.orders.push({ column, ascending: o.ascending ?? true });
        return b;
      },
      range(from: number, to: number) {
        rec.rangeFrom = from;
        rec.rangeTo = to;
        return b;
      },
      then(resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        calls.push(rec);
        const fails = opts.failTables?.includes(table) ?? false;
        const payload = fails
          ? { data: null, error: { message: 'segredo interno do banco (user=admin, password=xptn)' }, count: null }
          : (() => {
              const list = apply();
              return {
                data: list.slice(rec.rangeFrom, rec.rangeTo + 1),
                error: null,
                count: list.length,
              };
            })();
        return Promise.resolve(payload).then(resolve, reject);
      },
    };
    return b;
  };

  const client = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        accessed.push(prop);
        if (prop === 'from') return builder;
        return undefined;
      },
    },
  );

  return { client, calls, accessed };
}

function tx(
  id: string,
  opts: Partial<Pick<DbRow, 'transaction_kind' | 'amount' | 'account_id' | 'category_id' | 'occurred_on' | 'status' | 'deleted_at' | 'categories'>>,
): DbRow {
  return {
    id,
    transaction_kind: opts.transaction_kind ?? 'expense',
    amount: opts.amount ?? 1,
    account_id: opts.account_id ?? 'acc-a',
    category_id: opts.category_id ?? null,
    occurred_on: opts.occurred_on ?? '2026-03-10',
    status: opts.status ?? 'paid',
    created_at: `${opts.occurred_on ?? '2026-03-10'}T12:00:00Z`,
    deleted_at: opts.deleted_at ?? null,
    categories: opts.categories ?? null,
  };
}

// Âncora que garante cobertura total da janela via fallback em memória
// (despesa em 2025-01-01 cobre o mês de janeiro/2025 e todos os seguintes).
function anchorRows(): DbRow[] {
  return [tx('anchor-2025-01', { account_id: 'acc-a', occurred_on: '2025-01-01', amount: 1 })];
}

function monthTxRows(year: number, month: number, count: number): DbRow[] {
  const rows: DbRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      tx(`tx-${year}-${PAD(month)}-${i}`, {
        amount: 123.45,
        account_id: `acc-${i % 8}`,
        occurred_on: ymd(year, month, (i % 28) + 1),
        status: i % 2 === 0 ? 'paid' : 'scheduled',
      }),
    );
  }
  return rows;
}

function txCall(calls: CallRecord[]): CallRecord[] {
  return calls.filter((c) => c.table === 'transactions');
}

function predicateKey(calls: CallRecord[], key: string): boolean {
  return calls.some((c) => c.predicates.some((p) => p.key === key));
}

describe('ProjectionAdapter — paginação completa e sem duplicação', () => {
  it('percorre todas as páginas (30 de 1000) sem perder nem duplicar', async () => {
    const transactions = [
      ...monthTxRows(2025, 8, 2500),
      ...monthTxRows(2025, 9, 2500),
      ...monthTxRows(2025, 10, 2500),
      ...monthTxRows(2025, 11, 2500),
      ...monthTxRows(2025, 12, 2500),
      ...monthTxRows(2026, 1, 2500),
      ...monthTxRows(2026, 2, 2500),
      ...monthTxRows(2026, 3, 2500),
      ...monthTxRows(2026, 4, 2500),
      ...monthTxRows(2026, 5, 2500),
      ...monthTxRows(2026, 6, 2500),
      ...monthTxRows(2026, 7, 2500),
    ];
    const { client, calls } = makeSupabaseMock({
      transactions,
      account_profile_periods: [],
    });

    const r = await fetchProjection(client, { todayISO: '2026-08-15' });

    const interval = PROJECTION_PAGE_SIZE - 1;
    expectSuccess(r);
    expect(r.quality).toBe('full');
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.summary.totalBaseCents).toBe(12 * 2500 * centsOf(123.45));

    const txCalls = txCall(calls);
    const fullPages = Math.floor(30000 / PROJECTION_PAGE_SIZE);
    expect(txCalls.length).toBe(fullPages);
    expect(txCalls.every((c) => c.rangeFrom % PROJECTION_PAGE_SIZE === 0)).toBe(true);
    expect(txCalls.every((c) => c.rangeTo - c.rangeFrom === interval)).toBe(true);
    expect(txCalls.map((c) => c.rangeFrom)).toEqual(
      Array.from({ length: fullPages }, (_, i) => i * PROJECTION_PAGE_SIZE),
    );
    expect(txCalls.every((c) => predValue(c, 'occurred_on') === '2026-08-31')).toBe(true);
    expect(txCalls.every((c) => predicateOf(c, 'deleted_at'))).toBe(true);
  });

  it('fetchAllProjectionPages não termina antes de atingir o count exato', async () => {
    const starts: number[] = [];
    const out = await fetchAllProjectionPages<number>(
      (from, to) => {
        starts.push(from);
        return Promise.resolve({ data: [1, 2, 3], error: null, count: 9 });
      },
      3,
    );
    expect(out).toHaveLength(9);
    expect(starts).toEqual([0, 3, 6]);
  });

  it('erro em qualquer página vira ProjectionDataError', async () => {
    await expect(
      fetchAllProjectionPages<number>(
        () => Promise.resolve({ data: null, error: { message: 'x' }, count: null }),
        10,
      ),
    ).rejects.toBeInstanceOf(ProjectionDataError);
  });

  it('fronteira entre páginas: occurred_on e created_at idênticos não perdem nem duplicam', async () => {
    const N = 23;
    const rows = Array.from({ length: N }, (_, i) =>
      tx(`tie-${String(i).padStart(3, '0')}`, {
        account_id: 'acc-a',
        occurred_on: '2026-07-15',
        amount: 10,
      }),
    );
    const { client, calls } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const fetcher = buildTransactionPageFetcher(client, '2026-07-31', 7);
    const all = await fetchAllProjectionPages<DbRow>(fetcher, 7);

    expect(all).toHaveLength(N);
    const ids = all.map((r) => r.id as string);
    expect(new Set(ids).size).toBe(N);
    expect(ids).toEqual([...ids].sort());

    const txC1 = txCall(calls)[0];
    expect(txC1.orders.map((o) => o.column)).toEqual(['occurred_on', 'created_at', 'id']);
    expect(txC1.selectColumns).toBe(
      'transaction_kind, amount, account_id, category_id, occurred_on, status, categories(display_name, canonical_path)',
    );
    expect(new Set(txCall(calls).map((c) => c.rangeFrom))).toEqual(new Set([0, 7, 14, 21]));
  });

  it('mapeia amount para centavos de forma determinística (0,10 e 123,45)', async () => {
    const rows = [
      ...anchorRows(),
      tx('c-01', { account_id: 'acc-a', occurred_on: '2026-07-05', amount: 0.1 }),
      tx('c-02', { account_id: 'acc-a', occurred_on: '2026-07-06', amount: 123.45 }),
    ];
    const { client } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 7 },
    });
    expectSuccess(r);
    expect(r.comparison.kind).toBe('past');
    if (r.comparison.kind === 'past') {
      expect(r.comparison.realizedCents).toBe(10 + 12345);
      expect(r.comparison.realizedCents).toBe(centsOf(0.1) + centsOf(123.45));
    }
  });
});

function predicateOf(c: CallRecord, key: string): boolean {
  return c.predicates.some((p) => p.key === key);
}
function predValue(c: CallRecord, key: string): unknown {
  return c.predicates.find((p) => p.key === key)?.value;
}

describe('ProjectionAdapter — usa o cliente recebido, sem profile_id/service_role', () => {
  it('consulta somente transactions/account_profile_periods e nunca profile_id', async () => {
    const { client, calls, accessed } = makeSupabaseMock({
      transactions: anchorRows(),
      account_profile_periods: [],
    });

    await fetchProjection(client, { todayISO: '2026-08-15', referenceMonth: { year: 2026, month: 7 } });

    const tables = new Set(calls.map((c) => c.table));
    expect([...tables].sort()).toEqual(['account_profile_periods', 'transactions']);
    expect(predicateKey(calls, 'profile_id')).toBe(false);
    expect(predicateKey(calls, 'app.jwt_profile_id')).toBe(false);
    expect(accessed.includes('auth')).toBe(false);
    expect(accessed.includes('admin')).toBe(false);
    expect(accessed.includes('service_role')).toBe(false);
  });
});

describe('ProjectionAdapter — status não é filtro', () => {
  it('transações scheduled/pending/pagadas entram sem filtro de status', async () => {
    const rows = [
      ...anchorRows(),
      tx('r1', { occurred_on: '2026-03-05', amount: 10, status: 'paid' }),
      tx('r2', { occurred_on: '2026-03-10', amount: 20, status: 'scheduled' }),
      tx('r3', { occurred_on: '2026-03-15', amount: 30, status: 'pending' }),
    ];
    const { client, calls } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 3 },
    });
    expectSuccess(r);
    expect(r.comparison.kind).toBe('past');
    if (r.comparison.kind === 'past') expect(r.comparison.realizedCents).toBe(centsOf(60));
    expect(predicateKey(calls, 'status')).toBe(false);
  });
});

describe('ProjectionAdapter — income/transfer chegam ao motor, fora dos totais', () => {
  it('receita/transferência definem o início do fallback mas não entram nos totais', async () => {
    const rows = [
      tx('inc-2025-01', {
        transaction_kind: 'income',
        account_id: 'acc-a',
        occurred_on: '2025-01-01',
        amount: 9000,
      }),
      tx('trf-2025-01', {
        transaction_kind: 'transfer',
        account_id: 'acc-a',
        occurred_on: '2025-01-02',
        amount: 3000,
      }),
    ];
    const { client } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 3 },
    });

    expectSuccess(r);
    expect(r.quality).toBe('full');
    expect(r.basis.coveredMonths).toBe(12);
    expect(r.summary.totalBaseCents).toBe(0);
    if (r.comparison.kind === 'past') expect(r.comparison.realizedCents).toBe(0);
  });
});

describe('ProjectionAdapter — soft-delete excluída', () => {
  it('usa is(deleted_at, null) e a transação deletada não influi nos totais', async () => {
    const rows = [
      ...anchorRows(),
      tx('alive', { occurred_on: '2026-03-10', amount: 500 }),
      tx('deleted', { occurred_on: '2026-03-12', amount: 777, deleted_at: '2026-04-01T00:00:00Z' }),
    ];
    const { client, calls } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 3 },
    });
    expect(txCall(calls).every((c) => c.predicates.some((p) => p.op === 'is' && p.key === 'deleted_at' && p.value === null))).toBe(true);
    expectSuccess(r);
    if (r.comparison.kind === 'past') expect(r.comparison.realizedCents).toBe(centsOf(500));
  });
});

describe('ProjectionAdapter — períodos persistidos mapeados para o motor', () => {
  it('períodos persistidos chegam e o motor os usa (cobertura fora do fallback)', async () => {
    const transactions = [
      tx('only-march', { account_id: 'acc-x', occurred_on: '2026-03-10', amount: 500 }),
    ];
    const periods = [{ account_id: 'acc-x', starts_on: '2025-01-01', ends_on: null }];
    const { client, calls } = makeSupabaseMock({ transactions, account_profile_periods: periods });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 3 },
    });

    expect(calls.some((c) => c.table === 'account_profile_periods')).toBe(true);
    expectSuccess(r);
    expect(r.basis.coveredMonths).toBe(12);
    if (r.comparison.kind === 'past') expect(r.comparison.realizedCents).toBe(centsOf(500));
  });

  it('fetchPersistedProjectionPeriods vira ProjectionPeriod com ordem estável', async () => {
    const periods = [
      { id: 'p-200', account_id: 'acc-b', starts_on: '2025-09-01', ends_on: '2026-01-31' },
      { id: 'p-100', account_id: 'acc-a', starts_on: '2025-01-01', ends_on: null },
    ];
    const { client, calls } = makeSupabaseMock({ transactions: [], account_profile_periods: periods });

    const out = await fetchPersistedProjectionPeriods(client, 10);

    expect(out).toEqual([
      { accountId: 'acc-a', startsOn: '2025-01-01', endsOn: null },
      { accountId: 'acc-b', startsOn: '2025-09-01', endsOn: '2026-01-31' },
    ]);
    const c = calls.find((x) => x.table === 'account_profile_periods');
    expect(c?.selectColumns).toBe('account_id, starts_on, ends_on');
    expect(c?.orders.map((o) => o.column)).toEqual(['account_id', 'starts_on', 'id']);
    expect(predicateKey(calls.filter((x) => x.table === 'account_profile_periods'), 'profile_id')).toBe(false);
  });
});

describe('ProjectionAdapter — categoria nula vira "Sem categoria" no motor', () => {
  it('categoria nula chega nula e o motor cria o bucket padrão', async () => {
    const rows = [
      ...anchorRows(),
      tx('win-null', {
        account_id: 'acc-a',
        occurred_on: '2025-10-15',
        amount: 100,
        category_id: null,
        categories: null,
      }),
    ];
    const { client } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 3 },
    });
    expectSuccess(r);
    expect(r.categories.map((c) => c.label)).toContain(UNCATEGORIZED_LABEL);
  });

  it('categoria vem de canonical_path quando presente', async () => {
    const rows = [
      ...anchorRows(),
      tx('win-cat', {
        account_id: 'acc-a',
        occurred_on: '2025-10-15',
        amount: 200,
        category_id: 'cat-aluguel',
        categories: { display_name: 'Aluguel', canonical_path: 'Moradia|Aluguel' },
      }),
    ];
    const { client } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 3 },
    });
    expectSuccess(r);
    expect(r.categories.map((c) => c.label)).toContain('Moradia|Aluguel');
  });
});

describe('ProjectionAdapter — mês atual carrega até o fim do mês (inclui futuros)', () => {
  it('inclui lançamentos futuros registrados do mês, sem vazar para o mês seguinte', async () => {
    const rows = [
      ...anchorRows(),
      tx('ref-05', { occurred_on: '2026-08-05', amount: 300 }),
      tx('ref-15', { occurred_on: '2026-08-15', amount: 200 }),
      tx('ref-20', { occurred_on: '2026-08-20', amount: 400 }),
      tx('ref-31', { occurred_on: '2026-08-31', amount: 100 }),
      tx('sep-02', { occurred_on: '2026-09-02', amount: 999 }),
    ];
    const { client, calls } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, { todayISO: '2026-08-15' });

    expect(txCall(calls).every((c) => predValue(c, 'occurred_on') === '2026-08-31')).toBe(true);
    expectSuccess(r);
    expect(r.comparison.kind).toBe('current');
    if (r.comparison.kind === 'current') {
      expect(r.comparison.realizedCents).toBe(centsOf(500));
      expect(r.comparison.futureCents).toBe(centsOf(500));
      expect(r.comparison.committedCents).toBe(centsOf(1000));
    }
  });
});

describe('ProjectionAdapter — mês passado nunca usa dados posteriores', () => {
  it('para mês selecionado, busca apenas até o último dia daquele mês', async () => {
    const rows = [
      ...anchorRows(),
      tx('jul-05', { occurred_on: '2026-07-05', amount: 100 }),
      tx('jul-25', { occurred_on: '2026-07-25', amount: 400 }),
      tx('ago-10', { occurred_on: '2026-08-10', amount: 999 }),
    ];
    const { client, calls } = makeSupabaseMock({ transactions: rows, account_profile_periods: [] });

    const r = await fetchProjection(client, {
      todayISO: '2026-08-15',
      referenceMonth: { year: 2026, month: 7 },
    });

    expect(txCall(calls).every((c) => predValue(c, 'occurred_on') === '2026-07-31')).toBe(true);
    expectSuccess(r);
    expect(r.comparison.kind).toBe('past');
    if (r.comparison.kind === 'past') expect(r.comparison.realizedCents).toBe(centsOf(500));
  });
});

describe('ProjectionAdapter — relógio America/Sao_Paulo', () => {
  it('deriva o dia de São Paulo no rollover de UTC', () => {
    expect(saoPauloTodayISO(new Date('2026-08-15T23:00:00Z'))).toBe('2026-08-15');
    expect(saoPauloTodayISO(new Date('2026-08-16T02:00:00Z'))).toBe('2026-08-15');
    expect(saoPauloTodayISO(new Date('2026-08-16T03:00:00Z'))).toBe('2026-08-16');
    expect(saoPauloTodayISO(new Date('2026-01-01T02:59:00Z'))).toBe('2025-12-31');
  });
});

describe('ProjectionAdapter — falha controlada do Supabase', () => {
  it('erro nas transações falha com ProjectionDataError, sem expor a mensagem bruta', async () => {
    const { client, calls } = makeSupabaseMock(
      { transactions: anchorRows(), account_profile_periods: [] },
      { failTables: ['transactions'] },
    );
    await expect(
      fetchProjection(client, { todayISO: '2026-08-15', referenceMonth: { year: 2026, month: 7 } }),
    ).rejects.toBeInstanceOf(ProjectionDataError);
    try {
      await fetchProjection(client, { todayISO: '2026-08-15', referenceMonth: { year: 2026, month: 7 } });
    } catch (e) {
      const err = e as Error;
      expect(err.name).toBe('ProjectionDataError');
      expect(err.message).not.toContain('segredo interno');
    }
    expect(calls.some((c) => c.table === 'transactions')).toBe(true);
  });

  it('erro nos períodos persistidos também é controlado', async () => {
    const { client } = makeSupabaseMock(
      { transactions: anchorRows(), account_profile_periods: [] },
      { failTables: ['account_profile_periods'] },
    );
    await expect(
      fetchProjection(client, { todayISO: '2026-08-15', referenceMonth: { year: 2026, month: 7 } }),
    ).rejects.toBeInstanceOf(ProjectionDataError);
  });

  it('todayISO inválido lança RangeError antes de qualquer consulta', async () => {
    const { client, calls } = makeSupabaseMock({ transactions: anchorRows(), account_profile_periods: [] });
    await expect(
      fetchProjection(client, { todayISO: '15/08/2026' }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls.length).toBe(0);
  });
});