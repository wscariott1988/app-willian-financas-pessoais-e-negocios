// @vitest-environment jsdom
// pessoal13c4aE3.1AProjectionAudit.test.tsx — PESSOAL-13C4A-E3.1A: auditoria
// adversarial das regressões REAIS de projeção (fixture com as três categorias
// de "mercado" simultâneas + handler real + chat persistente + cache).
//
// Regras auditadas:
//   1. AUDITORIA 1 (lente): com `Alimentação > Supermercado`, `Alimentação >
//      mercado` e `Compras > Mercado Livre` presentes, "E só mercado?" resolve
//      para Supermercado (sinônimo de segmento isolado) — nunca a "mercado"
//      literal nem a decoy de e-commerce; "E o fechamento?" preserva a lente.
//   2. AUDITORIA 2 (mês passado + base): "E em agosto de 2026?" → reference
//      {month:'2026-08', kind:'past'} com a MESMA lente; "E comparado à
//      média?" mantém o mês de referência e vira comparação com
//      referenceBasis 'monthly_mean' — sem nenhum campo exclusivo do mês atual.
//   3. AUDITORIA 3 (aviso): TO_DATE_NOTICE só em respostas current/comparação
//      expected_to_date; o payload past renderiza "Média histórica" e nunca o
//      texto de "ritmo até hoje"; nenhum cálculo novo no navegador.
//   4. AUDITORIA 4 (handler real): Conversa A inteira sem Gemini; conversa
//      NOVA não herda lente/contexto; mês futuro esclarece sem consultar
//      tabelas; fresh === cache === listMessages; cache hit não re-consulta
//      tabelas financeiras; observabilidade sanitizada (sem userId/token).
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import {
  sanitizeProjectionPayloadV1,
  type ProjectionPayloadSuccessV1,
} from '../../server/finance-ai/projectionPayloadV1';
import { setSanitizedSuccessSink, setSanitizedEventSink } from '../../server/finance-ai/observability';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { ProjectionCards } from '../components/ProjectionCards';
import { addMonths } from '../lib/period';

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

// Hoje = 2026-09-15 (São Paulo). Agosto/2026 é mês PASSADO: a Auditoria 2 exige
// reference.kind 'past' e referenceBasis 'monthly_mean' para "E em agosto de
// 2026?".
vi.mock('../../server/finance-ai/projectionAdapter', async () => {
  const actual = await import('../../server/finance-ai/projectionAdapter');
  return {
    ...actual,
    saoPauloTodayISO: () => '2026-09-15',
  };
});

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

function exp(
  occurred_on: string,
  amount: number,
  alias: string,
  label: string,
  canonicalPath: string | null,
): ProjRow {
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: alias,
    occurred_on,
    status: 'paid',
    categories: [{ display_name: label, canonical_path: canonicalPath }],
  };
}

const CATEGORY_ROWS = (rows: Array<{ display_name: string; canonical_path: string | null }>) =>
  rows.map((r) => ({ ...r, direction: 'expense' }));

/**
 * Fixture da Auditoria 1: as TRÊS categorias de "mercado" simultâneas, cada uma
 * com histórico próprio. Janela de cobertura 2025-09..2026-08 (12 meses) com
 * hoje = 2026-09-15; agosto/2026 de supermercado fecha em R$ 1.500 (1.000 do
 * mês + 500 extra) e setembro/2026 tem R$ 500 de supermercado realizado.
 */
function chainRows(): ProjRow[] {
  const rows: ProjRow[] = [];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 9 }, i);
    const ymd = `${ym.year}-${PAD2(ym.month)}`;
    rows.push(exp(`${ymd}-10`, 1000, 'c-super', 'Supermercado', 'Alimentação > Supermercado'));
    rows.push(exp(`${ymd}-12`, 300, 'c-mercado', 'mercado', 'Alimentação > mercado'));
    rows.push(exp(`${ymd}-20`, 9000, 'c-mlivre', 'Mercado Livre', 'Compras > Mercado Livre'));
    rows.push(exp(`${ymd}-15`, 500, 'c-rest', 'Restaurantes', 'Alimentação > Restaurantes'));
    rows.push(exp(`${ymd}-08`, 200, 'c-trans', 'Transporte', 'Transporte'));
  }
  rows.push(exp('2026-08-02', 500, 'c-super', 'Supermercado', 'Alimentação > Supermercado'));
  rows.push(exp('2026-09-05', 500, 'c-super', 'Supermercado', 'Alimentação > Supermercado'));
  rows.push(exp('2026-09-02', 100, 'c-mercado', 'mercado', 'Alimentação > mercado'));
  rows.push(exp('2026-09-06', 9000, 'c-mlivre', 'Mercado Livre', 'Compras > Mercado Livre'));
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

