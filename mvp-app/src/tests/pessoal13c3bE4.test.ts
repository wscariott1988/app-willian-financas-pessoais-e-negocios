// pessoal13c3bE4.test.ts — PESSOAL-13C3B-E4: cards analíticos persistidos e
// observabilidade sanitizada.
//
// Prova que:
//   1. o endpoint transporta os cards temáticos/notice (tipos do frontend
//      também os transportam via listMessages = F5);
//   2. completeChatTurn persiste SOMENTE o payload sanitizado
//      (payloadSanitize.ts) — máx 3 cards, rows/strings limitadas por
//      constante, só os 4 kinds conhecidos, sem linhas de transação, sem
//      raw_description, sem UUIDs, sem HTML;
//   3. o cache (clique duplo) reconstrói cards/notice sem re-consultar dados,
//      sem chamar Gemini e sem criar linhas; pending → 409; failed → 502
//      sanitizado; retry real exige novo clientRequestId;
//   4. falhas de persistência NUNCA expõem PostgRESTError/stack, nunca geram
//      fallback Gemini, marcam a âncora failed e não deixam cards parciais;
//   5. a observabilidade mantém conjuntos FECHADOS de campos — as sentinelas
//      SEGREDO_E4_NAO_LOGAR / 987654,32 / TOKEN_E4_NAO_LOGAR nunca aparecem
//      em nenhuma saída (sucesso OU falha), nem pergunta nem valores.
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

// Client do chatApi (listMessages) delegável por teste.
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

import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import { validateAskRequest } from '../../server/finance-ai/orchestrator';
import {
  OBSERVABILITY_FAILURE_FIELDS,
  OBSERVABILITY_SUCCESS_FIELDS,
  setSanitizedFailureSink,
  setSanitizedSuccessSink,
} from '../../server/finance-ai/observability';
import type {
  SanitizedFailureEvent,
  SanitizedSuccessEvent,
} from '../../server/finance-ai/observability';
import {
  PAYLOAD_CARD_ROWS_MAX,
  PAYLOAD_CARD_ROW_LABEL_MAX,
  PAYLOAD_CARD_ROW_VALUE_MAX,
  PAYLOAD_CARD_SUBTITLE_MAX,
  PAYLOAD_CARD_TITLE_MAX,
  PAYLOAD_CARDS_MAX,
  PAYLOAD_NOTICE_MAX,
  sanitizeChatPayload,
} from '../../server/chat/payloadSanitize';
import { contextFromTurn } from '../../server/chat/chatContext';
import type { ChatContextState } from '../../server/chat/chatTypes';
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { listMessages } from '../lib/chatApi';

const JSON_HEADERS = { 'content-type': 'application/json' };

// ── Sentinela obrigatória PESSOAL-13C3B-E4 ─────────────────────
const SENTINEL_AMOUNT = 987654.32;
const SENTINEL_DESCRIPTION = 'SEGREDO_E4_NAO_LOGAR';
const SENTINEL_TOKEN = 'TOKEN_E4_NAO_LOGAR';

type TrendRow = {
  transaction_kind?: 'expense' | 'income' | 'transfer' | null;
  amount?: number | string | null;
  occurred_on?: string | null;
  deleted_at?: string | null;
  category_id?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
  raw_description?: string;
};

const SUP = { id: 'c-sup', display: 'Supermercado', path: 'Alimentação > Supermercado' };
const PAD = { id: 'c-pad', display: 'Padaria', path: 'Alimentação > Padaria' };
const NOVO = { id: 'c-nov', display: 'English School', path: 'Educação > English School' };
const CMB = { id: 'c-cmb', display: 'Combustível', path: 'Transporte > Combustível' };

type CatFixture = typeof SUP;

function mkRow(cat: CatFixture, amount: number, date: string): TrendRow {
  return {
    transaction_kind: 'expense',
    amount,
    occurred_on: date,
    category_id: cat.id,
    categories: { display_name: cat.display, canonical_path: cat.path },
  };
}

