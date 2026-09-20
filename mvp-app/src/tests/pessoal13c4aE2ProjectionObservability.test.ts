// pessoal13c4aE2ProjectionObservability.test.ts — PESSOAL-13C4A (Fase 6):
// integração da projeção determinística ao padrão de observabilidade existente
// do endpoint /api/finances/ask.
//
// Estende SEM paralelismo os eventos sanitizados já existentes:
//   - ask_resolved (sucesso) ganha o trio source/outcome/cache SOMENTE em
//     respostas de projeção (outros fluxos permanecem exatamente como antes);
//   - ask_failure (falha) preserva intent/stage/category/retryable/providerStatus
//     já existentes, sem nenhuma alteração estrutural.
//
// Prova que:
//   1. full/preliminary/insufficient → ask_resolved com engine='deterministic',
//      intent na allowlist, geminiCallCount=0, source='deterministic',
//      outcome={full|preliminary|insufficient}, cache='fresh', chaves ⊆
//      OBSERVABILITY_SUCCESS_FIELDS, exatamente UM evento final;
//   2. esclarecimento ("E a projeção?") → outcome='clarification', ZERO banco,
//      ZERO Gemini, sem projection no evento e na resposta;
//   3. replay idempotente (MESMO conversationId+clientRequestId): primeiro envio
//      cache='fresh', reenvio cache='hit' SEM reconsultar finanças e SEM duplicar
//      evento — sempre um único evento final por requisição;
//   4. falha sanitizada do adapter → ask_failure com intent='projection_base',
//      stage/category na allowlist, retryable=false, httpStatus=502,
//      providerStatus sanitizado (inteiro 100–599 quando disponível), sem
//      mensagem/sql/valores do Supabase; um único evento final;
//   5. sink de telemetria que LANÇA exceção NUNCA derruba a response (sucesso
//      continua 200; falha continua 502);
//   6. inspeção recursiva de TODAS as chaves E valores de qualquer evento:
//      nenhuma chave fora das allowlists fechadas e nenhum conteúdo proibido
//      (pergunta, resposta, valores, categorias, meses, contas/categorias,
//      conversa/requisição, token JWT, "erro simulado", "postgrest", SQL);
//   7. em NENHUM cenário o Gemini é chamado (custo zero).
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
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import {
  setSanitizedSuccessSink,
  setSanitizedEventSink,
  OBSERVABILITY_SUCCESS_FIELDS,
  OBSERVABILITY_FIELDS,
  type ProjectionSuccessOutcome,
} from '../../server/finance-ai/observability';
import { addMonths } from '../lib/period';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SinkEvent = Record<string, any>;

// ── Rows de projeção (mesmas do PESSOAL-13C4A-E2) ───────────────

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

/** 13 meses cheios jul/2025..jul/2026 + âncora antiga + agosto atual → full. */
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

/** Cobertura só de jan/2026..jul/2026 (7 meses) → preliminary. */
function preliminaryRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2026-01-10', 1000, 'anchor')];
  for (let i = 0; i < 7; i++) {
    const ym = addMonths({ year: 2026, month: 1 }, i);
    rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1000, 'mercado'));
  }
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

/** Cobertura só de jun/2026 e jul/2026 (2 meses) → insufficient. */
function insufficientRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2026-06-10', 1000, 'anchor')];
  rows.push(expRow('2026-06-15', 1000, 'mercado'));
  rows.push(expRow('2026-07-15', 1000, 'transporte'));
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

/**
 * União de dois fakes: (a) projeção — .select(..., {count:'exact'}) + .range e
 * filtros is/lte; (b) chat persistente — âncoras assistant, upsert INSERT com
 * UNIQUE triplo (onConflict/ignoreDuplicates) e update por filtros.
 * Registra TODAS as chamadas para assertar zero reconsulta no cache e zero
 * banco no esclarecimento; onRun injeta falha de banco por tabela.
 */
