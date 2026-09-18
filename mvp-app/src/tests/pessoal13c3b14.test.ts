// pessoal13c3b14.test.ts — PESSOAL-13C3B.14: acabamento final das lentes de
// categorias excluídas. Prova que:
//   1. Aluguel/Empréstimo/Investimentos respondem como lente excluída com UMA
//      única explicação ("A categoria ... representa ..."), sem cards, sem
//      evidence e sem notice duplicado;
//   2. o período fica SOMENTE no contrato da resposta (badge global), nunca em
//      evidence nem repetido no texto;
//   3. zero Gemini nos caminhos determinísticos;
//   4. o aviso coletivo do fluxo geral usa concordância singular/plural correta
//      ("não entrou" para um sujeito, "não entraram" para vários);
//   5. o fluxo geral permanece intacto (notice coletivo + cards elegíveis) e
//      Combustível continua elegível com card;
//   6. cache completed e listMessages (F5) preservam exatamente a mesma resposta.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/supabaseServer', () => {
  class AuthTokenError extends Error {
    constructor(message = 'Token inválido.') {
      super(message);
      this.name = 'AuthTokenError';
    }
  }
  const createUserSupabaseClient = vi.fn();
  return { createUserSupabaseClient, AuthTokenError };
});

const chatSupabaseRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../supabaseClient', () => ({
  supabase: {
    from(table: string): any {
      const cur = chatSupabaseRef.current as { from(table: string): unknown } | null;
      if (!cur || typeof cur.from !== 'function') {
        throw new Error('supabaseClient mock não configurado (chatSupabaseRef.current).');
      }
      return cur.from(table);
    },
    auth: {
      getUser: async (): Promise<{ data: { user: null }; error: null }> => ({
        data: { user: null },
        error: null,
      }),
    },
  },
}));

import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { contextFromTurn } from '../../server/chat/chatContext';
import type { ChatContextState } from '../../server/chat/chatTypes';
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { listMessages } from '../lib/chatApi';

// ═══════════════ Lentes excluídas — textos conceituais únicos ═══════════════

const ALUGUEL_ANSWER =
  'A categoria Moradia > Aluguel representa um compromisso fixo e não entra na simulação percentual. O histórico de pagamentos sozinho não permite estimar uma economia real; seria necessário avaliar o contrato e suas condições.';
const EMPRESTIMO_ANSWER =
  'A categoria Dívidas > Empréstimo representa uma dívida e não entra na simulação percentual. Para estimar uma possível redução, seriam necessários saldo, prazo, taxa e CET.';
const INVEST_ANSWER =
  'A categoria Investimentos representa alocação patrimonial, não consumo reduzível, e por isso não entra na simulação percentual.';

// ═══════════════ 1. Cliente fake / fixtures (roteador) ═══════════════

type FakeRow = {
  transaction_kind?: string | null;
  amount?: number | string | null;
  occurred_on?: string | null;
  deleted_at?: string | null;
  category_id?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
};

type CatFakeRow = { display_name: string; canonical_path: string | null; direction?: string };

const SUP_CAT = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const ALUG_CAT = { display_name: 'Aluguel', canonical_path: 'Moradia > Aluguel' };
const EMP_CAT = { display_name: 'Empréstimo', canonical_path: 'Dívidas > Empréstimo' };
const INVEST_CAT = { display_name: 'Investimentos', canonical_path: 'Investimentos' };
const COMB_CAT = { display_name: 'Combustível', canonical_path: 'Transporte > Combustível' };
const FAR_CAT = { display_name: 'Farmácia', canonical_path: 'Saúde > Farmácia' };

const EXPENSE_CATS: CatFakeRow[] = [
  { ...SUP_CAT, direction: 'expense' },
  { ...ALUG_CAT, direction: 'expense' },
  { ...EMP_CAT, direction: 'expense' },
  { ...INVEST_CAT, direction: 'expense' },
  { ...COMB_CAT, direction: 'expense' },
  { ...FAR_CAT, direction: 'expense' },
];