// Janela six_complete é ancorada no relógio LOCAL real do endpoint (sem
// nowISO): base = 6/5/4 meses atrás; recente = 3/2/1 meses atrás. Os fixtures
// usam datas DINÂMICAS para o teste nunca depender de uma data fixa.
function slotDate(monthsBack: number, day = 15): string {
  const d = new Date();
  const dt = new Date(d.getFullYear(), d.getMonth() - monthsBack, day);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

const BASE_OFFSETS = [6, 5, 4];
const RECENT_OFFSETS = [3, 2, 1];

/** Sup 100→400, Padaria 50→150 (2 categorias com crescimento significativo). */
function growingRowsDynamic(): TrendRow[] {
  const rows: TrendRow[] = [];
  for (const off of BASE_OFFSETS) {
    rows.push(mkRow(SUP, 100, slotDate(off)));
    rows.push(mkRow(PAD, 50, slotDate(off)));
  }
  for (const off of RECENT_OFFSETS) {
    rows.push(mkRow(SUP, 400, slotDate(off)));
    rows.push(mkRow(PAD, 150, slotDate(off)));
  }
  return rows;
}

/** Combustível com pico atípico no primeiro mês recente (share > 0,65). */
function spikeRowsDynamic(): TrendRow[] {
  const rows: TrendRow[] = [];
  for (const off of BASE_OFFSETS) rows.push(mkRow(CMB, 100, slotDate(off)));
  rows.push(mkRow(CMB, 5000, slotDate(3)));
  rows.push(mkRow(CMB, 100, slotDate(2)));
  rows.push(mkRow(CMB, 100, slotDate(1)));
  return rows;
}

/** English School aparece só no trimestre recente (média base nula → 'new'). */
function newRowsDynamic(): TrendRow[] {
  return RECENT_OFFSETS.map((off) => mkRow(NOVO, 300, slotDate(off)));
}

/** Supermercado constante → nenhum crescimento significativo. */
function flatRowsDynamic(): TrendRow[] {
  return [...BASE_OFFSETS, ...RECENT_OFFSETS].map((off) => mkRow(SUP, 100, slotDate(off)));
}

/** growingRows + Combustível plano com a quantia/descrição sentinela. */
function sentinelRowsDynamic(): TrendRow[] {
  const rows = growingRowsDynamic();
  for (const off of [...BASE_OFFSETS, ...RECENT_OFFSETS]) {
    const r = mkRow(CMB, SENTINEL_AMOUNT, slotDate(off));
    if (off === 3) r.raw_description = SENTINEL_DESCRIPTION;
    rows.push(r);
  }
  return rows;
}

// Referência estática do E3 (follow-ups usam nowISO fixo).
const JAN = '2026-01-15';
const FEV = '2026-02-15';
const MAR = '2026-03-15';
const ABR = '2026-04-15';
const MAI = '2026-05-15';
const JUN = '2026-06-15';
const NOW = '2026-07-25';

function growingRowsStatic(): TrendRow[] {
  const mk2 = (d: string, sup: number, pad: number): TrendRow[] => [
    mkRow(SUP, sup, d),
    mkRow(PAD, pad, d),
  ];
  return [
    ...mk2(JAN, 100, 50),
    ...mk2(FEV, 100, 50),
    ...mk2(MAR, 100, 50),
    ...mk2(ABR, 400, 150),
    ...mk2(MAI, 400, 150),
    ...mk2(JUN, 400, 150),
  ];
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

const txCount = (calls: Array<{ table: string }>): number =>
  calls.filter((c) => c.table === 'transactions').length;

/** Conta consultas à tabela transactions em mocks que registram só o nome da tabela (string[]). */
const txCountStr = (calls: string[]): number =>
  calls.filter((t) => t === 'transactions').length;

// ── Fake Supabase com estado (subset do chat) + injeção de falha ──

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

/** MESMO contrato do StateFake do E3 + onRun (falha injetável). */
class StateFake {
  state: Record<string, Row[]> = {
    transactions: [],
    categories: [],
    chat_conversations: [],
    chat_messages: [],
  };
  calls: Array<{ table: string; action: string }> = [];
  onRun?: FailHook;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        const b = (f.value ?? null) as string | number | null;
        if (a === null || b === null) return false;
        const cmp =
          typeof a === 'string' && typeof b === 'string'
            ? a.localeCompare(b)
            : Number(a) - Number(b);
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
        b.single = true;
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

const CONV = { id: 'conv-1', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

/** Garante que a conversa âncora existe para turnos persistentes. */
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

function postRequest(body: unknown, token = 'token-valido'): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const GROWTH_QUESTION = 'Quais categorias mais cresceram nos últimos 6 meses?';
const SAVINGS_QUESTION = 'Onde posso economizar mais?';

// ── Sinks de observabilidade (captura por teste) ────────────────
let successEvents: SanitizedSuccessEvent[] = [];
let failureEvents: SanitizedFailureEvent[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
  successEvents = [];
  failureEvents = [];
  setSanitizedSuccessSink((e) => {
    successEvents.push(e);
  });
  setSanitizedFailureSink((e) => {
    failureEvents.push(e);
  });
});

afterEach(() => {
  setSanitizedSuccessSink(null);
  setSanitizedFailureSink(null);
});

describe('PESSOAL-13C3B-E4 — sanitização do payload (lógica pura)', () => {
  it('1) cartões acima de PAYLOAD_CARDS_MAX são reduzidos a 3 (presença preservada)', () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({
      kind: 'growth' as const,
      title: `Cat ${i}`,
      subtitle: 'sub',
      rows: [{ label: 'L', value: 'R$ 1,00' }],
    }));
    const out = sanitizeChatPayload({ engine: 'deterministic', cards });
    expect(out.cards).toHaveLength(PAYLOAD_CARDS_MAX);
    expect(out.cards).toBeDefined();
    expect(PAYLOAD_CARDS_MAX).toBe(3);
  });

  it('2) kind desconhecido é removido; somente os 4 kinds conhecidos passam', () => {
    const out = sanitizeChatPayload({
      cards: [
        { kind: 'bogus', title: 'X', subtitle: '', rows: [{ label: 'a', value: 'b' }] },
        { kind: 'growth', title: 'A', subtitle: '', rows: [{ label: 'a', value: 'b' }] },
        { kind: 'new', title: 'B', subtitle: '', rows: [{ label: 'a', value: 'b' }] },
        { kind: 'spike', title: 'C', subtitle: '', rows: [{ label: 'a', value: 'b' }] },
      ],
    });
    const kinds = (out.cards ?? []).map((c) => c.kind).sort();
    expect(kinds).toEqual(['growth', 'new', 'spike']);

    const outSavings = sanitizeChatPayload({
      cards: [
        { kind: 'savings', title: 'D', subtitle: '', rows: [{ label: 'a', value: 'b' }] },
        { kind: 'bogus2', title: 'Y', subtitle: '', rows: [{ label: 'a', value: 'b' }] },
      ],
    });
    expect((outSavings.cards ?? []).map((c) => c.kind)).toEqual(['savings']);
  });

  it('3) rows de cartão são limitadas a PAYLOAD_CARD_ROWS_MAX e inválidas removidas', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    rows.push({ label: 'bad-num', value: 123 as unknown as string });
    rows.push({ label: '', value: 'sem label' });
    rows.push({ value: 'sem label nem nothing' } as { label: string; value: string });
    const out = sanitizeChatPayload({
      cards: [{ kind: 'growth', title: 'Cat', subtitle: 's', rows }],
    });
    expect(out.cards?.[0].rows).toHaveLength(PAYLOAD_CARD_ROWS_MAX);
    for (const row of out.cards?.[0].rows ?? []) {
      expect(typeof row.label).toBe('string');
      expect(typeof row.value).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.value.length).toBeGreaterThan(0);
    }
    expect(PAYLOAD_CARD_ROWS_MAX).toBe(7);
  });

  it('4) strings excedentes são truncadas com segurança (nunca lança 500)', () => {
    const out = sanitizeChatPayload({
      cards: [
        {
          kind: 'growth',
          title: 'T'.repeat(1000),
          subtitle: 'S'.repeat(1000),
          rows: [
            { label: 'L'.repeat(1000), value: 'V'.repeat(1000) },
            { label: 'L'.repeat(1000), value: 42 as unknown as string },
          ],
        },
      ],
    });
    const card = out.cards?.[0];
    expect(card).toBeDefined();
    expect(card?.title.length).toBe(PAYLOAD_CARD_TITLE_MAX);
    expect(card?.subtitle.length).toBe(PAYLOAD_CARD_SUBTITLE_MAX);
    expect(card?.rows[0].label.length).toBe(PAYLOAD_CARD_ROW_LABEL_MAX);
    expect(card?.rows[0].value.length).toBe(PAYLOAD_CARD_ROW_VALUE_MAX);
    expect(card?.rows).toHaveLength(1);
  });

  it('5) notice excedente é truncada a PAYLOAD_NOTICE_MAX', () => {
    const out = sanitizeChatPayload({ notice: 'N'.repeat(5000) });
    expect(out.notice).toBeDefined();
    expect(out.notice?.length).toBe(PAYLOAD_NOTICE_MAX);
  });

  it('6) campos desconhecidos nunca atravessam a fronteira de persistência', () => {
    const out = sanitizeChatPayload({
      engine: 'deterministic',
      geminiCallCount: 0,
      toolsUsed: ['trend_growth'],
      notice: 'aviso',
      cards: [],
      profile_id: 'p-000',
      raw_description: 'segredo',
      jwt: 'abc',
      transaction: { amount: 1 },
      requestId: 'uuid-x',
      rows: [1, 2, 3],
    });
    const allowed = new Set([
      'engine',
      'geminiCallCount',
      'toolsUsed',
      'evidence',
      'notice',
      'cards',
    ]);
    for (const key of Object.keys(out)) expect(allowed.has(key)).toBe(true);
    expect(out).not.toHaveProperty('profile_id');
    expect(out).not.toHaveProperty('raw_description');
    expect(out).not.toHaveProperty('jwt');
    expect(out).not.toHaveProperty('transaction');
    expect(out).not.toHaveProperty('rows');
  });

  it('7) defensivo: HTML/tags arbitrárias são removidas de cards e notice', () => {
    const out = sanitizeChatPayload({
      notice: '<b>vale <i>a pena</b></i>',
      cards: [
        { kind: 'growth', title: '<script>alert(1)</script>', subtitle: '<b>x</b>', rows: [] },
      ],
    });
    expect(out.notice).toBe('vale a pena');
    expect(out.cards?.[0].title).toBe('alert(1)');
    expect(JSON.stringify(out)).not.toContain('<');
    expect(JSON.stringify(out)).not.toContain('script');
  });

  it('8) payload máximo sanitizado permanece ABAIXO do CHECK do banco (20.480)', () => {
    const out = sanitizeChatPayload({
      engine: 'deterministic',
      toolsUsed: Array.from({ length: 40 }, (_, i) => `tool-${i}:`.repeat(20)),
      evidence: Array.from({ length: 40 }, (_, i) => ({
        label: `L${i}`.repeat(200),
        value: `V${i}`.repeat(200),
      })),
      notice: 'N'.repeat(9000),
      cards: Array.from({ length: 10 }, (_, i) => ({
        kind: 'growth' as const,
        title: `T${i}`.repeat(200),
        subtitle: `S${i}`.repeat(200),
        rows: Array.from({ length: 20 }, (_, j) => ({
          label: `L${i}-${j}`.repeat(200),
          value: `V${i}-${j}`.repeat(200),
        })),
      })),
    });
    const len = JSON.stringify(out).length;
    expect(len).toBeLessThanOrEqual(20480);
  });
});

