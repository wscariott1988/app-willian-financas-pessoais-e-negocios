// pessoal13c4aE2ProjectionChat.test.ts — PESSOAL-13C4A-E2: projeção
// conectada ao fluxo completo do chat.
//
// Conecta o ProjectionPayloadV1 (já sanitizado pela Fase 4A) em:
//   1. resposta fresca (AskResponse.projection);
//   2. cache/idempotência (clique duplo no MESMO client_request_id);
//   3. listMessages (payload lido do banco → UiMessage.projection).
//
// Prova que:
//   - fresh === cache === listMessages ESTRUTURALMENTE para full, preliminary e
//     insufficient: o MESMO JSON de projeção atravessa os três canais;
//   - projection NUNCA existe em esclarecimento semântico (ambiguidade), em
//     falha de infraestrutura do adapter (HTTP ≠ 200, âncora failed) nem em
//     intents não-projeção (regressão);
//   - IDs, UUIDs e campos desconhecidos NUNCA reaparecem na leitura: sanitizador
//     idempotente na fronteira única de gravação (sanitizeChatPayload) e
//     re-sanitização defensiva na leitura do cache (cachedResponseOf), mesmo
//     quando a linha do banco é adulterada via INSERT direto (PostgREST);
//   - payloads legados SEM projection voltam sem o campo (retrocompatível).
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
import { sanitizeChatPayload } from '../../server/chat/payloadSanitize';
import { sanitizeProjectionPayloadV1 } from '../../server/finance-ai/projectionPayloadV1';
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

function expRow(occurred_on: string, amount: number, category: 'mercado' | 'transporte' | 'anchor'): ProjRow {
  const alias = category === 'mercado' ? 'c-mercado' : category === 'transporte' ? 'c-transporte' : 'c-anchor';
  const label = category === 'mercado' ? 'Mercado' : category === 'transporte' ? 'Transporte' : 'Anchor';
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
 * agosto atual: a janela do motor muda conforme o mês de referência
 * (base → ago/2025..jul/2026; comparação com jul/2026 → jul/2025..jun/2026),
 * então 13 meses completos garantem 12 meses COM dados em ambas as janelas.
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

function assistantCompleted(c: ProjChatFake, crid: string): Row | undefined {
  return c.state.chat_messages.find(
    (m) => m.role === 'assistant' && m.client_request_id === crid && m.status === 'completed',
  );
}

const txTables = ['transactions', 'account_profile_periods'];

function bodyAs(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projOf(body: Record<string, unknown>): any {
  return body.projection;
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
  'realizedCents',
  'reason',
  'month',
  'kind',
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
  'code',
  'minimumCoveredMonths',
]);

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
});

afterEach(() => {
  registerGeminiClient(null);
});

const BASE_QUESTION = 'Qual a previsão de gastos para os próximos 12 meses?';

// Período persistido da conta que cobre integralmente jan/2026..jul/2026
// (faz o preliminary ter 7 meses totalmente cobertos no motor).
const JAN_TO_JUL_PERIOD = [{ account_id: 'acc-a', starts_on: '2026-01-01', ends_on: null }];

