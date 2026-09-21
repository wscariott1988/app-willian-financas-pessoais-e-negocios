// pessoal13c4aE3.1ProjectionFollowUps.test.ts — PESSOAL-13C4A-E3.1:
// regressão das correções de follow-up e de clareza das projeções.
//
// Corrige e prova que:
//   1. 'mercado' resolve para o segmento canônico "Supermercado" via SINÔNIMO
//      por segmento inteiro ("mercado" → "supermercado"), NUNCA por substring:
//      a decoy de e-commerce "Compras > Mercado Livre" não casa — nem no total
//      de categoria, nem na lente da projeção (substring antigo a casaria e o
//      total divergiria / a lente seria ambígua);
//   2. com DUAS categorias de segmento "mercado" canônicas ("Alimentação >
//      Supermercado" e "Alimentação > mercado") a resolução é AMBÍGUA NOMEADA —
//      esclarece as duas, nunca escolhe em silêncio;
//   3. mês explícito "E em agosto de 2026?" NÃO vira lente desconhecida (ano
//      puro restante nunca é lente): preserva intent + referência + lente;
//   4. "E comparado à média?" com contexto preservado vira comparação mensal
//      com a MESMA lente e referência (antes a clarificação de lente desconhecida
//      limpava o contexto no turno anterior e a pergunta caía no Gemini);
//   5. mês futuro ("E no próximo mês?") → clarificação determinística 'future_month',
//      sem consulta a tabelas financeiras;
//   6. follow-up de projeção SEM contexto nenhum ("E por categorias?") responde
//      com a apresentação de cenários determinística, sem consultar nada;
//   7. a conversa recobra depois de cada esclarecimento ("Quanto gastei este
//      mês?" continua determinística) e ZERO chamadas ao Gemini em todo o fluxo.
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
import { setSanitizedSuccessSink, setSanitizedEventSink } from '../../server/finance-ai/observability';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { addMonths } from '../lib/period';

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
 * Despesas mensais cobrindo 2025-07..2026-07 (janela completa da base) com
 * Supermercado (1k/mês) e a decoy de e-commerce "Mercado Livre" (9k/mês)
 * insistindo no MESMO segmento de palavra — o que prova que o total/lente de
 * 'mercado' NUNCA engole a decoy. Julho/2026 fecha 2k de supermercado para o
 * total do turno tradicional e agosto/2026 traz o mês atual.
 */
function chainRows(): ProjRow[] {
  const rows: ProjRow[] = [];
  for (let i = 0; i < 13; i++) {
    const ym = addMonths({ year: 2025, month: 7 }, i);
    rows.push(exp(`${ym.year}-${PAD2(ym.month)}-10`, 1000, 'c-super', 'Supermercado', 'Alimentação > Supermercado'));
    rows.push(exp(`${ym.year}-${PAD2(ym.month)}-20`, 9000, 'c-mlivre', 'Mercado Livre', 'Compras > Mercado Livre'));
  }
  rows.push(exp('2026-07-28', 1000, 'c-super', 'Supermercado', 'Alimentação > Supermercado'));
  rows.push(exp('2026-08-02', 500, 'c-super', 'Supermercado', 'Alimentação > Supermercado'));
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

async function bodyAs(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projOf(body: Record<string, unknown>): any {
  return body.projection;
}

const BASE_QUESTION = 'Qual a previsão de gastos para os próximos 12 meses?';
const AMBIGUOUS_SNIPPET = 'Posso te ajudar com a projeção em quatro cenários';

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
});