describe('PESSOAL-13C3B-E4 — endpoint stateless: cards/notice no contrato HTTP', () => {
  it('9) stateless de growth responde com cards temáticos (kind growth)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: GROWTH_QUESTION }));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(Array.isArray(body.cards)).toBe(true);
    expect(body.cards.length).toBeGreaterThan(0);
    for (const card of body.cards) expect(card.kind).toBe('growth');
    expect(body.notice).toBeUndefined();
  });

  it('10) stateless de savings responde com cards savings e notice sanitizado', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: SAVINGS_QUESTION }));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.cards[0].kind).toBe('savings');
    expect(typeof body.notice).toBe('string');
    expect(body.notice).toContain('Simulação');
  });

  it('11) stateless nunca consulta nem grava tabelas de chat', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: GROWTH_QUESTION }));
    expect(res.status).toBe(200);
    const tables = c.calls.map((x) => x.table);
    expect(tables).not.toContain('chat_messages');
    expect(tables).not.toContain('chat_conversations');
    expect(c.state.chat_messages).toHaveLength(0);
    expect(c.state.chat_conversations).toHaveLength(0);
  });

  it('12) cartão "novo gasto" (kind new) é classificado corretamente', async () => {
    const c = new StateFake();
    c.state.transactions = newRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: GROWTH_QUESTION }));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.cards[0].kind).toBe('new');
    expect(body.cards[0].title).toBe('Educação > English School');
  });

  it('13) cartão de "pico" (kind spike) é classificado corretamente', async () => {
    const c = new StateFake();
    c.state.transactions = spikeRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: GROWTH_QUESTION }));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.cards[0].kind).toBe('spike');
    expect(body.cards[0].title).toBe('Transporte > Combustível');
  });

  it('14) growth com múltiplas categorias traz cards por categoria e evidência', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: GROWTH_QUESTION }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.cards.length).toBe(2);
    expect(body.cards.map((x: { title: string }) => x.title)).toContain('Alimentação > Supermercado');
    expect(body.cards.map((x: { title: string }) => x.title)).toContain('Alimentação > Padaria');
    const increase = body.evidence?.find((e: { label: string }) => e.label === 'Aumento identificado');
    expect(increase?.value).toBe('2');
  });

  it('15) savings via endpoint traz notice presente (sem depender do engine)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: SAVINGS_QUESTION }));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.cards.length).toBeGreaterThan(0);
    expect(body.cards.every((x: { kind: string }) => x.kind === 'savings')).toBe(true);
    expect(body.notice).toBeDefined();
  });

  it('16) dados insuficientes → cards VAZIOS e notice presente (growth e savings)', async () => {
    const c1 = new StateFake();
    c1.state.transactions = flatRowsDynamic();
    authOk(c1);
    const res1 = await handler(postRequest({ question: GROWTH_QUESTION }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const growth = (await res1.json()) as any;
    expect(growth.cards).toEqual([]);
    expect(growth.notice).toBe('Nenhuma categoria apresentou crescimento significativo.');

    const c2 = new StateFake();
    c2.state.transactions = [];
    authOk(c2);
    const res2 = await handler(postRequest({ question: SAVINGS_QUESTION }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savings = (await res2.json()) as any;
    expect(savings.cards).toEqual([]);
    expect(savings.notice).toBe('Nenhuma simulação de economia foi calculada.');
  });

  it('17) pergunta antiga (total_expenses) mantém contrato SEM cards/notice', async () => {
    const c = new StateFake();
    c.state.transactions = [
      { transaction_kind: 'expense', amount: 100, occurred_on: '2026-04-05', deleted_at: null, categories: SUP },
    ];
    authOk(c);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em abril?',
        period: { start: '2026-04-01', end: '2026-04-30' },
      }),
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.answer).toContain('100,00');
    expect(body).not.toHaveProperty('cards');
    expect(body).not.toHaveProperty('notice');
  });
});