describe('PESSOAL-13C4A-E2 — resposta fresca carrega o payload de projeção sanitizado', () => {
  it('full: projection canônico (version/status/intent/quality/reference/coverage/summary/comparison/categories)', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    const p = projOf(body);
    expect(p).toBeDefined();
    expect(p.version).toBe(1);
    expect(p.status).toBe('success');
    expect(p.intent).toBe('projection_base');
    expect(p.quality).toBe('full');
    expect(p.reference).toEqual({ month: '2026-08', kind: 'current' });
    expect(p.coverage).toEqual({
      windowMonths: 12,
      coveredMonths: 12,
      minimumCoverageMonths: 6,
      requiredFullCoverageMonths: 12,
      windowStart: '2025-08',
      windowEnd: '2026-07',
    });
    expect(p.summary).toEqual({
      monthlyMeanCents: 100000,
      annualScenarioCents: 1200000,
      totalBaseCents: 1200000,
    });
    expect(p.comparison.referenceBasis).toBe('expected_to_date');
    expect(p.comparison.referenceCents).toBeTypeOf('number');
    expect(p.comparison.realizedCents).toBe(50000);
    expect(p.comparison.expectedToDateCents).toBeTypeOf('number');
    expect(p.comparison.futureRegisteredCents).toBe(0);
    expect(p.comparison.committedCents).toBe(50000);
    expect(typeof p.comparison.closingProjectionCents).toBe('number');
    expect(Array.isArray(p.categories)).toBe(true);
    expect(p.categories.length).toBeGreaterThan(0);
    expect(p.categories.length).toBeLessThanOrEqual(8);
    // Forma já sanitizada: sanitizar de novo é idempotente (igual estrutura).
    expect(sanitizeProjectionPayloadV1(p)).toEqual(p);
    assertProjectionKeysOnly(p, PROJECTION_ALLOWED_KEYS);
    // Persistido == respondido (fronteira única de gravação sanitizou o mesmo payload).
    const row = assistantCompleted(c, 'r1');
    expect(row).toBeDefined();
    const persisted = (row?.payload as { projection?: unknown } | null | undefined)?.projection;
    expect(persisted).toEqual(p);
  });

  it('preliminary: quality preliminary preserva projection', async () => {
    const c = new ProjChatFake(preliminaryRows(), JAN_TO_JUL_PERIOD);
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    const p = projOf(body);
    expect(p).toBeDefined();
    expect(p.status).toBe('success');
    expect(p.quality).toBe('preliminary');
    expect(p.coverage.coveredMonths).toBe(7);
    expect(p.coverage.minimumCoverageMonths).toBe(6);
    expect(p.coverage.requiredFullCoverageMonths).toBe(12);
    expect(sanitizeProjectionPayloadV1(p)).toEqual(p);
  });

  it('insufficient: projection presente com status/quality/reason canônicos, sem inventar agregados', async () => {
    const c = new ProjChatFake(insufficientRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    const p = projOf(body);
    expect(p).toBeDefined();
    expect(p.version).toBe(1);
    expect(p.status).toBe('insufficient');
    expect(p.quality).toBe('insufficient');
    expect(p.intent).toBe('projection_base');
    expect(p.reason).toEqual({
      code: 'covered_months_below_minimum',
      coveredMonths: 1,
      minimumCoveredMonths: 6,
    });
    expect(p.realizedCents).toBe(50000);
    expect(p.summary).toBeUndefined();
    expect(p.comparison).toBeUndefined();
    expect(p.categories).toBeUndefined();
    expect(sanitizeProjectionPayloadV1(p)).toEqual(p);
  });

  it('comparação mensal → união past (monthly_mean) sem campos exclusivos do mês atual', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({
        question: 'Qual a previsão para o mês passado comparada à média dos 12 meses anteriores?',
        conversationId: 'conv-1',
        clientRequestId: 'r1',
      }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    const p = projOf(body);
    expect(p).toBeDefined();
    expect(p.intent).toBe('projection_month_comparison');
    expect(p.reference).toEqual({ month: '2026-07', kind: 'past' });
    expect(p.comparison.referenceBasis).toBe('monthly_mean');
    expect(p.comparison.referenceCents).toBe(100000);
    expect(p.comparison.realizedCents).toBe(100000);
    expect(p.comparison.expectedToDateCents).toBeUndefined();
    expect(p.comparison.futureRegisteredCents).toBeUndefined();
    expect(p.comparison.committedCents).toBeUndefined();
    expect(p.comparison.closingProjectionCents).toBeUndefined();
    expect(p.summary.monthlyMeanCents).toBe(100000);
  });

  it('categorias → intent projection_categories com categorias mapeadas', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({
        question: 'Qual a projeção por categorias?',
        conversationId: 'conv-1',
        clientRequestId: 'r1',
      }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    const p = projOf(body);
    expect(p).toBeDefined();
    expect(p.intent).toBe('projection_categories');
    expect(Array.isArray(p.categories)).toBe(true);
    expect(p.categories.length).toBeGreaterThan(0);
    const labels = p.categories.map((categ: { label: string }) => categ.label);
    expect(labels).toContain('Mercado');
    expect(labels).toContain('Transporte');
    expect(sanitizeProjectionPayloadV1(p)).toEqual(p);
  });

  it('stateless (sem ids de chat): resposta fresca ainda carrega projection', async () => {
    const c = new ProjChatFake(fullRows());
    authOk(c);
    const res = await handler(postRequest({ question: BASE_QUESTION }));
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    const p = projOf(body);
    expect(p).toBeDefined();
    expect(p.status).toBe('success');
    expect(p.quality).toBe('full');
    expect(sanitizeProjectionPayloadV1(p)).toEqual(p);
  });
});