describe('PESSOAL-13C4A-E3.1 — conversa 1: cadeia de projeção com sinônimo de segmento, mês explícito, comparação e mês futuro', () => {
  it('mercado→Supermercado (decoy Mercado Livre ignorada); mês explícito e comparação preservam lente; futuro esclarece; tudo sem Gemini', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const c = new ProjChatFake(chainRows());
    c.seedCategories([
      { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' },
      { display_name: 'Mercado Livre', canonical_path: 'Compras > Mercado Livre' },
      { display_name: 'Restaurantes', canonical_path: 'Alimentação > Restaurantes' },
      { display_name: 'Transporte', canonical_path: 'Transporte' },
    ]);
    seedConv(c);
    authOk(c);

    // m1 — total de categoria tradicional: 'mercado' casa o SEGMENTO canônico
    // "supermercado" via sinônimo; a decoy "Mercado Livre" (substring) fica fora.
    const res1 = await handler(
      postRequest({ question: 'Quanto gastei com mercado em julho?', conversationId: 'conv-1', clientRequestId: 'm1' }),
    );
    expect(res1.status).toBe(200);
    const body1 = await bodyAs(res1);
    expect(body1.engine).toBe('deterministic');
    expect(body1.answer as string).toContain('Alimentação > Supermercado');
    expect(body1.answer as string).toMatch(/R\$\s+2\.000,00/);
    expect(body1.answer as string).not.toContain('Mercado Livre');
    expect(projOf(body1)).toBeUndefined();

    // m2 — âncora: projeção base.
    const res2 = await handler(
      postRequest({ question: BASE_QUESTION, conversationId: 'conv-1', clientRequestId: 'm2' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    const p2 = projOf(body2);
    expect(p2).toBeDefined();
    expect(p2.intent).toBe('projection_base');
    expect(p2.status).toBe('success');
    expect(p2.quality).toBe('full');
    expect(p2.reference).toEqual({ month: '2026-08', kind: 'current' });
    expect(sanitizeProjectionPayloadV1(p2)).toEqual(p2);

    // m3 — lente elíptica: 'mercado' resolve o sinônimo canônico "Supermercado",
    // nunca a decoy "Mercado Livre" (casa erraria por substring).
    const res3 = await handler(
      postRequest({ question: 'E só mercado?', conversationId: 'conv-1', clientRequestId: 'm3' }),
    );
    expect(res3.status).toBe(200);
    const body3 = await bodyAs(res3);
    const p3 = projOf(body3);
    expect(p3).toBeDefined();
    expect(p3.intent).toBe('projection_base');
    expect(p3.lens).toEqual({ label: 'Supermercado' });
    expect(body3.answer as string).toContain('próximos 12 meses');
    expect((body3.answer as string).toLowerCase()).not.toContain('mercado livre');
    expect(sanitizeProjectionPayloadV1(p3)).toEqual(p3);
    const ctx3 = c.state.chat_conversations[0].context as { projection?: { lensPath?: string; lensLabel?: string } } | null;
    expect(ctx3?.projection?.lensPath).toBe('Alimentação > Supermercado');
    expect(ctx3?.projection?.lensLabel).toBe('Supermercado');

    // m4 — mês explícito do mês ATUAL com ano: o ano puro restante NUNCA é lente;
    // preserva intent + referência + lente (defeito "mês explícito → lente").
    const res4 = await handler(
      postRequest({ question: 'E em agosto de 2026?', conversationId: 'conv-1', clientRequestId: 'm4' }),
    );
    expect(res4.status).toBe(200);
    const body4 = await bodyAs(res4);
    const p4 = projOf(body4);
    expect(p4).toBeDefined();
    expect(p4.intent).toBe('projection_base');
    expect(p4.reference).toEqual({ month: '2026-08', kind: 'current' });
    expect(p4.lens).toEqual({ label: 'Supermercado' });
    expect(sanitizeProjectionPayloadV1(p4)).toEqual(p4);

    // m5 — "E comparado à média?" mantém o contexto e vira comparação mensal
    // com a MESMA lente (antes o contexto havia sido limpo → culminaria nele/Gemini).
    const res5 = await handler(
      postRequest({ question: 'E comparado à média?', conversationId: 'conv-1', clientRequestId: 'm5' }),
    );
    expect(res5.status).toBe(200);
    const body5 = await bodyAs(res5);
    const p5 = projOf(body5);
    expect(p5).toBeDefined();
    expect(p5.intent).toBe('projection_month_comparison');
    expect(p5.reference).toEqual({ month: '2026-08', kind: 'current' });
    expect(p5.comparison.referenceBasis).toBe('expected_to_date');
    expect(p5.lens).toEqual({ label: 'Supermercado' });
    expect(sanitizeProjectionPayloadV1(p5)).toEqual(p5);

    // m6 — mês futuro: clarificação determinística SEM consulta a tabelas
    // financeiras e SEM projection; limpa o contexto (nova âncora para m7).
    const txCallsBefore = txCallCount(c);
    const res6 = await handler(
      postRequest({ question: 'E no próximo mês?', conversationId: 'conv-1', clientRequestId: 'm6' }),
    );
    expect(res6.status).toBe(200);
    const body6 = await bodyAs(res6);
    expect(body6.engine).toBe('deterministic');
    expect(projOf(body6)).toBeUndefined();
    expect((body6.answer as string).includes('meses futuros')).toBe(true);
    expect(txCallCount(c)).toBe(txCallsBefore);

    // m7 — recuperação: turno tradicional continua determinístico após esclarecer.
    const res7 = await handler(
      postRequest({ question: 'Quanto gastei este mês?', conversationId: 'conv-1', clientRequestId: 'm7' }),
    );
    expect(res7.status).toBe(200);
    const body7 = await bodyAs(res7);
    expect(body7.engine).toBe('deterministic');
    expect(projOf(body7)).toBeUndefined();
    expect((body7.answer as string).includes('totalizaram')).toBe(true);

    expect(gem.calls).toBe(0);
  });
});

describe('PESSOAL-13C4A-E3.1 — conversa 2: ambiguidade nomeada de categoria + follow-up sem contexto', () => {
  it('"mercado" com Supermercado e mercado canônicos esclarece as duas; "E por categorias?" sem contexto responde os cenários; germinam sem Gemini', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const c = new ProjChatFake(chainRows());
    c.seedCategories([
      { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' },
      { display_name: 'mercado', canonical_path: 'Alimentação > mercado' },
      { display_name: 'Restaurantes', canonical_path: 'Alimentação > Restaurantes' },
      { display_name: 'Transporte', canonical_path: 'Transporte' },
    ]);
    seedConv(c);
    authOk(c);

    // m1 — resolução ambígua NOMEADA: nunca escolhe em silêncio entre
    // "Alimentação > Supermercado" e "Alimentação > mercado".
    const res1 = await handler(
      postRequest({ question: 'Quanto gastei com mercado em julho?', conversationId: 'conv-1', clientRequestId: 'c1-m1' }),
    );
    expect(res1.status).toBe(200);
    const body1 = await bodyAs(res1);
    expect(body1.engine).toBe('deterministic');
    expect(body1.answer as string).toContain('mais de uma categoria possível');
    expect(body1.answer as string).toContain('Supermercado');
    expect(body1.answer as string).toContain('mercado');
    expect(projOf(body1)).toBeUndefined();

    // m2 — "E por categorias?" SEM contexto nenhum é follow-up de projeção e
    // responde os quatro cenários, sem consultar nada e sem Gemini.
    const txCallsBefore = txCallCount(c);
    const res2 = await handler(
      postRequest({ question: 'E por categorias?', conversationId: 'conv-1', clientRequestId: 'c1-m2' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await bodyAs(res2);
    expect(body2.engine).toBe('deterministic');
    expect(projOf(body2)).toBeUndefined();
    expect((body2.answer as string).includes(AMBIGUOUS_SNIPPET)).toBe(true);
    expect(txCallCount(c)).toBe(txCallsBefore);

    // m3 — recuperação: turno tradicional segue determinístico.
    const res3 = await handler(
      postRequest({ question: 'Quanto gastei este mês?', conversationId: 'conv-1', clientRequestId: 'c1-m3' }),
    );
    expect(res3.status).toBe(200);
    const body3 = await bodyAs(res3);
    expect(body3.engine).toBe('deterministic');
    expect((body3.answer as string).includes('totalizaram')).toBe(true);

    expect(gem.calls).toBe(0);
  });
});