describe('PESSOAL-13C3B-E4 — persistência: payload sanitizado via completeChatTurn', () => {
  const assistantRow = (c: StateFake, crid: string): Row | undefined =>
    c.state.chat_messages.find(
      (m) => m.role === 'assistant' && m.client_request_id === crid && m.status === 'completed',
    );

  it('18) growth persistente grava cards sanitizados no payload', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    c.state.chat_conversations = [{ ...CONV }];
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    const row = assistantRow(c, 'r1');
    expect(row).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (row?.payload ?? {}) as any;
    expect(Array.isArray(payload.cards)).toBe(true);
    expect(payload.cards.length).toBeGreaterThan(0);
    expect(payload.cards.length).toBeLessThanOrEqual(PAYLOAD_CARDS_MAX);
    const known = new Set(['growth', 'new', 'spike', 'savings']);
    for (const card of payload.cards) {
      expect(known.has(card.kind)).toBe(true);
      expect(typeof card.title).toBe('string');
      expect(Array.isArray(card.rows)).toBe(true);
      for (const r of card.rows) {
        expect(typeof r.label).toBe('string');
        expect(typeof r.value).toBe('string');
      }
    }
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThanOrEqual(20480);
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(serialized).not.toContain('raw_description');
  });

  it('19) savings persistente grava notice + cards savings e listMessages os transporta (F5)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    c.state.chat_conversations = [{ ...CONV }];
    authOk(c);
    const res = await handler(
      postRequest({ question: SAVINGS_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    const row = assistantRow(c, 'r1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (row?.payload ?? {}) as any;
    expect(payload.notice).toBeDefined();
    expect(payload.notice).toContain('Simulação');
    expect(payload.cards[0].kind).toBe('savings');

    // F5/remount: listMessages lê o MESMO payload persistido e reconstrói o UiMessage.
    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const assistant = page.messages.find((m) => m.role === 'assistant' && m.status === 'completed');
    expect(assistant).toBeDefined();
    expect(assistant?.cards).toEqual(payload.cards);
    expect(assistant?.notice).toBe(payload.notice);
    expect(assistant?.engine).toBe('deterministic');
    expect(assistant?.text.length).toBeGreaterThan(0);
  });

  it('20) profile_id/cards/payload do BODY continuam ignorados (identidade vem do JWT)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    c.state.chat_conversations = [{ ...CONV }];
    authOk(c);
    const res = await handler(
      postRequest({
        question: GROWTH_QUESTION,
        conversationId: 'conv-1',
        clientRequestId: 'r1',
        profile_id: 'p-000',
        cards: [{ kind: 'growth', title: 'HACK_E4_BROWSER', subtitle: '', rows: [] }],
        payload: { notice: 'HACK_E4_NOTICE' },
      }),
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    const row = assistantRow(c, 'r1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = (row?.payload ?? {}) as any;
    expect(persisted.cards.some((x: { title: string }) => x.title === 'HACK_E4_BROWSER')).toBe(false);
    expect(persisted.notice).not.toBe('HACK_E4_NOTICE');
    expect(persisted.cards).toEqual(body.cards);
    const tables = c.calls.map((x) => x.table);
    expect(tables).not.toContain('profiles');
  });
});

describe('PESSOAL-13C3B-E4 — cache/idempotência (clique duplo e reenvio)', () => {
  it('21) payload legado SEM cards/notice volta SEM esses campos no cache', async () => {
    const c = new StateFake();
    seedConv(c);
    c.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'completed', client_request_id: 'r1', content: 'Total: R$ 10,00.', payload: { engine: 'deterministic', toolsUsed: ['financial_summary'] }, period_analyzed: { start: '2026-04-01', end: '2026-04-30' } },
    ];
    authOk(c);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em abril?', conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.answer).toBe('Total: R$ 10,00.');
    expect(body).not.toHaveProperty('cards');
    expect(body).not.toHaveProperty('notice');
  });

  it('22) clique duplo completed preserva cards/notice IDÊNTICOS', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    authOk(c);
    const req = { question: SAVINGS_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' };
    const res1 = await handler(postRequest(req));
    expect(res1.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b1 = (await res1.json()) as any;

    authOk(c);
    const res2 = await handler(postRequest(req));
    expect(res2.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b2 = (await res2.json()) as any;
    expect(b2.cards).toEqual(b1.cards);
    expect(b2.notice).toBe(b1.notice);
    expect(b2.answer).toBe(b1.answer);
    expect(b2.engine).toBe('deterministic');
  });

  it('23) cache completed: zero NOVAS consultas financeiras e zero novas linhas', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    authOk(c);
    const req = { question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' };
    const res1 = await handler(postRequest(req));
    expect(res1.status).toBe(200);
    const txAfterFirst = txCount(c.calls);
    const rowsAfterFirst = c.state.chat_messages.length;

    authOk(c);
    const res2 = await handler(postRequest(req));
    expect(res2.status).toBe(200);
    expect(txCount(c.calls)).toBe(txAfterFirst);
    expect(c.state.chat_messages.length).toBe(rowsAfterFirst);
    expect(c.state.chat_messages.filter((m) => m.role === 'assistant' && m.status === 'completed')).toHaveLength(1);
  });

  it('24) cache completed: zero chamadas ao Gemini (neverGemini lança se chamado)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    authOk(c);
    const req = { question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' };
    const res1 = await handler(postRequest(req));
    expect(res1.status).toBe(200);
    authOk(c);
    const res2 = await handler(postRequest(req));
    expect(res2.status).toBe(200);
    expect(successEvents.filter((e) => e.geminiCallCount === 0).length).toBe(2);
  });

  it('25) âncora pending → 409 in_flight', async () => {
    const c = new StateFake();
    seedConv(c);
    c.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1' },
    ];
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(409);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error).toBe('in_flight');
  });

  it('26) âncora failed → 502 cached_failure sanitizado SEM cards parciais', async () => {
    const c = new StateFake();
    seedConv(c);
    c.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'failed', client_request_id: 'r1', content: '', payload: { error: true }, error: 'A análise anterior falhou.' },
    ];
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(502);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error).toBe('upstream');
    expect(body.message).toContain('A análise anterior falhou.');
    expect(body).not.toHaveProperty('cards');
    expect(body).not.toHaveProperty('notice');
  });

  it('27) NOVO clientRequestId após falha permite retry real (sem conflito de índice)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    c.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'failed', client_request_id: 'r-die', content: '', payload: { error: true }, error: 'Falhou antes.' },
    ];
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(res.status).toBe(200);
    const done = c.state.chat_messages.find(
      (m) => m.role === 'assistant' && m.client_request_id === 'r2' && m.status === 'completed',
    );
    expect(done).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((done?.payload ?? {}) as any).cards?.length).toBeGreaterThan(0);
    const failed = c.state.chat_messages.find((m) => m.client_request_id === 'r-die');
    expect(failed?.status).toBe('failed');
    expect(failed?.payload).toEqual({ error: true });
  });

  it('28) evento de sucesso do cache reconstitui intent (growth_categories)', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    authOk(c);
    const req = { question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' };
    await handler(postRequest(req));
    authOk(c);
    const res2 = await handler(postRequest(req));
    expect(res2.status).toBe(200);
    expect(successEvents.length).toBe(2);
    expect(successEvents[1].intent).toBe('growth_categories');
    expect(successEvents[1].engine).toBe('deterministic');
  });

  it('29) idempotência tripla: perguntas novas não violam o índice e reenvio é cache', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    authOk(c);
    const r1 = { question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' };
    const res1 = await handler(postRequest(r1));
    expect(res1.status).toBe(200);
    authOk(c);
    const res2 = await handler(
      postRequest({ question: SAVINGS_QUESTION, conversationId: 'conv-1', clientRequestId: 'r2' }),
    );
    expect(res2.status).toBe(200);
    expect(c.state.chat_messages).toHaveLength(4);

    authOk(c);
    const res3 = await handler(postRequest(r1));
    expect(res3.status).toBe(200);
    expect(c.state.chat_messages).toHaveLength(4);
    const statuses = c.state.chat_messages.map((m) => m.status);
    expect(statuses.every((s) => s === 'completed')).toBe(true);
  });
});

