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
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import type { ChatContextState } from '../../server/chat/chatTypes';
import { contextFromTurn } from '../../server/chat/chatContext';
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { listMessages } from '../lib/chatApi';

const JSON_HEADERS = { 'content-type': 'application/json' };

const NOW8 = '2026-09-18';
const MAR = '2026-03-12';
const ABR = '2026-04-12';
const MAI = '2026-05-12';
const JUN = '2026-06-12';
const JUL = '2026-07-12';
const AGO = '2026-08-12';
const SIX_COMPLETE_PERIOD = { start: '2026-03-01', end: '2026-08-31' };

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

const SUP_CAT = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PAD_CAT = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };
const ENG_CAT = { display_name: 'English School', canonical_path: 'Educação > English School' };

function rowFor(cat: typeof SUP_CAT, amount: number, occurred_on: string): FakeRow {
  return {
    transaction_kind: 'expense' as const,
    amount,
    occurred_on,
    category_id: cat === ENG_CAT ? 'c-eng' : cat === PAD_CAT ? 'c-pad' : 'c-sup',
    categories: cat,
  };
}

const BASE_DATES = [MAR, ABR, MAI];
const RECENT_DATES = [JUN, JUL, AGO];

function growingRows8(): FakeRow[] {
  const rows: FakeRow[] = [];
  for (const d of BASE_DATES) {
    rows.push(rowFor(SUP_CAT, 100, d));
    rows.push(rowFor(PAD_CAT, 150, d));
  }
  for (const d of RECENT_DATES) {
    rows.push(rowFor(SUP_CAT, 400, d));
    rows.push(rowFor(PAD_CAT, 150, d));
  }
  for (const d of RECENT_DATES) rows.push(rowFor(ENG_CAT, 300, d));
  return rows;
}

function flatRows8(): FakeRow[] {
  const rows: FakeRow[] = [];
  for (const d of [...BASE_DATES, ...RECENT_DATES]) {
    rows.push(rowFor(SUP_CAT, 100, d));
    rows.push(rowFor(PAD_CAT, 150, d));
  }
  return rows;
}

function soloNewRows8(): FakeRow[] {
  const rows = flatRows8();
  for (const d of RECENT_DATES) rows.push(rowFor(ENG_CAT, 300, d));
  return rows;
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

function mkClient(rows: FakeRow[]): { fake: unknown; calls: string[] } {
  const calls: string[] = [];
  const base = (table: string): Record<string, any> => {
    const c: Record<string, any> = {};
    let cols = '*';
    for (const m of ['is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
      c[m] = () => c;
    }
    c.select = (sel?: string) => {
      cols = sel ?? '*';
      return c;
    };
    const live = () => rows.filter((r) => !r.deleted_at);
    c.range = (from: number, to: number) => {
      const page = live().slice(from, to + 1);
      return {
        ...c,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, count: table === 'transactions' ? live().length : undefined, error: null }),
      };
    };
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: live(), error: null });
    return c;
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
  rows: FakeRow[] = growingRows8(),
  nowISO = NOW8,
): Promise<{ ans: DeterministicAnswer; fake: unknown; context: ChatContextState }> {
  const { fake } = mkClient(rows);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, context: contextOf(ans) };
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

function authOk(client: StateFake): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: client as never,
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

