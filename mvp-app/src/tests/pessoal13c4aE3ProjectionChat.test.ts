// pessoal13c4aE3ProjectionChat.test.ts — PESSOAL-13C4A-E3: follow-ups
// contextuais de projeção conectados ao fluxo COMPLETO do chat.
//
// Prova que:
//   1. um turno de projeção REAL persiste o contexto de projeção na conversa
//      (context.projection) — apenas intenção/mês/lente, nunca payload/valores;
//   2. um follow-up elíptico REUTILIZA esse contexto: re-consulta finanças,
//      aplica lente/mês/visão e devolve o payload fresh com a lente resolvida;
//   3. a lente de categoria persiste no contexto e é PRESERVADA numa troca de
//      visão de projeção real ("E o fechamento?" com contexto de lente);
//   4. clarificações de follow-up ("E no próximo mês?") NÃO consultam tabelas
//      financeiras, NÃO carregam projection e LIMPAM o contexto de projeção;
//   5. turnos tradicionais ("Quanto gastei este mês?") também limpam o contexto
//      de projeção e nunca carregam projection (regressão E2 intacta);
//   6. fresh === listMessages ESTRUTURALMENTE para follow-up com lente — o
//      MESMO JSON de projeção atravessa os canais, com lens somente o rótulo;
//   7. observabilidade: route='direct' na base e route='follow_up' no follow-up,
//      sempre com o trio source/outcome/cache e dentro de
//      OBSERVABILITY_SUCCESS_FIELDS; cache-hit não carrega route;
//   8. zero chamadas ao Gemini em todos os cenários.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatSupabaseRef = vi.hoisted(() => ({ current: null as any }));
vi.mock('../supabaseClient', () => ({
  supabase: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      if (!chatSupabaseRef.current || typeof chatSupabaseRef.current.from !== 'function') {
        throw new Error('supabaseClient mock não configurado (chatSupabaseRef.current).');
      }
      return chatSupabaseRef.current.from(table);
    },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getUser: async (): Promise<any> => ({ data: { user: null }, error: null }),
    },
  },
}));

// Congela o relógio de São Paulo do adapter (produção não injeta nowISO).
vi.mock('../../server/finance-ai/projectionAdapter', async () => {
  const actual = await import('../../server/finance-ai/projectionAdapter');
  return {
    ...actual,
    saoPauloTodayISO: () => '2026-08-10',
  };
});

import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import { sanitizeProjectionPayloadV1 } from '../../server/finance-ai/projectionPayloadV1';
import {
  setSanitizedSuccessSink,
  setSanitizedEventSink,
  OBSERVABILITY_SUCCESS_FIELDS,
} from '../../server/finance-ai/observability';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { listMessages } from '../lib/chatApi';
import { addMonths } from '../lib/period';

const NOW = '2026-08-10';

type ProjRow = {
  transaction_kind?: string | null;
  amount?: number | string | null;
  account_id?: string | null;
  category_id?: string | null;
  occurred_on?: string | null;
  status?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
};

const PAD2 = (v: number) => String(v).padStart(2, '0');

function cat(label: string): Array<{ display_name: string; canonical_path: string | null }> {
  return [{ display_name: label, canonical_path: null }];
}

function expRow(
  occurred_on: string,
  amount: number,
  category: 'mercado' | 'transporte' | 'anchor',
): ProjRow {
  const alias =
    category === 'mercado' ? 'c-mercado' : category === 'transporte' ? 'c-transporte' : 'c-anchor';
  const label =
    category === 'mercado' ? 'Mercado' : category === 'transporte' ? 'Transporte' : 'Anchor';
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: alias,
    occurred_on,
    status: 'paid',
    categories: cat(label),
  };
}

/**
 * Despesas mensais de 1000 reais cobrindo jul/2025..jul/2026 + âncora antiga +
 * agosto atual: a janela do motor muda conforme o mês de referência, então 13
 * meses completos garantem 12 meses COM dados na janela da base (ago/2025..jul/2026).
 */
function fullRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2025-01-10', 1000, 'anchor')];
  for (let i = 0; i < 13; i++) {
    const ym = addMonths({ year: 2025, month: 7 }, i);
    const catName = i % 2 === 0 ? 'mercado' : 'transporte';
    rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1000, catName));
  }
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

// ── Fake Supabase com estado: chat persistente + tabelas de projeção ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, unknown>;

function uniqViolation(): Error & { code: string } {
  const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  e.code = '23505';
  return e;
}