describe('PESSOAL-13C3B-E4 — erros: persistência amigável e mensagem sem partial', () => {
  function failingConvUpdateError(): { name: string; message: string; hint: string } {
    return { name: 'PostgrestError', message: SENTINEL_DESCRIPTION, hint: SENTINEL_DESCRIPTION };
  }

  it('30) falha de persistência → 502 amigável, sem PostgRESTError, assistant failed, SEM fallback Gemini', async () => {
    let geminiCalled = false;
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiCalled = true;
        throw new Error('Gemini NÃO deve ser chamado como fallback de persistência');
      },
    });
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    c.onRun = (table, action) => {
      if (table === 'chat_conversations' && action === 'update') {
        return { data: null, count: null, error: failingConvUpdateError() };
      }
      return undefined;
    };
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(502);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.error).toBe('upstream');
    expect(body.message).toBe('Serviço de inteligência indisponível no momento.');
    expect(JSON.stringify(body)).not.toContain('Postgrest');
    expect(JSON.stringify(body)).not.toContain(SENTINEL_DESCRIPTION);
    expect(geminiCalled).toBe(false);
    expect(successEvents).toHaveLength(0);
    const anchor = c.state.chat_messages.find((m) => m.role === 'assistant' && m.client_request_id === 'r1');
    expect(anchor?.status).toBe('failed');
    expect(anchor?.payload).toEqual({ error: true });
  });

  it('31) mensagem failed não contém resultado parcial (sem cards/notice) — e listMessages espelha', async () => {
    const c = new StateFake();
    c.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', content: 'x', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'failed', content: '', payload: { error: true }, error: 'Falhou antes.', created_at: '2026-01-01T00:00:01.000Z' },
    ];
    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const assistant = page.messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('failed');
    expect(assistant?.text).toBe('');
    expect(assistant?.cards).toBeUndefined();
    expect(assistant?.notice).toBeUndefined();
    expect(assistant?.error).toBe('Falhou antes.');
  });
});