function slotDate(monthsBack: number, day = 15): string {
  const d = new Date();
  const dt = new Date(d.getFullYear(), d.getMonth() - monthsBack, day);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

const BASE_OFFSETS = [6, 5, 4];
const RECENT_OFFSETS = [3, 2, 1];

function growingRowsDynamic(): FakeRow[] {
  const rows: FakeRow[] = [];
  for (const off of BASE_OFFSETS) {
    rows.push(rowFor(SUP_CAT, 100, slotDate(off)));
    rows.push(rowFor(PAD_CAT, 150, slotDate(off)));
  }
  for (const off of RECENT_OFFSETS) {
    rows.push(rowFor(SUP_CAT, 400, slotDate(off)));
    rows.push(rowFor(PAD_CAT, 150, slotDate(off)));
  }
  return rows;
}

function txCount(c: StateFake): number {
  return c.calls.filter((x) => x.table === 'transactions').length;
}

function assistantRowOf(c: StateFake, clientRequestId: string): Row | undefined {
  return c.state.chat_messages.find(
    (m) => m.role === 'assistant' && m.client_request_id === clientRequestId,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
});

describe('PESSOAL-13C3B.8 — savings: frase real e variações respondem determinístico', () => {
  it.each([
    'Onde tenho oportunidades de economia de 10%?',
    'Onde tenho oportunidades de economia?',
    'Onde tenho oportunidades para economizar?',
    'Onde tenho oportunidade de economizar?',
  ])('responde sem Gemini: "%s"', async (q) => {
    const { ans } = await firstTurn(q);
    expect(ans.intent).toBe('savings_opportunities');
    expect(ans.response.engine).toBe('deterministic');
    expect(ans.response.geminiCallCount).toBe(0);
    expect(ans.response.cards?.length).toBeGreaterThan(0);
    expect(ans.response.answer).toContain('Com uma redução de 10%');
    expect(ans.response.notice).toContain('Simulação de 10% sobre a média mensal recente');
  });

  it('opinião "economia do Brasil" continua caindo no Gemini (nulo)', async () => {
    const { fake } = mkClient(growingRows8());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'O que você acha da economia do Brasil?',
      nowISO: NOW8,
    });
    expect(ans).toBeNull();
  });

  it('janela six_complete + período consistente entre resposta, análise e cards', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    expect(ans.response.period).toEqual(SIX_COMPLETE_PERIOD);
    expect(ans.analysis?.windowStyle).toBe('six_complete');
    expect(ans.analysis?.anchorDate).toBe(NOW8);
    expect(ans.analysis?.simulationPct).toBe(10);
    expect(ans.analysis?.window?.start).toBe(SIX_COMPLETE_PERIOD.start);
    expect(ans.analysis?.window?.end).toBe(SIX_COMPLETE_PERIOD.end);
    const card = ans.response.cards?.[0];
    const labels = (card?.rows ?? []).map((r) => r.label);
    expect(labels).not.toContain('Período analisado');
    expect(labels).not.toContain('Classificação');
  });

  it('percentual decimal extraído da frase real (12,5%)', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 12,5%?');
    expect(ans.analysis?.simulationPct).toBe(12.5);
    expect(ans.response.answer).toContain('Com uma redução de 12,5%');
    const labels = Object.fromEntries((ans.response.cards?.[0]?.rows ?? []).map((r) => [r.label, r.value]));
    expect(labels['Economia mensal (cenário 12,5%)']).toContain('50,00');
  });

  it('"E 5%?" preserva o percentual e a janela (zero Gemini)', async () => {
    const { fake, context } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E 5%?',
      context,
      nowISO: NOW8,
    });
    expect(fu).not.toBeNull();
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.response.engine).toBe('deterministic');
    expect(fu?.response.geminiCallCount).toBe(0);
    expect(fu?.analysis?.simulationPct).toBe(5);
    expect(fu?.response.answer).toContain('Com uma redução de 5%');
    expect(fu?.response.period).toEqual(SIX_COMPLETE_PERIOD);
  });

  it('"E sem incluir este mês?" preserva o percentual ao trocar a janela', async () => {
    const { fake, context } = await firstTurn('Onde tenho oportunidades de economia de 5%?');
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E sem incluir este mês?',
      context,
      nowISO: NOW8,
    });
    expect(fu).not.toBeNull();
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.windowStyle).toBe('six_complete');
    expect(fu?.analysis?.simulationPct).toBe(5);
    expect(fu?.response.answer).toContain('Com uma redução de 5%');
    expect(fu?.response.period).toEqual(SIX_COMPLETE_PERIOD);
  });

  it('cadeia 10% → "E 5%?" → "E sem incluir este mês?" mantém 5% até o fim', async () => {
    let ctx = (await firstTurn('Onde tenho oportunidades de economia de 10%?')).context;
    const { fake } = mkClient(growingRows8());
    const f1 = await runDeterministicAsk({ supabase: fake as never, question: 'E 5%?', context: ctx, nowISO: NOW8 });
    expect(f1?.analysis?.simulationPct).toBe(5);
    ctx = contextOf(f1 as DeterministicAnswer, ctx);
    const f2 = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E sem incluir este mês?',
      context: ctx,
      nowISO: NOW8,
    });
    expect(f2?.analysis?.simulationPct).toBe(5);
    expect(f2?.response.answer).toContain('Com uma redução de 5%');
    expect(f2?.response.geminiCallCount).toBe(0);
  });

  it('sem cards: evidence legado preservado com período analisado', async () => {
    const noGrowth = await runDeterministicAsk({
      supabase: mkClient(flatRows8()).fake as never,
      question: 'Onde aumentei mais meus gastos?',
      nowISO: NOW8,
    });
    expect(noGrowth?.response.cards).toEqual([]);
    expect(noGrowth?.response.answer).toContain('não identifiquei categoria com crescimento significativo');
    expect(noGrowth?.response.evidence?.map((e) => e.label)).toContain('Período analisado');
    expect(noGrowth?.response.notice).toBeTruthy();

    const noSavings = await runDeterministicAsk({
      supabase: mkClient([]).fake as never,
      question: 'Onde tenho oportunidades de economia de 10%?',
      nowISO: NOW8,
    });
    expect(noSavings?.response.cards).toEqual([]);
    expect(noSavings?.response.answer).toContain('Não há dados suficientes');
    expect(noSavings?.response.evidence?.map((e) => e.label)).toContain('Período analisado');
    expect(noSavings?.response.notice).toBeTruthy();
  });
});