function mkClient(
  rows: FakeRow[],
  cats: CatFakeRow[] = [],
): { fake: unknown; calls: string[] } {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c3: Record<string, any> = {};
    type F = { op: string; key: string; value: unknown };
    const filters: F[] = [];
    for (const m of ['is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
      c3[m] = (k: string, v?: unknown) => {
        if ((m === 'is' || m === 'gte' || m === 'lte' || m === 'eq') && typeof k === 'string') {
          filters.push({ op: m, key: k, value: v as string | null });
        }
        return c3;
      };
    }
    c3.select = (_sel?: string, _opts?: { count?: 'exact' }) => c3;
    const store = table === 'categories' ? cats : rows;
    const matches = (r: FakeRow | CatFakeRow): boolean =>
      filters.every((f) => {
        const v = (r as Record<string, unknown>)[f.key];
        if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
        if (f.op === 'eq') return v === f.value;
        if (f.op === 'gte') return v !== null && v !== undefined && String(v) >= String(f.value);
        if (f.op === 'lte') return v !== null && v !== undefined && String(v) <= String(f.value);
        return true;
      });
    const filtered = () => store.filter((r) => matches(r));
    c3.range = (from: number, to: number) => {
      const page = filtered().slice(from, to + 1);
      return {
        ...c3,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, count: table === 'transactions' ? filtered().length : undefined, error: null }),
      };
    };
    c3.then = (resolve: (v: unknown) => unknown) => resolve({ data: filtered(), error: null });
    return c3;
  };
  return {
    fake: {
      from: (t: string) => {
        calls.push(t);
        return base(t);
      },
    },
    calls,
  };
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

const JAN = '2026-01-15';
const FEV = '2026-02-15';
const MAR = '2026-03-15';
const ABR = '2026-04-15';
const MAI = '2026-05-15';
const JUN = '2026-06-15';
const NOW = '2026-07-25';

function rowFor(
  cat: { display_name: string; canonical_path: string | null },
  amount: number,
  d: string,
): FakeRow {
  return {
    transaction_kind: 'expense' as const,
    amount,
    occurred_on: d,
    category_id: `c-${cat.canonical_path ?? cat.display_name}`,
    categories: cat,
  };
}