interface PBFilter {
  op: 'is' | 'eq' | 'gte' | 'lte';
  key: string;
  value: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class ProjChatFake {
  state: Record<string, Row[]> = {
    transactions: [],
    account_profile_periods: [],
    categories: [],
    chat_conversations: [],
    chat_messages: [],
  };
  calls: Array<{ table: string; action: string }> = [];

  constructor(transactions: ProjRow[]) {
    this.state.transactions = transactions.map((r) => ({ ...r }));
    // Período persistido cobrindo TODOS os dias da janela de cobertura
    // (2025-09-01 em diante): sem ele, o fallback começa na 1ª transação
    // (2025-09-08) e o mês 2025-09 ficaria incompleto → quality preliminary.
    // isMonthFullyCovered exige período para CADA dia do mês coberto.
    this.state.account_profile_periods = [
      { account_id: 'acc-a', starts_on: '2025-09-01', ends_on: null },
    ];
  }

  seedCategories(rows: Array<{ display_name: string; canonical_path: string | null }>): void {
    this.state.categories = CATEGORY_ROWS(rows);
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

const CONV_A = { id: 'conv-a', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };
const CONV_B = { id: 'conv-b', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

function seedConversations(c: ProjChatFake): void {
  c.state.chat_conversations = [{ ...CONV_A }, { ...CONV_B }];
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

const txTables = ['transactions', 'account_profile_periods', 'categories'];

function txCallCount(c: ProjChatFake): number {
  return c.calls.filter((cc) => txTables.includes(cc.table)).length;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projOf(body: Record<string, unknown>): any {
  return body.projection;
}

const BASE_QUESTION = 'Qual a previsão de gastos para os próximos 12 meses?';
const AMBIGUOUS_SNIPPET = 'Posso te ajudar com a projeção em quatro cenários';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SinkEvent = Record<string, any>;

let originalActEnv: unknown;
beforeAll(() => {
  originalActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (originalActEnv === undefined) {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  } else {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  }
});

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
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
  cleanup();
});

const THREEFOLD_CATEGORIES = [
  { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' },
  { display_name: 'mercado', canonical_path: 'Alimentação > mercado' },
  { display_name: 'Mercado Livre', canonical_path: 'Compras > Mercado Livre' },
  { display_name: 'Restaurantes', canonical_path: 'Alimentação > Restaurantes' },
  { display_name: 'Transporte', canonical_path: 'Transporte' },
];

const CURRENT_ONLY_FIELDS = [
  'expectedToDateCents',
  'futureRegisteredCents',
  'committedCents',
  'closingProjectionCents',
] as const;

function assertNoCurrentOnlyFields(payload: unknown): void {
  const comparison = (payload as { comparison?: Record<string, unknown> }).comparison;
  expect(comparison).toBeDefined();
  for (const field of CURRENT_ONLY_FIELDS) {
    expect(comparison as Record<string, unknown>).not.toHaveProperty(field);
  }
}

describe('PESSOAL-13C4A-E3.1A — Conversa A (handler real): auditorias 1, 2, 3 e 4', () => {
  it('mercado→Supermercado com as 3 categorias; fechamento preserva lente; agosto passado vira comparação monthly_mean; tudo sem Gemini', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const c = new ProjChatFake(chainRows());
    c.seedCategories(THREEFOLD_CATEGORIES);
    seedConversations(c);
    authOk(c);
    const events: SinkEvent[] = [];
    setSanitizedSuccessSink((e) => events.push(e as unknown as SinkEvent));

    // m1 — âncora base. Hoje 2026-09-15 → mês de referência atual = 2026-09.
    const res1 = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-a', clientRequestId: 'a-m1' }),
    );
    expect(res1.status).toBe(200);
    const body1 = await (res1.json() as Promise<Record<string, unknown>>);
    const p1 = projOf(body1);
    expect(p1).toBeDefined();
    expect(p1.intent).toBe('projection_base');
    expect(p1.status).toBe('success');
    expect(p1.quality).toBe('full');
    expect(p1.reference).toEqual({ month: '2026-09', kind: 'current' });
    expect(sanitizeProjectionPayloadV1(p1)).toEqual(p1);

    // m2 — categorias: visão geral determinística, sem lente ainda.
    const res2 = await handler(
      postRequest({ question: 'E por categorias?', conversationId: 'conv-a', clientRequestId: 'a-m2' }),
    );
    const body2 = await (res2.json() as Promise<Record<string, unknown>>);
    const p2 = projOf(body2);
    expect(p2).toBeDefined();
    expect(p2.intent).toBe('projection_categories');
    expect(body2.answer as string).toContain('Categorias de maior peso');
    expect(p2.lens).toBeUndefined();

    // m3 — lente elíptica com as TRÊS categorias simultâneas: o sinônimo de
    // segmento isolado vence sobre a "mercado" literal e NUNCA casa a decoy
    // "Mercado Livre" (nem por substring). O total da lente é SÓ supermercado.
    const res3 = await handler(
      postRequest({ question: 'E só mercado?', conversationId: 'conv-a', clientRequestId: 'a-m3' }),
    );
    expect(res3.status).toBe(200);
    const body3 = await (res3.json() as Promise<Record<string, unknown>>);
    const p3 = projOf(body3);
    expect(p3).toBeDefined();
    expect(p3.lens).toEqual({ label: 'Supermercado' });
    expect((body3.answer as string).toLowerCase()).not.toContain('mercado livre');
    const lensCategory = (p3.categories as Array<{ label: string; realizedCents: number }>).find(
      (cat) => cat.label.includes('Supermercado'),
    );
    expect(lensCategory).toBeDefined();
    expect((lensCategory as { realizedCents: number }).realizedCents).toBeGreaterThanOrEqual(50000);
    expect((p3.categories as Array<{ label: string }>).some((cat) => cat.label.includes('Mercado Livre'))).toBe(false);
    const ctx3 = c.state.chat_conversations[0].context as { projection?: { lensPath?: string; lensLabel?: string } } | null;
    expect(ctx3?.projection?.lensPath).toBe('Alimentação > Supermercado');
    expect(ctx3?.projection?.lensLabel).toBe('Supermercado');

    // m4 — fechamento: mês atual com a MESMA lente; comparação expected_to_date
    // (mês atual tem os campos exclusivos, e o aviso do "ritmo" cabe aqui).
    const res4 = await handler(
      postRequest({ question: 'E o fechamento?', conversationId: 'conv-a', clientRequestId: 'a-m4' }),
    );
    expect(res4.status).toBe(200);
    const body4 = await (res4.json() as Promise<Record<string, unknown>>);
    const p4 = projOf(body4);
    expect(p4).toBeDefined();
    expect(p4.intent).toBe('projection_current_month');
    expect(p4.reference).toEqual({ month: '2026-09', kind: 'current' });
    expect(p4.lens).toEqual({ label: 'Supermercado' });
    expect((p4.comparison as { referenceBasis: string }).referenceBasis).toBe('expected_to_date');
    expect((p4.comparison as { closingProjectionCents: number | null }).closingProjectionCents).not.toBeNull();
    expect(p4).not.toHaveProperty('expectedToDateCents');
    expect(sanitizeProjectionPayloadV1(p4)).toEqual(p4);

    // m5 — mês passado explícito COM ano, sob contexto current_month: re-ancora
    // comparação mensal em agosto/2026 (kind past) com a MESMA lente. NENHUM
    // campo exclusivo do mês atual; referenceBasis monthly_mean.
    const res5 = await handler(
      postRequest({ question: 'E em agosto de 2026?', conversationId: 'conv-a', clientRequestId: 'a-m5' }),
    );
    expect(res5.status).toBe(200);
    const body5 = await (res5.json() as Promise<Record<string, unknown>>);
    const p5 = projOf(body5);
    expect(p5).toBeDefined();
    expect(p5.intent).toBe('projection_month_comparison');
    expect(p5.reference).toEqual({ month: '2026-08', kind: 'past' });
    expect(p5.lens).toEqual({ label: 'Supermercado' });
    expect((p5.comparison as { referenceBasis: string }).referenceBasis).toBe('monthly_mean');
    assertNoCurrentOnlyFields(p5);
    const ctx5 = c.state.chat_conversations[0].context as { projection?: { referenceMonth?: string } } | null;
    expect(ctx5?.projection?.referenceMonth).toBe('2026-08');

    // m6 — "E comparado à média?": mantém referência de agosto passado +
    // monthly_mean + lente. Texto do servidor fala de média, nunca "ritmo".
    const res6 = await handler(
      postRequest({ question: 'E comparado à média?', conversationId: 'conv-a', clientRequestId: 'a-m6' }),
    );
    expect(res6.status).toBe(200);
    const body6 = await (res6.json() as Promise<Record<string, unknown>>);
    const p6 = projOf(body6);
    expect(p6).toBeDefined();
    expect(p6.intent).toBe('projection_month_comparison');
    expect(p6.reference).toEqual({ month: '2026-08', kind: 'past' });
    expect(p6.lens).toEqual({ label: 'Supermercado' });
    expect((p6.comparison as { referenceBasis: string }).referenceBasis).toBe('monthly_mean');
    assertNoCurrentOnlyFields(p6);
    expect((body6.answer as string).toLowerCase()).not.toContain('ritmo');
    expect((body6.answer as string)).toContain('média mensal');

    // m7 — mês futuro: clarificação determinística SEM consulta a tabelas
    // financeiras e SEM projection.
    const txCallsBefore7 = txCallCount(c);
    const res7 = await handler(
      postRequest({ question: 'E no próximo mês?', conversationId: 'conv-a', clientRequestId: 'a-m7' }),
    );
    expect(res7.status).toBe(200);
    const body7 = await (res7.json() as Promise<Record<string, unknown>>);
    expect(body7.engine).toBe('deterministic');
    expect(projOf(body7)).toBeUndefined();
    expect((body7.answer as string).includes('meses futuros')).toBe(true);
    expect(txCallCount(c)).toBe(txCallsBefore7);

    expect(gem.calls).toBe(0);

    // Observabilidade sanitizada: engine deterministic em toda a conversa,
    // intents de projeção presentes, cache fresh nos turnos novos (a
    // clarificação de mês futuro não carrega projection → sem campo cache).
    const projectionEvents = events.filter((e) => e.source === 'deterministic' && e.cache !== undefined);
    expect(projectionEvents.length).toBeGreaterThanOrEqual(5);
    expect(
      projectionEvents.some((e) => (e.intent as string) === 'projection_month_comparison'),
    ).toBe(true);
    expect(projectionEvents.every((e) => e.cache === 'fresh')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('user-test-0000-0000-0000-000000000000');
    expect(serialized).not.toContain('token-valido');
  });
});

describe('PESSOAL-13C4A-E3.1A — Conversa B (nova): sem herança de lente/contexto; lente desconhecida sem contexto; Gemini zero', () => {
  it('"E por categorias?" sem contexto → cenários determinísticos; depois turno tradicional segue determinístico', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const c = new ProjChatFake(chainRows());
    c.seedCategories(THREEFOLD_CATEGORIES);
    seedConversations(c);
    authOk(c);

    // m1 — conversa B começa sem contexto nenhum, sem nenhuma mensagem anterior:
    // follow-up de projeção sem âncora → apresentação de cenários determinística,
    // ZERO consultas a tabelas financeiras.
    const txCallsBefore = txCallCount(c);
    const res1 = await handler(
      postRequest({ question: 'E por categorias?', conversationId: 'conv-b', clientRequestId: 'b-m1' }),
    );
    expect(res1.status).toBe(200);
    const body1 = await (res1.json() as Promise<Record<string, unknown>>);
    expect(body1.engine).toBe('deterministic');
    expect(projOf(body1)).toBeUndefined();
    expect((body1.answer as string).includes(AMBIGUOUS_SNIPPET)).toBe(true);
    expect(txCallCount(c)).toBe(txCallsBefore);

    // m2 — a conversa nova NÃO herda lente/contexto da conversa A; o turno
    // tradicional continua determinístico e sem projection.
    const res2 = await handler(
      postRequest({ question: 'Quanto gastei este mês?', conversationId: 'conv-b', clientRequestId: 'b-m2' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await (res2.json() as Promise<Record<string, unknown>>);
    expect(body2.engine).toBe('deterministic');
    expect(projOf(body2)).toBeUndefined();
    expect((body2.answer as string).includes('totalizaram')).toBe(true);

    const convB = c.state.chat_conversations.find((r) => r.id === 'conv-b');
    expect((convB?.context as { projection?: unknown } | null)?.projection ?? null).toBeNull();

    expect(gem.calls).toBe(0);
  });
});

describe('PESSOAL-13C4A-E3.1A — idempotência: fresh === cache === listMessages; cache hit sem tabelas; cards por basis', () => {
  it('re-consulta idêntica volta do cache com o mesmo payload; payload persistido (listMessages) é igual; sem re-consultar tabelas', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const c = new ProjChatFake(chainRows());
    c.seedCategories(THREEFOLD_CATEGORIES);
    seedConversations(c);
    authOk(c);

    const req = () =>
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-a', clientRequestId: 'idem-x' });

    const resFresh = await handler(req());
    expect(resFresh.status).toBe(200);
    const bodyFresh = await (resFresh.json() as Promise<Record<string, unknown>>);
    const pFresh = projOf(bodyFresh);
    expect(pFresh).toBeDefined();

    // Cache hit (mesmo client_request_id): mesmo payload, sem novas consultas
    // a tabelas financeiras.
    const txBefore = txCallCount(c);
    const resCached = await handler(req());
    expect(resCached.status).toBe(200);
    const bodyCached = await (resCached.json() as Promise<Record<string, unknown>>);
    expect(projOf(bodyCached)).toEqual(pFresh);
    expect(txCallCount(c)).toBe(txBefore);

    // listMessages lê a MESMA linha persistida (re-sanitização idempotente).
    const persisted = c.state.chat_messages.find(
      (r) => r.role === 'assistant' && r.client_request_id === 'idem-x',
    );
    expect(persisted).toBeDefined();
    const payload = persisted?.payload as { projection?: unknown };
    const projected = sanitizeProjectionPayloadV1(payload?.projection);
    expect(projected).toEqual(pFresh);

    expect(gem.calls).toBe(0);
  });

  it('cards: payload past (monthly_mean) renderiza "Média histórica" e nunca o aviso/ritmo do mês atual', () => {
    const past: ProjectionPayloadSuccessV1 = {
      version: 1,
      status: 'success',
      intent: 'projection_month_comparison',
      quality: 'full',
      reference: { month: '2026-08', kind: 'past' },
      coverage: {
        windowMonths: 12,
        coveredMonths: 12,
        minimumCoverageMonths: 6,
        requiredFullCoverageMonths: 12,
        windowStart: '2025-09',
        windowEnd: '2026-08',
      },
      summary: { monthlyMeanCents: 100000, annualScenarioCents: 1200000, totalBaseCents: 1200000 },
      comparison: {
        deviation: 'above',
        deviationCents: 5000,
        referenceBasis: 'monthly_mean',
        referenceCents: 104166,
        realizedCents: 150000,
      },
      categories: [
        {
          label: 'Alimentação > Supermercado',
          monthlyMeanCents: 104166,
          annualScenarioCents: 1249992,
          realizedCents: 150000,
          referenceCents: 104166,
          deviationCents: 45834,
          deviation: 'above',
        },
      ],
      lens: { label: 'Supermercado' },
    };
    render(<ProjectionCards projection={past} />);
    expect(screen.getAllByText('Média histórica').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/ritmo/)).toBeNull();
    expect(screen.queryByText(/A referência até hoje distribui/)).toBeNull();
    expect(screen.queryByText('Diferença no ritmo até hoje')).toBeNull();
  });

  it('cards: payload current (expected_to_date) exibe o aviso TO_DATE_NOTICE e os rótulos de ritmo', () => {
    const current: ProjectionPayloadSuccessV1 = {
      version: 1,
      status: 'success',
      intent: 'projection_categories',
      quality: 'full',
      reference: { month: '2026-09', kind: 'current' },
      coverage: {
        windowMonths: 12,
        coveredMonths: 12,
        minimumCoverageMonths: 6,
        requiredFullCoverageMonths: 12,
        windowStart: '2025-09',
        windowEnd: '2026-08',
      },
      summary: { monthlyMeanCents: 100000, annualScenarioCents: 1200000, totalBaseCents: 1200000 },
      comparison: {
        deviation: 'above',
        deviationCents: 5000,
        referenceBasis: 'expected_to_date',
        referenceCents: 19355,
        realizedCents: 50000,
        expectedToDateCents: 19355,
        futureRegisteredCents: 0,
        committedCents: 50000,
        closingProjectionCents: 155000,
      },
      categories: [
        {
          label: 'Alimentação > Supermercado',
          monthlyMeanCents: 104166,
          annualScenarioCents: 1249992,
          realizedCents: 50000,
          referenceCents: 19355,
          deviationCents: 30645,
          deviation: 'above',
        },
      ],
      lens: { label: 'Supermercado' },
    };
    render(<ProjectionCards projection={current} />);
    expect(screen.getByText(/A referência até hoje distribui a média histórica/)).toBeDefined();
    expect(screen.getByText('Diferença no ritmo até hoje')).toBeDefined();
    expect(screen.getByText('Realizado até hoje')).toBeDefined();
  });
});