describe('PESSOAL-13C3B.8 — cards de crescimento claros e resumo separado', () => {
  it('resumo misto (crescimento + novo) com contagem amigável', async () => {
    const { ans } = await firstTurn('Onde aumentei mais meus gastos?', growingRows8());
    expect(ans.response.answer).toContain('crescimento significativo em 2 categorias');
    expect(ans.response.answer).toContain('Encontrei 2 mudanças relevantes neste período:');
    expect(ans.response.answer).toContain('1 categoria que passou a aparecer no período recente');
    expect(ans.response.answer).toContain('1 categoria com aumento de gasto');

    const newCard = ans.response.cards?.[0];
    expect(newCard?.kind).toBe('new');
    const newRows = Object.fromEntries((newCard?.rows ?? []).map((r) => [r.label, r.value]));
    expect(newRows['Média mensal (período recente)']).toContain('300,00');
    expect(newRows['Aumento mensal observado']).toContain('300,00');
    expect(newRows['Despesas recentes']).toBe('3');
    expect(Object.keys(newRows)).not.toContain('Média anterior (por mês)');
    expect(Object.keys(newRows)).not.toContain('Classificação');

    const growthCard = ans.response.cards?.[1];
    expect(growthCard?.kind).toBe('growth');
    const growthRows = Object.fromEntries((growthCard?.rows ?? []).map((r) => [r.label, r.value]));
    expect(growthRows['Média anterior (por mês)']).toContain('100,00');
    expect(growthRows['Média recente (por mês)']).toContain('400,00');
    expect(growthRows['Variação relativa']).toBe('300%');
    expect(Object.keys(growthRows)).not.toContain('Período analisado');
    expect(Object.keys(growthRows)).not.toContain('Classificação');
  });

  it('singular: 1 mudança relevante (categoria que passou a aparecer)', async () => {
    const { ans } = await firstTurn('Onde aumentei mais meus gastos?', soloNewRows8());
    expect(ans.response.answer).toContain('crescimento significativo em 1 categoria');
    expect(ans.response.answer).toContain(
      'Encontrei 1 mudança relevante neste período: 1 categoria que passou a aparecer no período recente.',
    );
  });

  it('nenhum termo técnico interno nos cards', async () => {
    const { ans } = await firstTurn('Onde aumentei mais meus gastos?', growingRows8());
    const serialized = JSON.stringify(ans.response.cards);
    for (const forbidden of ['Classificação', 'categoria nova', 'Período analisado']) {
      expect(serialized).not.toContain(forbidden);
    }
    const savings = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    expect(JSON.stringify(savings.ans.response.cards)).not.toContain('Período analisado');
  });
});