describe('PESSOAL-13C3B-E4 — observabilidade: conjuntos fechados e sentinelas nunca vazam', () => {
  it('32) logs de SUCESSO não contêm valores, cards, pergunta, descrição nem token', async () => {
    const c = new StateFake();
    c.state.transactions = sentinelRowsDynamic();
    authOk(c);
    const res = await handler(postRequest({ question: GROWTH_QUESTION }, SENTINEL_TOKEN));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(successEvents.length).toBe(1);
    const serialized = JSON.stringify(successEvents);
    const localeAmount = SENTINEL_AMOUNT.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    expect(serialized).not.toContain(localeAmount);
    expect(serialized).not.toContain(SENTINEL_DESCRIPTION);
    expect(serialized).not.toContain(SENTINEL_TOKEN);
    expect(serialized).not.toContain(GROWTH_QUESTION);
    expect(serialized).not.toContain('"cards"');
    expect(serialized).not.toContain('R$');
    for (const key of Object.keys(successEvents[0])) {
      expect((OBSERVABILITY_SUCCESS_FIELDS as readonly string[]).includes(key)).toBe(true);
    }
    // A resposta também não expõe a sentinela (categoria plana não entra nos cards).
    expect(JSON.stringify(body)).not.toContain(localeAmount);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_DESCRIPTION);
  });

  it('33) logs de FALHA não contêm payload/stack sensível; erro amigável e evento com campos fechados', async () => {
    const c = new StateFake();
    c.state.transactions = growingRowsDynamic();
    seedConv(c);
    c.onRun = (table, action) => {
      if (table === 'chat_conversations' && action === 'update') {
        return { data: null, count: null, error: { name: 'PostgrestError', message: SENTINEL_DESCRIPTION, hint: SENTINEL_DESCRIPTION } };
      }
      return undefined;
    };
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(502);
    expect(failureEvents.length).toBe(1);
    const event = failureEvents[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SENTINEL_DESCRIPTION);
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('at ');
    expect(serialized).not.toContain(SENTINEL_TOKEN);
    expect(event.errorName).toBe('PostgrestError');
    expect(event.httpStatus).toBe(502);
    for (const key of Object.keys(event)) {
      expect((OBSERVABILITY_FAILURE_FIELDS as readonly string[]).includes(key)).toBe(true);
    }
    const bodyText = await res.text();
    expect(bodyText).not.toContain(SENTINEL_DESCRIPTION);
    expect(bodyText).not.toContain('Postgrest');
  });

  it('34) sentinelas de valor/descrição/token ausentes em TODA saída de observabilidade', async () => {
    // Sucesso persistente com a sentinela nos dados.
    const c = new StateFake();
    c.state.transactions = sentinelRowsDynamic();
    seedConv(c);
    authOk(c);
    const res = await handler(
      postRequest({ question: GROWTH_QUESTION, conversationId: 'conv-1', clientRequestId: 'r1' }, SENTINEL_TOKEN),
    );
    expect(res.status).toBe(200);

    // Falha de persistência (a âncora fica failed, resposta amigável).
    const c2 = new StateFake();
    c2.state.transactions = sentinelRowsDynamic();
    seedConv(c2);
    c2.onRun = (table, action) => {
      if (table === 'chat_conversations' && action === 'update') {
        return { data: null, count: null, error: { name: 'PostgrestError', message: SENTINEL_DESCRIPTION, hint: SENTINEL_DESCRIPTION } };
      }
      return undefined;
    };
    authOk(c2);
    const res2 = await handler(
      postRequest({ question: SAVINGS_QUESTION, conversationId: 'conv-1', clientRequestId: 'r2' }, SENTINEL_TOKEN),
    );
    expect(res2.status).toBe(502);

    const all = JSON.stringify([...successEvents, ...failureEvents]);
    const localeAmount = SENTINEL_AMOUNT.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    expect(all).not.toContain(localeAmount);
    expect(all).not.toContain('987654,32');
    expect(all).not.toContain('987654.32');
    expect(all).not.toContain(SENTINEL_DESCRIPTION);
    expect(all).not.toContain(SENTINEL_TOKEN);
    expect(all).not.toContain(GROWTH_QUESTION);
    expect(all).not.toContain(SAVINGS_QUESTION);
  });
});