describe('PESSOAL-13C4A-E2 — igualdade estrutural fresh === cache === listMessages', () => {
  it.each([
    { name: 'full', rows: fullRows(), periods: [] },
    { name: 'preliminary', rows: preliminaryRows(), periods: JAN_TO_JUL_PERIOD },
    { name: 'insufficient', rows: insufficientRows(), periods: [] },
  ])('$name: mesmo JSON de projeção nos três canais', async ({ rows, periods }) => {
    const c = new ProjChatFake(rows, periods);
    seedConv(c);
    authOk(c);
    const bodyReq = { question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'eql' };

    const res1 = await handler(postRequest(bodyReq));
    expect(res1.status).toBe(200);
    const body1 = await bodyAs(res1);
    const p1 = projOf(body1);
    expect(p1).toBeDefined();
    expect(body1.engine).toBe('deterministic');
    expect(sanitizeProjectionPayloadV1(p1)).toEqual(p1);

    // Cache/idempotência: reenvio do MESMO client_request_id NÃO reconsulta as
    // tabelas de projeção — devolve exatamente o payload persistido.
    const txCallsBefore = c.calls.filter((cc) => txTables.includes(cc.table)).length;
    const res2 = await handler(postRequest(bodyReq));
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    expect(projOf(body2)).toEqual(p1);
    expect(body2.answer).toBe(body1.answer);
    expect(body2.engine).toBe('deterministic');
    expect(c.calls.filter((cc) => txTables.includes(cc.table)).length).toBe(txCallsBefore);

    // listMessages: mesma projeção lida do banco no browser.
    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const assistant = page.messages.find(
      (m) => m.clientRequestId === 'eql' && m.role === 'assistant' && m.status === 'completed',
    );
    expect(assistant).toBeDefined();
    expect((assistant as unknown as { text?: unknown }).text).toBe(body1.answer);
    expect((assistant as unknown as { projection?: unknown }).projection).toEqual(p1);
    expect(body1.answer).toContain('sem garantia nem recomendação');
    assertProjectionKeysOnly(p1, PROJECTION_ALLOWED_KEYS);
  });
});

describe('PESSOAL-13C4A-E2 — esclarecimento e intents não-projeção NUNCA carregam projection', () => {
  it('ambiguidade "E a projeção?" → 200 determinístico SEM projection e SEM consulta a tabelas financeiras', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: 'E a projeção?', conversationId: 'conv-1', clientRequestId: 'clar1' }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    expect(projOf(body)).toBeUndefined();
    expect((body.answer as string).includes('quatro cenários')).toBe(true);
    expect(c.calls.filter((cc) => txTables.includes(cc.table))).toHaveLength(0);
    const row = assistantCompleted(c, 'clar1');
    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown> | null | undefined;
    expect(payload === undefined || payload === null || !('projection' in payload)).toBe(true);
  });

  it('regressão: "Quanto gastei este mês?" (total_expenses) → SEM projection na resposta e no persistido', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: 'Quanto gastei este mês?', conversationId: 'conv-1', clientRequestId: 'tx1' }),
    );
    expect(res.status).toBe(200);
    const body = await bodyAs(res);
    expect(projOf(body)).toBeUndefined();
    const row = assistantCompleted(c, 'tx1');
    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown> | null | undefined;
    expect(payload === undefined || payload === null || !('projection' in payload)).toBe(true);
  });
});