describe('PESSOAL-13C3B.8 — endpoint: cadeia real, cache completed e F5/listMessages', () => {
  it('10% → "E 5%?" → "E sem incluir este mês?", cache idêntico e transporte via listMessages', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);

    authOk(c);
    const r1 = await handler(
      postRequest({
        question: 'Onde tenho oportunidades de economia de 10%?',
        conversationId: 'conv-1',
        clientRequestId: 'r1',
      }),
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { engine: string; answer: string; cards: unknown[]; notice: string };
    expect(b1.engine).toBe('deterministic');
    expect(b1.answer).toContain('Com uma redução de 10%');
    expect(b1.cards.length).toBeGreaterThan(0);
    expect(b1.notice).toBeTruthy();
    expect(c.state.chat_conversations[0].context?.analysis?.intent).toBe('savings_opportunities');
    expect(c.state.chat_conversations[0].context?.analysis?.simulationPct).toBe(10);

    authOk(c);
    const r2 = await handler(
      postRequest({ question: 'E 5%?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { engine: string; answer: string };
    expect(b2.engine).toBe('deterministic');
    expect(b2.answer).toContain('Com uma redução de 5%');
    expect(c.state.chat_conversations[0].context?.analysis?.simulationPct).toBe(5);

    authOk(c);
    const r3 = await handler(
      postRequest({ question: 'E sem incluir este mês?', conversationId: 'conv-1', clientRequestId: 'r3' }),
    );
    expect(r3.status).toBe(200);
    const b3 = (await r3.json()) as { engine: string; answer: string };
    expect(b3.engine).toBe('deterministic');
    expect(b3.answer).toContain('Com uma redução de 5%');
    expect(c.state.chat_conversations[0].context?.analysis?.simulationPct).toBe(5);
    expect(c.state.chat_conversations[0].context?.analysis?.windowStyle).toBe('six_complete');

    const txBefore = txCount(c);
    authOk(c);
    const r3b = await handler(
      postRequest({ question: 'E sem incluir este mês?', conversationId: 'conv-1', clientRequestId: 'r3' }),
    );
    expect(r3b.status).toBe(200);
    const b3b = (await r3b.json()) as { engine: string; answer: string };
    expect(b3b.engine).toBe('deterministic');
    expect(b3b.answer).toBe(b3.answer);
    expect(txCount(c)).toBe(txBefore);
    expect(c.state.chat_messages).toHaveLength(6);

    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const completed = page.messages.filter((m) => m.role === 'assistant' && m.status === 'completed');
    expect(completed).toHaveLength(3);
    const last = completed[completed.length - 1];
    expect(last.cards).toBeDefined();
    expect(last.cards?.length).toBeGreaterThan(0);
    expect(last.notice).toBeDefined();
    expect(last.notice?.length).toBeGreaterThan(0);
    expect(last.engine).toBe('deterministic');
    expect(last.periodAnalyzed).toBeDefined();
    const rowLabels = (last.cards ?? []).flatMap((x) => x.rows.map((r) => r.label));
    expect(rowLabels).not.toContain('Período analisado');

    const persisted = assistantRowOf(c, 'r3')?.payload as
      | { cards?: Array<{ rows: Array<{ label: string }> }>; notice?: string }
      | undefined;
    expect(persisted?.notice).toBe(last.notice);
    expect(persisted?.cards?.[0]?.rows || []).toEqual(last.cards?.[0]?.rows || []);
  });
});