class ProjChatFake {
  state: Record<string, Row[]> = {
    transactions: [],
    account_profile_periods: [],
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

const txTables = ['transactions', 'account_profile_periods'];

function bodyAs(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

function txCallCount(c: ProjChatFake): number {
  return c.calls.filter((cc) => txTables.includes(cc.table)).length;
}

function successOf(captured: SinkEvent[]): SinkEvent[] {
  return captured.filter((e) => e.event === 'ask_resolved');
}

function failureOf(captured: SinkEvent[]): SinkEvent[] {
  return captured.filter((e) => e.event === 'ask_failure');
}

/** Percorre recursivamente chaves e valores (string) de qualquer evento. */
function collectKeysAndStrings(
  value: unknown,
  out: { keys: string[]; strings: string[] },
): void {
  if (typeof value === 'string') {
    out.strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKeysAndStrings(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out.keys.push(key);
    collectKeysAndStrings((value as Record<string, unknown>)[key], out);
  }
}

const BASE_QUESTION = 'Qual a previsão de gastos para os próximos 12 meses?';
const JAN_TO_JUL_PERIOD = [{ account_id: 'acc-a', starts_on: '2026-01-01', ends_on: null }];

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  setSanitizedSuccessSink(null);
  setSanitizedEventSink(null);
});

afterEach(() => {
  setSanitizedSuccessSink(null);
  setSanitizedEventSink(null);
  registerGeminiClient(null);
});

describe('PESSOAL-13C4A (Fase 6) — ask_resolved de projeção com o trio source/outcome/cache', () => {
  it.each([
    { name: 'full', rows: fullRows(), periods: [] as typeof JAN_TO_JUL_PERIOD, outcome: 'full', intent: 'projection_base' },
    { name: 'preliminary', rows: preliminaryRows(), periods: JAN_TO_JUL_PERIOD, outcome: 'preliminary', intent: 'projection_base' },
    { name: 'insufficient', rows: insufficientRows(), periods: [] as typeof JAN_TO_JUL_PERIOD, outcome: 'insufficient', intent: 'projection_base' },
  ])('$name: evento único com source/cache/outcome na allowlist, zero Gemini', async ({ rows, periods, outcome, intent }) => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const captured: SinkEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e as unknown as SinkEvent));
    const c = new ProjChatFake(rows, periods);
    authOk(c);

    const res = await handler(postRequest({ question: BASE_QUESTION }));
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);

    const successes = successOf(captured);
    expect(successes).toHaveLength(1);
    expect(failureOf(captured)).toHaveLength(0);
    const ev = successes[0];
    expect(ev.requestId).toBeTypeOf('string');
    expect(ev.engine).toBe('deterministic');
    expect(ev.intent).toBe(intent);
    expect(ev.geminiCallCount).toBe(0);
    expect(ev.elapsedMs).toBeTypeOf('number');
    expect(ev.source).toBe('deterministic');
    expect(ev.outcome).toBe(outcome);
    expect(ev.cache).toBe('fresh');
    expect(Object.keys(ev).every((k) => (OBSERVABILITY_SUCCESS_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(gem.calls).toBe(0);
  });

  it('esclarecimento "E a projeção?" → outcome=clarification, zero banco, zero Gemini', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const captured: SinkEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e as unknown as SinkEvent));
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);

    const res = await handler(
      postRequest({ question: 'E a projeção?', conversationId: 'conv-1', clientRequestId: 'clar1' }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    expect(body.engine).toBe('deterministic');
    expect(body.projection).toBeUndefined();
    expect(txCallCount(c)).toBe(0);

    const successes = successOf(captured);
    expect(successes).toHaveLength(1);
    expect(failureOf(captured)).toHaveLength(0);
    const ev = successes[0];
    expect(ev.intent).toBe('projection_clarification');
    expect(ev.source).toBe('deterministic');
    expect(ev.outcome).toBe('clarification');
    expect(ev.cache).toBe('fresh');
    expect(ev.geminiCallCount).toBe(0);
    expect(Object.keys(ev).every((k) => (OBSERVABILITY_SUCCESS_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(gem.calls).toBe(0);
  });
});

describe('PESSOAL-13C4A (Fase 6) — cache idempotente: fresh e hit sem reconsulta nem evento duplicado', () => {
  it('reenvio do MESMO client_request_id → cache=hit, sem consultar finanças, um único evento por requisição', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const captured: SinkEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e as unknown as SinkEvent));
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const bodyReq = { question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'caching' };

    const res1 = await handler(postRequest(bodyReq));
    expect(res1.status).toBe(200);
    const body1 = await bodyAs(res1);
    expect(body1.engine).toBe('deterministic');
    const taxesAfterFresh = txCallCount(c);
    expect(taxesAfterFresh).toBeGreaterThan(0);

    const res2 = await handler(postRequest(bodyReq));
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    expect(body2.answer).toBe(body1.answer);

    const successes = successOf(captured);
    expect(successes).toHaveLength(2);
    expect(failureOf(captured)).toHaveLength(0);
    expect(successes[0].cache).toBe('fresh');
    expect(successes[0].outcome).toBe('full');
    expect(successes[0].source).toBe('deterministic');
    expect(successes[1].cache).toBe('hit');
    expect(successes[1].outcome).toBe('full');
    expect(successes[1].source).toBe('deterministic');
    // O hit NÃO reconsultou finanças: contagem de tabelas de projeção inalterada.
    expect(txCallCount(c)).toBe(taxesAfterFresh);
    expect(gem.calls).toBe(0);
  });
});