function conflictEq(a: unknown, b: unknown): boolean {
  return a !== null && b !== null && a === b;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FailHook = (table: string, action: string) => { data: unknown; count: null; error: unknown } | undefined;

interface PBFilter {
  op: 'is' | 'eq' | 'gte' | 'lte';
  key: string;
  value: unknown;
}

class ProjChatFake {
  state: Record<string, Row[]> = {
    transactions: [],
    account_profile_periods: [],
    categories: [],
    chat_conversations: [],
    chat_messages: [],
  };
  calls: Array<{ table: string; action: string }> = [];
  onRun?: FailHook;

  constructor(
    transactions: ProjRow[],
    periods: Array<{ account_id?: string | null; starts_on?: string | null; ends_on?: string | null }> = [],
  ) {
    this.state.transactions = transactions.map((r) => ({ ...r }));
    this.state.account_profile_periods = periods.map((p) => ({ ...p }));
  }

  seedExpenseCategories(): void {
    this.state.categories = [
      { display_name: 'Mercado', canonical_path: null, direction: 'expense' },
      { display_name: 'Transporte', canonical_path: null, direction: 'expense' },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): Record<string, any> {
    const self = this;
    const b = {
      table,
      filters: [] as PBFilter[],
      orders: [] as Array<{ key: string; asc: boolean }>,
      fromRange: 0,
      toRange: Number.POSITIVE_INFINITY,
      maybe: false,
      countOpt: false,
      action: 'select',
      rows: [] as Row[],
      patch: {} as Record<string, unknown>,
      onConflict: 'id',
      ignoreDuplicates: false,
    };
    const matches = (row: Row, f: PBFilter): boolean => {
      const v: unknown = row[f.key];
      if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
      if (f.op === 'eq') return v === f.value;
      if (f.op === 'gte' || f.op === 'lte') {
        const a = (row[f.key] ?? null) as string | number | null;
        const c = (f.value ?? null) as string | number | null;
        if (a === null || c === null) return false;
        const cmp = typeof a === 'string' && typeof c === 'string' ? a.localeCompare(c) : Number(a) - Number(c);
        return f.op === 'gte' ? cmp >= 0 : cmp <= 0;
      }
      return false;
    };
    const run = (): { data: unknown; count: number | null; error: unknown } => {
      self.calls.push({ table, action: b.action });
      const injected = self.onRun?.(table, b.action);
      if (injected) return injected;

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
        const asc = o.asc;
        selected = [...selected].sort((a, q) => {
          const av = (a[o.key] ?? null) as string | number | null;
          const qv = (q[o.key] ?? null) as string | number | null;
          if (av === qv) return 0;
          if (av === null) return 1;
          if (qv === null) return -1;
          if (typeof av === 'string' && typeof qv === 'string') {
            return av < qv ? (asc ? -1 : 1) : asc ? 1 : -1;
          }
          return Number(av) < Number(qv) ? (asc ? -1 : 1) : asc ? 1 : -1;
        });
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
      if (b.maybe) return { data: page[0] ?? null, count: null, error: null };
      return { data: page, count: b.countOpt ? total : null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: Record<string, any> = {
      select(_cols = '*', opts?: { count?: 'exact' }) {
        if (opts?.count === 'exact') {
          b.countOpt = true;
          return base;
        }
        b.countOpt = opts?.count === 'exact';
        return base;
      },
      is(key: string, value: unknown) {
        b.filters.push({ op: 'is', key, value });
        return base;
      },
      eq(key: string, value: unknown) {
        b.filters.push({ op: 'eq', key, value });
        return base;
      },
      gte(key: string, value: unknown) {
        b.filters.push({ op: 'gte', key, value });
        return base;
      },
      lte(key: string, value: unknown) {
        b.filters.push({ op: 'lte', key, value });
        return base;
      },
      order(key: string, opts?: { ascending?: boolean }) {
        b.orders.push({ key, asc: opts?.ascending ?? true });
        return base;
      },
      limit(limit: number) {
        b.toRange = limit - 1;
        return base;
      },
      range(from: number, to: number) {
        b.fromRange = from;
        b.toRange = to;
        return base;
      },
      maybeSingle() {
        b.maybe = true;
        return base;
      },
      single() {
        b.maybe = true;
        return base;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        b.action = 'upsert';
        b.rows = Array.isArray(rows) ? rows : [rows];
        b.onConflict = opts?.onConflict ?? 'id';
        b.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        return base;
      },
      insert(rows: Row) {
        b.action = 'insert';
        b.rows = [rows];
        return base;
      },
      update(patch: Record<string, unknown>) {
        b.action = 'update';
        b.patch = patch;
        return base;
      },
      then(resolve: (v: unknown) => unknown) {
        return resolve(run());
      },
    };
    return base;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

const CONV = { id: 'conv-1', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

function seedConv(c: ProjChatFake): void {
  c.state.chat_conversations = [{ ...CONV }];
}

function authOk(c: ProjChatFake): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValue({
    client: c as never,
    userId: 'user-test-0000-0000-0000-000000000000',
    user: null,
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-valido' },
    body: JSON.stringify(body),
  });
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

function countingGemini(): { client: GeminiClient; calls: number } {
  const state = { calls: 0 };
  const client: GeminiClient = {
    async sendMessage(): Promise<GeminiResponse> {
      state.calls += 1;
      throw new Error('Gemini NÃO pode ser chamado para projeção');
    },
  };
  return {
    client,
    get calls() {
      return state.calls;
    },
  };
}

function assistantCompleted(c: ProjChatFake, crid: string): Row | undefined {
  return c.state.chat_messages.find(
    (m) => m.role === 'assistant' && m.client_request_id === crid && m.status === 'completed',
  );
}

const txTables = ['transactions', 'account_profile_periods', 'categories'];

function txCallCount(c: ProjChatFake): number {
  return c.calls.filter((cc) => txTables.includes(cc.table)).length;
}

function bodyAs(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projOf(body: Record<string, unknown>): any {
  return body.projection;
}

function successOf(captured: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return captured.filter((e) => e.event === 'ask_resolved');
}

function failureOf(captured: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return captured.filter((e) => e.event === 'ask_failure');
}

/** Verifica recursivamente que a projeção só tem chaves conhecidas do contrato. */
function assertProjectionKeysOnly(value: unknown, allowed: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) assertProjectionKeysOnly(item, allowed);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    expect(allowed.has(key)).toBe(true);
    assertProjectionKeysOnly((value as Record<string, unknown>)[key], allowed);
  }
}

const PROJECTION_ALLOWED_KEYS = new Set([
  'version',
  'status',
  'intent',
  'quality',
  'reference',
  'coverage',
  'summary',
  'comparison',
  'categories',
  'remaining',
  'lens',
  'realizedCents',
  'reason',
  'month',
  'kind',
  'forecast',
  'horizonStart',
  'horizonEnd',
  'months',
  'registeredCents',
  'estimatedRemainingCents',
  'projectedCents',
  'historicalReferenceCents',
  'windowMonths',
  'coveredMonths',
  'minimumCoverageMonths',
  'requiredFullCoverageMonths',
  'windowStart',
  'windowEnd',
  'monthlyMeanCents',
  'annualScenarioCents',
  'totalBaseCents',
  'deviation',
  'deviationCents',
  'referenceBasis',
  'referenceCents',
  'expectedToDateCents',
  'futureRegisteredCents',
  'committedCents',
  'closingProjectionCents',
  'label',
  'categoriesCount',
  'mode',
  'code',
  'minimumCoveredMonths',
]);

const BASE_QUESTION = 'Qual a previsão de gastos para os próximos 12 meses?';

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  setSanitizedSuccessSink(null);
  setSanitizedEventSink(null);
  chatSupabaseRef.current = null;
});

afterEach(() => {
  setSanitizedSuccessSink(null);
  setSanitizedEventSink(null);
  registerGeminiClient(null);
  chatSupabaseRef.current = null;
});

describe('PESSOAL-13C4A-E3 — contexto de projeção é persistido e reutilizado pelo follow-up', () => {
  it('base persiste contexto (intent/referência); "E só mercado?" reutiliza, resolve a lente e persiste a lente nova', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const c = new ProjChatFake(fullRows());
    c.seedExpenseCategories();
    seedConv(c);
    authOk(c);

    const res1 = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res1.status).toBe(200);
    const body1 = await bodyAs(res1);
    const p1 = projOf(body1);
    expect(p1).toBeDefined();
    expect(p1.intent).toBe('projection_base');
    expect(p1.status).toBe('success');
    expect(p1.quality).toBe('full');
    expect(p1.reference).toEqual({ month: '2026-08', kind: 'current' });
    expect(p1.summary.monthlyMeanCents).toBe(100000);
    expect(p1.lens).toBeUndefined();
    expect(sanitizeProjectionPayloadV1(p1)).toEqual(p1);

    const ctx1 = c.state.chat_conversations[0].context as {
      projection?: unknown;
    } | null;
    expect(ctx1).toBeDefined();
    expect(ctx1?.projection).toEqual({
      version: 1,
      intent: 'projection_base',
      referenceMonth: '2026-08',
    });

    const res2 = await handler(
      postRequest({ question: 'E só mercado?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    const p2 = projOf(body2);
    expect(p2).toBeDefined();
    expect(p2.intent).toBe('projection_base');
    expect(p2.status).toBe('success');
    expect(p2.lens).toEqual({ label: 'Mercado' });
    expect(body2.answer as string).toContain('próximos 12 meses');
    expect(sanitizeProjectionPayloadV1(p2)).toEqual(p2);
    assertProjectionKeysOnly(p2, PROJECTION_ALLOWED_KEYS);

    const ctx2 = c.state.chat_conversations[0].context as {
      projection?: unknown;
    } | null;
    expect(ctx2?.projection).toEqual({
      version: 1,
      intent: 'projection_base',
      referenceMonth: '2026-08',
      lensKind: 'category',
      lensPath: 'Mercado',
      lensLabel: 'Mercado',
    });

    const row2 = assistantCompleted(c, 'r2');
    expect(row2).toBeDefined();
    const persisted = (row2?.payload as { projection?: unknown } | null | undefined)?.projection;
    expect(persisted).toEqual(p2);
    expect(gem.calls).toBe(0);
  });

  it('troca de visão de projeção real "E o fechamento?" preserva a lente do contexto', async () => {
    const c = new ProjChatFake(fullRows());
    c.seedExpenseCategories();
    seedConv(c);
    authOk(c);

    await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    await handler(
      postRequest({ question: 'E só mercado?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );

    const res3 = await handler(
      postRequest({ question: 'E o fechamento?', conversationId: 'conv-1', clientRequestId: 'r3' }),
    );
    expect(res3.status).toBe(200);
    const body3 = await bodyAs(res3);
    const p3 = projOf(body3);
    expect(p3).toBeDefined();
    expect(p3.intent).toBe('projection_current_month');
    expect(p3.reference).toEqual({ month: '2026-08', kind: 'current' });
    expect(p3.lens).toEqual({ label: 'Mercado' });
    expect(p3.comparison).toBeDefined();
    expect(body3.answer as string).toContain('contra a média mensal de');
    expect(body3.answer as string).toContain('igual à média mensal');
    expect(body3.answer as string).toContain('Novos lançamentos ainda podem alterar o total do mês.');
    expect(body3.answer as string).not.toContain('realizado até hoje');

    const ctx3 = c.state.chat_conversations[0].context as {
      projection?: { intent?: string; lensKind?: string; lensLabel?: string };
    } | null;
    expect(ctx3?.projection?.intent).toBe('projection_current_month');
    expect(ctx3?.projection?.lensKind).toBe('category');
    expect(ctx3?.projection?.lensLabel).toBe('Mercado');
    expect(sanitizeProjectionPayloadV1(p3)).toEqual(p3);
  });

  it('clarificação "E no próximo mês?" NÃO consulta banco, NÃO carrega projection e limpa o contexto', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);

    await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    const callsBefore = txCallCount(c);

    const res2 = await handler(
      postRequest({ question: 'E no próximo mês?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    expect(body2.engine).toBe('deterministic');
    expect(projOf(body2)).toBeUndefined();
    expect((body2.answer as string).includes('meses futuros')).toBe(true);
    expect(txCallCount(c)).toBe(callsBefore);

    const ctx2 = c.state.chat_conversations[0].context as { projection?: unknown } | null;
    expect(ctx2).toBeDefined();
    expect(ctx2?.projection).toBeNull();
  });

  it('turno tradicional "Quanto gastei este mês?" limpa o contexto de projeção e nunca carrega projection', async () => {
    const c = new ProjChatFake(fullRows());
    c.seedExpenseCategories();
    seedConv(c);
    authOk(c);

    await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );

    const res2 = await handler(
      postRequest({ question: 'Quanto gastei este mês?', conversationId: 'conv-1', clientRequestId: 't1' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    expect(body2.engine).toBe('deterministic');
    expect(projOf(body2)).toBeUndefined();
    expect((body2.answer as string).includes('totalizaram')).toBe(true);

    const ctx2 = c.state.chat_conversations[0].context as { projection?: unknown } | null;
    expect(ctx2).toBeDefined();
    expect(ctx2?.projection).toBeNull();
  });
});

describe('PESSOAL-13C4A-E3 — fresh === listMessages para follow-up com lente', () => {
  it('mesmo JSON de projeção (com lens=rótulo) nos canais fresh e listMessages', async () => {
    const c = new ProjChatFake(fullRows());
    c.seedExpenseCategories();
    seedConv(c);
    authOk(c);

    await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    const res2 = await handler(
      postRequest({ question: 'E só mercado?', conversationId: 'conv-1', clientRequestId: 'eql' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    const p2 = projOf(body2);
    expect(p2).toBeDefined();
    expect(p2.lens).toEqual({ label: 'Mercado' });
    expect(body2.engine).toBe('deterministic');
    expect(sanitizeProjectionPayloadV1(p2)).toEqual(p2);

    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const assistant = page.messages.find(
      (m) => m.clientRequestId === 'eql' && m.role === 'assistant' && m.status === 'completed',
    );
    expect(assistant).toBeDefined();
    expect((assistant as unknown as { text?: unknown }).text).toBe(body2.answer);
    expect((assistant as unknown as { projection?: unknown }).projection).toEqual(p2);
    assertProjectionKeysOnly(p2, PROJECTION_ALLOWED_KEYS);
  });
});

describe('PESSOAL-13C4A-E3 — observabilidade da rota e cache idempotente do follow-up', () => {
  it('base → route=direct; follow-up → route=follow_up, sempre com trio e dentro da allowlist', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const captured: Array<Record<string, unknown>> = [];
    setSanitizedSuccessSink((e) => captured.push(e as unknown as Record<string, unknown>));
    const c = new ProjChatFake(fullRows());
    c.seedExpenseCategories();
    seedConv(c);
    authOk(c);

    await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    const res2 = await handler(
      postRequest({ question: 'E só mercado?', conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(res2.status).toBe(200);
    expect(projOf(await bodyAs(res2))?.lens).toEqual({ label: 'Mercado' });

    const successes = successOf(captured);
    expect(successes).toHaveLength(2);
    expect(failureOf(captured)).toHaveLength(0);

    const [evDirect, evFollowUp] = successes;
    expect(evDirect.intent).toBe('projection_base');
    expect(evDirect.source).toBe('deterministic');
    expect(evDirect.outcome).toBe('full');
    expect(evDirect.cache).toBe('fresh');
    expect(evDirect.route).toBe('direct');

    expect(evFollowUp.intent).toBe('projection_base');
    expect(evFollowUp.source).toBe('deterministic');
    expect(evFollowUp.outcome).toBe('full');
    expect(evFollowUp.cache).toBe('fresh');
    expect(evFollowUp.route).toBe('follow_up');
    for (const ev of successes) {
      expect(Object.keys(ev).every((k) => (OBSERVABILITY_SUCCESS_FIELDS as readonly string[]).includes(k))).toBe(
        true,
      );
    }
    expect(gem.calls).toBe(0);
  });

  it('replay do MESMO client_request_id → cache=hit SEM route, mesma resposta, sem reconsulta, evento único', async () => {
    const captured: Array<Record<string, unknown>> = [];
    setSanitizedSuccessSink((e) => captured.push(e as unknown as Record<string, unknown>));
    const c = new ProjChatFake(fullRows());
    c.seedExpenseCategories();
    seedConv(c);
    authOk(c);
    const bodyReq = { question: 'E só mercado?', conversationId: 'conv-1', clientRequestId: 'eql' };

    await handler(postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }));
    const res2 = await handler(postRequest(bodyReq));
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    const p2 = projOf(body2);
    expect(p2?.lens).toEqual({ label: 'Mercado' });

    const txCallsBefore = c.calls.filter((cc) => cc.table === 'transactions').length;
    const res3 = await handler(postRequest(bodyReq));
    expect(res3.status).toBe(200);
    const body3 = await bodyAs(res3);
    expect(projOf(body3)).toEqual(p2);
    expect(body3.answer).toBe(body2.answer);
    expect(body3.engine).toBe('deterministic');
    expect(c.calls.filter((cc) => cc.table === 'transactions').length).toBe(txCallsBefore);

    const successes = successOf(captured);
    expect(successes).toHaveLength(3);
    const evHit = successes[2];
    expect(evHit.cache).toBe('hit');
    expect(evHit.outcome).toBe('full');
    expect('route' in evHit).toBe(false);
    expect(Object.keys(evHit).every((k) => (OBSERVABILITY_SUCCESS_FIELDS as readonly string[]).includes(k))).toBe(
      true,
    );
  });
});