describe('PESSOAL-13C4A-E2 — fronteira única de gravação + leitura defensiva do cache', () => {
  it('linha adulterada via INSERT direto: cache re-sanitiza e NUNCA devolve IDs/campos injetados', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const bodyReq = { question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'tamper' };

    const res1 = await handler(postRequest(bodyReq));
    expect(res1.status).toBe(200);
    const pFresh = projOf(await bodyAs(res1));
    expect(pFresh).toBeDefined();

    // Fronteira de gravação: o que o SERVIDOR persistiu é exatamente o payload sanitizado.
    const goodRow = assistantCompleted(c, 'tamper');
    expect(goodRow).toBeDefined();
    const persistedGood = (goodRow?.payload as { projection?: unknown } | null | undefined)?.projection;
    expect(persistedGood).toEqual(pFresh);

    // INSERT direto via PostgREST adultera a linha com UUIDs e campos desconhecidos.
    const evil = cloneJson<Record<string, unknown>>(pFresh as unknown as Record<string, unknown>);
    (evil as Record<string, unknown>).id = 'evil-uuid';
    (evil as Record<string, unknown>).profile_id = 'p-evil';
    (evil as Record<string, unknown>).transaction_context = '<script>bad</script>';
    const evilSummary = evil.summary as Record<string, unknown>;
    evilSummary.profileId = 'evil-summary-id';
    evilSummary.rawQuestion = 'Qual a previsão?';
    const evilComparison = evil.comparison as Record<string, unknown>;
    evilComparison.accountId = 'acc-evil';
    const evilRow = cloneJson<Row>(goodRow as unknown as Row);
    evilRow.payload = { engine: 'deterministic', geminiCallCount: 0, projection: evil };
    evilRow.created_at = '2026-08-10T12:00:00Z';
    c.state.chat_messages = c.state.chat_messages.map((m) =>
      m.role === 'assistant' && m.client_request_id === 'tamper' ? evilRow : m,
    );

    // Leitura defensiva (cachedResponseOf): re-sanitiza e devolve o payload CANÔNICO.
    const res2 = await handler(postRequest(bodyReq));
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    const pCached = projOf(body2);
    expect(pCached).toEqual(pFresh);
    assertProjectionKeysOnly(pCached, PROJECTION_ALLOWED_KEYS);
    const text2 = JSON.stringify(body2);
    expect(text2).not.toContain('evil');
    expect(text2).not.toContain('profile_id');
    expect(text2).not.toContain('<script>');
  });

  it('sanitizeChatPayload (fronteira de gravação): injetados descartados, inválido omitido, legado sem campo', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'unit' }),
    );
    expect(res.status).toBe(200);
    const pUnit = projOf(await bodyAs(res));
    expect(pUnit).toBeDefined();

    // Injeção em vários níveis → só o payload canônico sobrevive.
    const injected = cloneJson<unknown>(pUnit) as Record<string, unknown>;
    injected.id = 'inject-id';
    injected.secret = 'chave-que-nunca-deve-persistir';
    (injected.summary as Record<string, unknown>).profileId = 'inject-profile';
    const out = sanitizeChatPayload({ engine: 'deterministic', projection: injected });
    expect(out.projection).toEqual(pUnit);
    assertProjectionKeysOnly(out.projection, PROJECTION_ALLOWED_KEYS);

    // Estruturalmente inválido → omitido (nunca objeto parcial).
    const invalid = sanitizeChatPayload({ engine: 'deterministic', projection: { ...cloneJson(pUnit), version: 999 } });
    expect('projection' in invalid).toBe(false);

    // Ausente/null → ausente (retrocompatível).
    expect('projection' in sanitizeChatPayload({ engine: 'deterministic' })).toBe(false);
    expect('projection' in sanitizeChatPayload({ engine: 'deterministic', projection: null })).toBe(false);

    // Idempotente sobre o payload legítimo.
    expect(sanitizeChatPayload({ engine: 'deterministic', projection: pUnit }).projection).toEqual(pUnit);
  });

  it('falha de infraestrutura do adapter → 502 controlado, âncora failed SEM projection', async () => {
    const c = new ProjChatFake(fullRows());
    seedConv(c);
    authOk(c);
    c.onRun = (table, action) =>
      table === 'transactions' && action === 'select'
        ? { data: null, count: null, error: { message: 'erro simulado do postgrest' } }
        : undefined;

    const res = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'fail1' }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('erro simulado');
    expect(text).not.toContain('postgrest');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(projOf(body)).toBeUndefined();
    expect(body.error).toBeDefined();

    const failedRow = c.state.chat_messages.find(
      (m) => m.role === 'assistant' && m.client_request_id === 'fail1',
    );
    expect(failedRow).toBeDefined();
    expect(failedRow?.status).toBe('failed');
    const payload = failedRow?.payload as Record<string, unknown> | null | undefined;
    expect(payload === undefined || payload === null || !('projection' in payload)).toBe(true);
  });
});