describe('PESSOAL-13C4A (Fase 6) — falha sanitizada com intent, allowlist e providerStatus', () => {
  it('falha do adapter → ask_failure com intent projeta, stage/category/retryable, providerStatus sanitizado', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const captured: SinkEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e as unknown as SinkEvent));
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    c.onRun = (table, action) =>
      table === 'transactions' && action === 'select'
        ? { data: null, count: null, error: { message: 'erro simulado do postgrest', status: 503 } }
        : undefined;

    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'fail-ob' }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('erro simulado');
    expect(text).not.toContain('postgrest');

    expect(successOf(captured)).toHaveLength(0);
    const failures = failureOf(captured);
    expect(failures).toHaveLength(1);
    const ev = failures[0];
    expect(ev.intent).toBe('projection_base');
    expect(ev.stage).toBe('supabase_query');
    expect(ev.category).toBe('supabase_query_error');
    expect(ev.retryable).toBe(false);
    expect(ev.httpStatus).toBe(502);
    expect(ev.errorName).toBeTypeOf('string');
    expect(ev.providerStatus).toBe(503);
    expect(ev.elapsedMs).toBeTypeOf('number');
    expect(Object.keys(ev).every((k) => (OBSERVABILITY_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(gem.calls).toBe(0);
  });

  it('falha SEM status do provider → providerStatus ausente (nunca inventado)', async () => {
    const captured: SinkEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e as unknown as SinkEvent));
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    c.onRun = (table, action) =>
      table === 'transactions' && action === 'select'
        ? { data: null, count: null, error: { message: 'erro simulado do postgrest' } }
        : undefined;

    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'fail-ob2' }),
    );
    expect(res.status).toBe(502);
    const failures = failureOf(captured);
    expect(failures).toHaveLength(1);
    expect(failures[0].providerStatus).toBeUndefined();
  });
});

describe('PESSOAL-13C4A (Fase 6) — telemetria COM exceção nunca derruba a response', () => {
  it('successSink que lança: projeção continua 200 com evento válido descartado', async () => {
    setSanitizedSuccessSink(() => {
      throw new Error('sink de sucesso quebrado');
    });
    const c = new ProjChatFake(fullRows());
    authOk(c);
    const res = await handler(postRequest({ question: BASE_QUESTION }));
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    expect(body.engine).toBe('deterministic');
  });

  it('failureSink (eventSink) que lança: falha do adapter continua 502 controlado', async () => {
    setSanitizedEventSink(() => {
      throw new Error('sink de falha quebrado');
    });
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    c.onRun = (table, action) =>
      table === 'transactions' && action === 'select'
        ? { data: null, count: null, error: { message: 'erro simulado do postgrest', status: 502 } }
        : undefined;
    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'throw-sink' }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('erro simulado');
  });
});

describe('PESSOAL-13C4A (Fase 6) — inspeção recursiva: nada proibido em nenhum evento', () => {
  it('NENHUM evento (sucesso ou falha) contém pergunta, resposta, valores, categorias, meses, ids ou mensagem bruta', async () => {
    const captured: SinkEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e as unknown as SinkEvent));
    setSanitizedEventSink((e) => captured.push(e as unknown as SinkEvent));

    // Cenário de sucesso (full) com chat persistido (gera fresh).
    const ok = new ProjChatFake(fullRows());
    seedConv(ok);
    authOk(ok);
    const res1 = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'walk-good' }),
    );
    expect(res1.status).toBe(200);

    // Cenário de falha sanitizada.
    const bad = new ProjChatFake(fullRows());
    seedConv(bad);
    authOk(bad);
    bad.onRun = (table, action) =>
      table === 'transactions' && action === 'select'
        ? { data: null, count: null, error: { message: 'erro simulado do postgrest', status: 503 } }
        : undefined;
    const res2 = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'walk-bad' }),
    );
    expect(res2.status).toBe(502);

    expect(successOf(captured)).toHaveLength(1);
    expect(failureOf(captured)).toHaveLength(1);

    const all = collectedEveryKeyString(captured);
    // Só o composite é permitido do conteúdo financeiro: o requestId da própria
    // telemetria (identificador do evento, não dado do usuário).
    const forbidden = [
      'erro simulado',
      'postgrest',
      'Mercado',
      'Transporte',
      'Anchor',
      'acc-a',
      'c-mercado',
      'c-transporte',
      'conv-1',
      'user-test',
      'token-valido',
      'Bearer',
      'profile_id',
      'conversation_id',
      'client_request_id',
      'R$',
      BASE_QUESTION,
      'sem garantia nem recomendação',
      'fechamento estimado',
      'acima da referência',
      'abaixo da referência',
    ];
    for (const s of all.strings) {
      for (const f of forbidden) {
        expect(s).not.toContain(f);
      }
    }
    // Nenhuma chave fora das allowlists fechadas.
    for (const e of captured) {
      const allowed = e.event === 'ask_failure' ? OBSERVABILITY_FIELDS : OBSERVABILITY_SUCCESS_FIELDS;
      expect(Object.keys(e).every((k) => (allowed as readonly string[]).includes(k))).toBe(true);
    }
  });
});

function collectedEveryKeyString(events: SinkEvent[]): { keys: string[]; strings: string[] } {
  const out: { keys: string[]; strings: string[] } = { keys: [], strings: [] };
  for (const e of events) {
    collectKeysAndStrings(e, out);
  }
  // O requestId é o identificador do EVENTO (não dado do usuário); seu formato
  // não é inspecionado contra os marcadores proibidos (pode conter os dígitos).
  out.strings = out.strings.filter((s) => String(events[0]?.requestId) !== s);
  return out;
}