/** Supermercado 400, Aluguel 2000, Empréstimo 1500, Investimentos 1200. */
function mixedRows(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [JAN, FEV, MAR, ABR, MAI, JUN]) {
    out.push(rowFor(SUP_CAT, 400, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
    out.push(rowFor(EMP_CAT, 1500, d));
    out.push(rowFor(INVEST_CAT, 1200, d));
  }
  return out;
}

/** Supermercado 400 + Aluguel 2000 (um único excluído) — teste de concordância singular. */
function singleExcludedRows(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [JAN, FEV, MAR, ABR, MAI, JUN]) {
    out.push(rowFor(SUP_CAT, 400, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
  }
  return out;
}

/** Combustível 200 + Aluguel 2000 + Empréstimo 1500 — Combustível continua elegível. */
function combustivelRows(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [JAN, FEV, MAR, ABR, MAI, JUN]) {
    out.push(rowFor(COMB_CAT, 200, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
    out.push(rowFor(EMP_CAT, 1500, d));
  }
  return out;
}

function contextOf(ans: DeterministicAnswer, prev: ChatContextState | null = null): ChatContextState {
  return contextFromTurn(prev, {
    intent: ans.intent,
    category: ans.category ?? null,
    periodAnalyzed: ans.response.periodAnalyzed ?? ans.response.period,
    answer: ans.response.answer,
    analysis: ans.analysis,
  });
}

async function firstTurn(
  q: string,
  rows: FakeRow[] = mixedRows(),
  cats: CatFakeRow[] = EXPENSE_CATS,
): Promise<{ ans: DeterministicAnswer; fake: unknown; context: ChatContextState }> {
  const { fake } = mkClient(rows, cats);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, context: contextOf(ans) };
}

async function lensFollowUp(
  q: string,
  rows: FakeRow[] = mixedRows(),
  cats: CatFakeRow[] = EXPENSE_CATS,
): Promise<DeterministicAnswer> {
  const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', rows, cats);
  const fu = await runDeterministicAsk({
    supabase: mkClient(rows, cats).fake as never,
    question: q,
    context: contextOf(ans),
    nowISO: NOW,
  });
  if (!fu) throw new Error(`esperado determinístico: "${q}"`);
  return fu;
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
});

// ═══════════════ 2. Lentes excluídas: uma única explicação ═══════════════

describe('PESSOAL-13C3B.14 — lentes excluídas: uma única explicação', () => {
  it('Aluguel: parágrafo único exato, sem cards/evidence/notice, período só no contrato e zero Gemini', async () => {
    const fu = await lensFollowUp('Só em aluguel?');
    expect(fu.intent).toBe('savings_opportunities');
    expect(fu.analysis?.categoryPath).toBe('Moradia > Aluguel');
    expect(fu.response.engine).toBe('deterministic');
    expect(fu.response.geminiCallCount).toBe(0);
    expect(fu.response.answer).toBe(ALUGUEL_ANSWER);
    expect(fu.response.cards).toEqual([]);
    expect(fu.response.evidence ?? []).toEqual([]);
    expect(fu.response.notice).toBeUndefined();
    expect(fu.response.periodAnalyzed).toEqual(fu.response.period);
    expect(fu.response.periodAnalyzed).not.toBeNull();
    const raw = JSON.stringify(fu.response);
    expect(raw).not.toContain('não entraram');
    expect(raw).not.toContain('Período analisado');
  });

  it('Empréstimo: parágrafo único exato, sem cards/evidence/notice, período só no contrato e zero Gemini', async () => {
    const fu = await lensFollowUp('Só em empréstimo?');
    expect(fu.intent).toBe('savings_opportunities');
    expect(fu.analysis?.categoryPath).toBe('Dívidas > Empréstimo');
    expect(fu.response.engine).toBe('deterministic');
    expect(fu.response.geminiCallCount).toBe(0);
    expect(fu.response.answer).toBe(EMPRESTIMO_ANSWER);
    expect(fu.response.cards).toEqual([]);
    expect(fu.response.evidence ?? []).toEqual([]);
    expect(fu.response.notice).toBeUndefined();
    expect(fu.response.periodAnalyzed).toEqual(fu.response.period);
    const raw = JSON.stringify(fu.response);
    expect(raw).not.toContain('não entraram');
    expect(raw).not.toContain('Período analisado');
  });

  it('Investimentos: parágrafo único exato, sem cards/evidence/notice, período só no contrato e zero Gemini', async () => {
    const fu = await lensFollowUp('E apenas investimentos?');
    expect(fu.intent).toBe('savings_opportunities');
    expect(fu.analysis?.categoryPath).toBe('Investimentos');
    expect(fu.response.engine).toBe('deterministic');
    expect(fu.response.geminiCallCount).toBe(0);
    expect(fu.response.answer).toBe(INVEST_ANSWER);
    expect(fu.response.cards).toEqual([]);
    expect(fu.response.evidence ?? []).toEqual([]);
    expect(fu.response.notice).toBeUndefined();
    expect(fu.response.periodAnalyzed).toEqual(fu.response.period);
    const raw = JSON.stringify(fu.response);
    expect(raw).not.toContain('não entraram');
    expect(raw).not.toContain('Período analisado');
  });
});

// ═══════════════ 3. Concordância e fluxo geral ═══════════════

describe('PESSOAL-13C3B.14 — concordância singular/plural e fluxo geral intacto', () => {
  it('aviso coletivo com UM excluído usa "não entrou" (sujeito singular)', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', singleExcludedRows());
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Moradia > Aluguel não entrou na simulação percentual.');
    expect(JSON.stringify(ans.response)).not.toContain('não entraram');
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('aviso coletivo com VÁRIOS excluídos mantém o plural "não entraram"', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Moradia > Aluguel, Dívidas > Empréstimo e Investimentos não entraram na simulação percentual.');
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('resposta geral continua com notice coletivo e cards elegíveis', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    expect((ans.response.cards ?? []).map((c) => c.title)).toEqual(['Alimentação > Supermercado']);
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Simulação com redução de 10% sobre a média mensal recente.');
    expect(notice).toContain('não entraram na simulação percentual');
    expect(notice).toContain('Investimentos');
    expect(ans.response.engine).toBe('deterministic');
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('Combustível permanece elegível com card no fluxo geral', async () => {
    const { ans } = await firstTurn('Onde posso economizar mais?', combustivelRows());
    const cards = ans.response.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('savings');
    expect(cards[0]?.title).toBe('Transporte > Combustível');
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('"Só em combustível?" continua gerando card normalmente (lente elegível)', async () => {
    const { ans } = await firstTurn('Onde posso economizar mais?', combustivelRows());
    const fu = await runDeterministicAsk({
      supabase: mkClient(combustivelRows(), EXPENSE_CATS).fake as never,
      question: 'Só em combustível?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.analysis?.categoryPath).toBe('Transporte > Combustível');
    expect((fu?.response.cards ?? []).map((c) => c.title)).toEqual(['Transporte > Combustível']);
    expect(fu?.response.notice).toContain('Simulação com redução de 10%');
    expect(fu?.response.geminiCallCount).toBe(0);
  });
});

// ═══════════════ 4. Endpoint: cache completed e F5 preservam a lente ═══════════════

const JSON_HEADERS = { 'content-type': 'application/json' };

const NOW8 = '2026-09-18';
const MAR8 = '2026-03-12';
const ABR8 = '2026-04-12';
const MAI8 = '2026-05-12';
const JUN8 = '2026-06-12';
const JUL8 = '2026-07-12';
const AGO8 = '2026-08-12';

function mixedRows8(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [MAR8, ABR8, MAI8, JUN8, JUL8, AGO8]) {
    out.push(rowFor(SUP_CAT, 400, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
    out.push(rowFor(EMP_CAT, 1500, d));
    out.push(rowFor(INVEST_CAT, 1200, d));
  }
  return out;
}

type Row = Record<string, any>;

function uniqViolation(): Error & { code: string } {
  const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  e.code = '23505';
  return e;
}

function conflictEq(a: unknown, b: unknown): boolean {
  return a !== null && b !== null && a === b;
}

interface SFBuilder {
  table: string;
  filters: Array<{ op: string; key: string; value: unknown }>;
  orders: Array<{ key: string; asc: boolean }>;
  fromRange: number;
  toRange: number;
  maybe: boolean;
  single: boolean;
  countOpt: boolean;
  action: 'select' | 'upsert' | 'insert' | 'update' | 'delete';
  rows: Row[];
  patch: Record<string, unknown>;
  onConflict: string;
  ignoreDuplicates: boolean;
}

class StateFake {
  state: Record<string, Row[]> = {
    transactions: [],
    categories: [],
    chat_conversations: [],
    chat_messages: [],
  };
  calls: Array<{ table: string; action: string }> = [];

  from(table: string): Record<string, any> {
    const self = this;
    const b: SFBuilder = {
      table,
      filters: [],
      orders: [],
      fromRange: 0,
      toRange: Number.POSITIVE_INFINITY,
      maybe: false,
      single: false,
      countOpt: false,
      action: 'select',
      rows: [],
      patch: {},
      onConflict: 'id',
      ignoreDuplicates: false,
    };
    const matches = (row: Row, f: { op: string; key: string; value: unknown }): boolean => {
      const v: unknown = row[f.key];
      if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
      if (f.op === 'eq') return v === f.value;
      if (f.op === 'gte' || f.op === 'lte') {
        const a = (row[f.key] ?? null) as string | number | null;
        const b2 = (f.value ?? null) as string | number | null;
        if (a === null || b2 === null) return false;
        const cmp =
          typeof a === 'string' && typeof b2 === 'string'
            ? a.localeCompare(b2)
            : Number(a) - Number(b2);
        return f.op === 'gte' ? cmp >= 0 : cmp <= 0;
      }
      return false;
    };
    const run = (): { data: unknown; count: number | null; error: unknown } => {
      self.calls.push({ table, action: b.action });
      if (b.action === 'upsert') {
        const keys = b.onConflict.split(',');
        for (const row of b.rows) {
          const dup = self.state[table].some((r) => keys.every((k) => conflictEq(r[k], row[k])));
          if (dup && !b.ignoreDuplicates) return { data: null, count: null, error: uniqViolation() };
          if (!dup) self.state[table].push(row);
        }
        return { data: null, count: null, error: null };
      }
      if (b.action === 'insert') {
        for (const row of b.rows) {
          if (
            table === 'chat_messages' &&
            self.state[table].some((r) =>
              ['conversation_id', 'client_request_id', 'role'].every((k) => conflictEq(r[k], row[k])),
            )
          ) {
            return { data: null, count: null, error: uniqViolation() };
          }
          self.state[table].push(row);
        }
        return { data: null, count: null, error: null };
      }
      let selected = self.state[table].filter((r) => b.filters.every((f) => matches(r, f)));
      for (const o of b.orders) {
        selected = [...selected].sort((a, q) => {
          const av = (a[o.key] ?? null) as string | number | null;
          const qv = (q[o.key] ?? null) as string | number | null;
          if (av === qv) return 0;
          if (av === null) return 1;
          if (qv === null) return -1;
          if (typeof av === 'string' && typeof qv === 'string') {
            return av < qv ? -1 : 1;
          }
          return Number(av) < Number(qv) ? -1 : 1;
        });
        if (!o.asc) selected.reverse();
      }
      if (b.action === 'update') {
        for (const row of selected) Object.assign(row, b.patch);
        return { data: null, count: null, error: null };
      }
      if (b.action === 'delete') {
        self.state[table] = self.state[table].filter((r) => !selected.includes(r));
        return { data: null, count: null, error: null };
      }
      const total = selected.length;
      const page = selected.slice(b.fromRange, b.toRange + 1);
      if (b.maybe || b.single) {
        return { data: page[0] ?? null, count: b.countOpt ? total : null, error: null };
      }
      return { data: page, count: b.countOpt ? total : null, error: null };
    };
    const baseRecord: Record<string, any> = {
      select(_cols = '*', opts?: { count?: 'exact' }) {
        b.countOpt = opts?.count === 'exact';
        return baseRecord;
      },
      is(key: string, value: unknown) {
        b.filters.push({ op: 'is', key, value });
        return baseRecord;
      },
      eq(key: string, value: unknown) {
        b.filters.push({ op: 'eq', key, value });
        return baseRecord;
      },
      gte(key: string, value: unknown) {
        b.filters.push({ op: 'gte', key, value });
        return baseRecord;
      },
      lte(key: string, value: unknown) {
        b.filters.push({ op: 'lte', key, value });
        return baseRecord;
      },
      order(key: string, opts?: { ascending?: boolean }) {
        b.orders.push({ key, asc: opts?.ascending ?? true });
        return baseRecord;
      },
      limit(limit: number) {
        b.toRange = limit - 1;
        return baseRecord;
      },
      range(from: number, to: number) {
        b.fromRange = from;
        b.toRange = to;
        return baseRecord;
      },
      maybeSingle() {
        b.maybe = true;
        return baseRecord;
      },
      single() {
        b.single = true;
        return baseRecord;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        b.action = 'upsert';
        b.rows = Array.isArray(rows) ? rows : [rows];
        b.onConflict = opts?.onConflict ?? 'id';
        b.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        return baseRecord;
      },
      insert(rows: Row) {
        b.action = 'insert';
        b.rows = [rows];
        return baseRecord;
      },
      update(patch: Record<string, unknown>) {
        b.action = 'update';
        b.patch = patch;
        return baseRecord;
      },
      then(resolve: (v: unknown) => unknown) {
        return resolve(run());
      },
    };
    return baseRecord;
  }
}

const CONV = { id: 'conv-1', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

function seedConv(c: StateFake): void {
  c.state.chat_conversations = [{ ...CONV }];
}

function seedCats(c: StateFake): void {
  c.state.categories = EXPENSE_CATS.map((cat) => ({ ...cat, id: `cat-${cat.canonical_path}` }));
}

function authOk(c: StateFake): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: c as never,
    userId: 'user-test-0000-0000-0000-000000000000',
    user: null,
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: 'Bearer token-valido' },
    body: JSON.stringify(body),
  });
}

function assistantRowOf(c: StateFake, clientRequestId: string): Row | undefined {
  return c.state.chat_messages.find(
    (m) => m.role === 'assistant' && m.client_request_id === clientRequestId,
  );
}

describe('PESSOAL-13C3B.14 — endpoint: cache completed e F5 preservam a lente excluída', () => {
  it('Aluguel: resposta única no POST, cache completed idêntico e listMessages (F5) transporta o mesmo conteúdo', async () => {
    const c = new StateFake();
    c.state.transactions = mixedRows8();
    seedConv(c);
    seedCats(c);

    authOk(c);
    const r1 = await handler(
      postRequest({ question: 'Onde tenho oportunidades de economia de 10%?', conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(r1.status).toBe(200);

    authOk(c);
    const r2 = await handler(
      postRequest({ question: 'Só em aluguel?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as {
      answer: string;
      engine: string;
      geminiCallCount: number;
      cards: unknown[];
      evidence: unknown[];
      notice: string;
      periodAnalyzed: { start: string; end: string };
    };
    expect(b2.engine).toBe('deterministic');
    expect(b2.geminiCallCount).toBe(0);
    expect(b2.answer).toBe(ALUGUEL_ANSWER);
    expect(b2.cards).toEqual([]);
    expect(b2.evidence).toEqual([]);
    expect(b2.notice).toBeUndefined();
    expect(b2.periodAnalyzed).toBeDefined();
    expect(JSON.stringify(b2)).not.toContain('não entraram');

    const txBefore = c.calls.filter((x) => x.table === 'transactions').length;
    authOk(c);
    const r2b = await handler(
      postRequest({ question: 'Só em aluguel?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(r2b.status).toBe(200);
    const b2b = (await r2b.json()) as typeof b2;
    expect(JSON.stringify(b2b)).toBe(JSON.stringify(b2));
    expect(c.calls.filter((x) => x.table === 'transactions').length).toBe(txBefore);

    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const completed = page.messages.filter((m) => m.role === 'assistant' && m.status === 'completed');
    const last = completed[completed.length - 1];
    expect(last.text).toBe(ALUGUEL_ANSWER);
    expect(last.notice).toBeUndefined();
    expect(last.cards).toEqual([]);
    expect(last.evidence ?? []).toEqual([]);
    expect(last.periodAnalyzed).toEqual(b2.periodAnalyzed);

    const persisted = assistantRowOf(c, 'r2')?.payload as
      | { cards?: unknown[]; evidence?: unknown[]; notice?: string }
      | undefined;
    expect(persisted?.notice).toBeUndefined();
    expect(persisted?.cards).toEqual([]);
    expect(persisted?.evidence).toBeUndefined();
  });
});