describe('PESSOAL-13C3B-E4 — follow-ups do E3 continuam determinísticos e re-consultam', () => {
  it('35) "E 5%?" após savings dispara novas consultas, sem Gemini, preservando cards', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake: { from: (t: string) => any } = {
      from: () => {
        throw new Error('deve usar o mkClient do E3');
      },
    };
    void fake;
    const { mkClient } = e3ClientFactory();
    const { fake: client, calls } = mkClient(growingRowsStatic());
    const first = await runDeterministicAsk({
      supabase: client as never,
      question: SAVINGS_QUESTION,
      nowISO: NOW,
    });
    expect(first?.intent).toBe('savings_opportunities');
    const context: ChatContextState = contextFromTurn(null, {
      intent: 'savings_opportunities',
      category: null,
      periodAnalyzed: first?.response.periodAnalyzed ?? first?.response.period ?? null,
      answer: first?.response.answer ?? '',
      analysis: first?.analysis,
    });
    const t0 = txCountStr(calls);
    const fu = await runDeterministicAsk({
      supabase: client as never,
      question: 'E 5%?',
      context,
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.simulationPct).toBe(5);
    expect(fu?.response.cards?.length).toBeGreaterThan(0);
    expect(fu?.response.notice).toBeDefined();
    expect(txCountStr(calls)).toBeGreaterThan(t0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function e3ClientFactory(): { mkClient: (rows: TrendRow[]) => { fake: unknown; calls: string[] } } {
  type FakeRow = TrendRow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkClient = (rows: FakeRow[]): { fake: unknown; calls: string[] } => {
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base = (table: string): Record<string, any> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c3: Record<string, any> = {};
      type F = { op: string; key: string; value: unknown };
      const filters: F[] = [];
      let cols = '*';
      for (const m of ['is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
        c3[m] = (k: string, v?: unknown) => {
          if ((m === 'is' || m === 'gte' || m === 'lte' || m === 'eq') && typeof k === 'string') {
            filters.push({ op: m, key: k, value: v as string | null });
          }
          return c3;
        };
      }
      c3.select = (sel?: string, opts?: { count?: 'exact' }) => {
        cols = sel ?? '*';
        void cols;
        void opts;
        return { ...c3, _count: opts?.count === 'exact' };
      };
      const store: FakeRow[] = table === 'categories' ? [] : rows;
      const matches = (r: FakeRow, f: F): boolean => {
        const v = (r as unknown as Record<string, unknown>)[f.key];
        if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
        if (f.op === 'eq') return v === f.value;
        if (f.op === 'gte') return v !== null && v !== undefined && String(v) >= String(f.value);
        if (f.op === 'lte') return v !== null && v !== undefined && String(v) <= String(f.value);
        return true;
      };
      const doFilter = (): FakeRow[] => store.filter((r) => filters.every((f) => matches(r, f)));
      c3.range = (from: number, to: number) => {
        const page = doFilter().slice(from, to + 1);
        return {
          ...c3,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: page, count: table === 'transactions' ? page.length : undefined, error: null }),
        };
      };
      c3.then = (resolve: (v: unknown) => unknown) => resolve({ data: doFilter(), error: null });
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
  };
  return { mkClient };
}