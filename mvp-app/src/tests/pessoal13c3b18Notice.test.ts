// pessoal13c3b18Notice.test.ts — PESSOAL-13C3B.18: aviso de economia nunca
// é truncado no meio de uma palavra.
//
// Prova que:
//   1. a resposta de 10% com vários grupos excluídos produz um notice SEMPRE
//      dentro de PAYLOAD_NOTICE_MAX, com frase e pontuação completas (nunca
//      termina em "pruden" ou fragmento de palavra);
//   2. o follow-up "E 5%?" tem o mesmo comportamento, com o percentual correto
//      e zero chamadas ao Gemini;
//   3. um resultado com apenas alguns tipos de exclusão NÃO menciona os grupos
//      ausentes;
//   4. a lente "Só em combustível?" mantém o aviso curto, sem justificativas
//      irrelevantes;
//   5. a resposta fresca, o cache e o listMessages (F5) transportam o MESMO
//      notice, exatamente igual;
//   6. o sanitizador, diante de um notice artificialmente maior que o limite,
//      permanece dentro do teto, corta em fronteira segura (limite de frase ou
//      último espaço com reticências), não mutila palavra e não emite HTML;
//   7. cards, valores e ranking existentes permanecem inalterados.
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
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { contextFromTurn } from '../../server/chat/chatContext';
import type { ChatContextState } from '../../server/chat/chatTypes';
import { PAYLOAD_NOTICE_MAX, sanitizeChatPayload } from '../../server/chat/payloadSanitize';
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { listMessages } from '../lib/chatApi';

// ═══════════════ Cliente fake / fixtures (roteador) ═══════════════

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

const SUP = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PAD = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };
const CMB = { display_name: 'Combustível', canonical_path: 'Transporte > Combustível' };
const ALUG = { display_name: 'Aluguel', canonical_path: 'Moradia > Aluguel' };
const EMP = { display_name: 'Empréstimo', canonical_path: 'Dívidas > Empréstimo' };
const FAR = { display_name: 'Farmácia', canonical_path: 'Saúde > Farmácia' };
const MED = { display_name: 'Medicamento', canonical_path: 'Saúde > Medicamento' };
const INVEST = { display_name: 'Investimentos', canonical_path: 'Investimentos' };

const EXPENSE_CATS: CatFakeRow[] = [
  { ...SUP, direction: 'expense' },
  { ...PAD, direction: 'expense' },
  { ...CMB, direction: 'expense' },
  { ...ALUG, direction: 'expense' },
  { ...EMP, direction: 'expense' },
  { ...FAR, direction: 'expense' },
  { ...MED, direction: 'expense' },
  { ...INVEST, direction: 'expense' },
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

function monthlyRows(pairs: Array<{ cat: typeof SUP; amount: number }>): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [JAN, FEV, MAR, ABR, MAI, JUN]) {
    for (const p of pairs) out.push(rowFor(p.cat, p.amount, d));
  }
  return out;
}

/** SUPER elegível + 1 excluída de CADA um dos 4 tipos. */
function fourExcludedRows(): FakeRow[] {
  return monthlyRows([
    { cat: SUP, amount: 400 },
    { cat: ALUG, amount: 2000 },
    { cat: EMP, amount: 1500 },
    { cat: FAR, amount: 300 },
    { cat: INVEST, amount: 1200 },
  ]);
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
  rows: FakeRow[] = fourExcludedRows(),
  cats: CatFakeRow[] = EXPENSE_CATS,
): Promise<{ ans: DeterministicAnswer; fake: unknown; context: ChatContextState }> {
  const { fake } = mkClient(rows, cats);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, context: contextOf(ans) };
}

function cardRows(ans: DeterministicAnswer | null | undefined): Record<string, string>[] {
  return (ans?.response.cards ?? []).map((c) =>
    Object.fromEntries((c.rows ?? []).map((r) => [r.label, r.value])),
  );
}

function endsWithSentenceEnd(text: string): boolean {
  return /[.!?]$/.test(text.trimEnd());
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
});

// ═══════════════ 1. 10% com vários grupos excluídos ═══════════════

describe('PESSOAL-13C3B.18 — notice de 10% com vários grupos excluídos', () => {
  it('notice completo, dentro do limite, termina com pontuação e não corta palavra', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const notice = ans.response.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(endsWithSentenceEnd(notice)).toBe(true);
    expect(notice).not.toContain('não é pruden');
    const trail = notice.trimEnd().split(/\s+/).pop() ?? '';
    expect(trail).toMatch(/[.!?]$/);
    // Ressalvas obrigatórias preservadas.
    expect(notice).toContain('Simulação de 10% sobre a média mensal recente');
    expect(notice).toContain('economia anualizada corresponde ao valor mensal × 12');
    expect(notice).toContain('É apenas um cenário, não uma previsão nem recomendação automática');
    // Cada tipo realmente excluído é citado com sua justificativa.
    expect(notice).toContain('Aluguel');
    expect(notice).toContain('Empréstimo');
    expect(notice).toContain('compromissos fixos e dívidas exigem análise de contrato, saldo e taxas');
    expect(notice).toContain('Farmácia');
    expect(notice).toContain('corte em despesas de saúde exige avaliação de necessidade');
    expect(notice).toContain('Investimentos');
    expect(notice).toContain('alocação patrimonial, não consumo');
    // Cards e valores preservados.
    const cards = ans.response.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('savings');
    expect(cards[0]?.title).toBe('Alimentação > Supermercado');
    const rows = cardRows(ans)[0];
    expect(rows['Economia mensal (cenário 10%)']).toContain('40,00');
    expect(rows['Economia anualizada (simulação)']).toContain('480,00');
    expect(ans.response.geminiCallCount).toBe(0);
  });
});

// ═══════════════ 2. Follow-up "E 5%?" ═══════════════

describe('PESSOAL-13C3B.18 — follow-up "E 5%?"', () => {
  it('mesmo comportamento, percentual correto e zero Gemini', async () => {
    const { ans, fake } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E 5%?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.simulationPct).toBe(5);
    const notice = fu?.response.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(endsWithSentenceEnd(notice)).toBe(true);
    expect(notice).toContain('Simulação de 5% sobre a média mensal recente');
    expect(notice).toContain('Aluguel');
    const rows = cardRows(fu)[0];
    expect(rows['Economia mensal (cenário 5%)']).toContain('20,00');
    expect(rows['Economia anualizada (simulação)']).toContain('240,00');
    expect(fu?.response.geminiCallCount).toBe(0);
  });
});

// ═══════════════ 3. Somente alguns tipos de exclusão ═══════════════

describe('PESSOAL-13C3B.18 — cita somente os tipos realmente excluídos', () => {
  it('apenas alocação patrimonial presente: não fala de dívida/saúde/contrato', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: INVEST, amount: 1200 },
    ]));
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Investimentos');
    expect(notice).toContain('alocação patrimonial, não consumo');
    expect(notice.toLowerCase()).not.toContain('dívida');
    expect(notice.toLowerCase()).not.toContain('saúde');
    expect(notice.toLowerCase()).not.toContain('contrato');
    expect(notice.toLowerCase()).not.toContain('aluguel');
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('apenas despesas de saúde presente: não fala de dívida/investimento/contrato', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: FAR, amount: 300 },
    ]));
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Farmácia');
    expect(notice).toContain('corte em despesas de saúde exige avaliação de necessidade');
    expect(notice.toLowerCase()).not.toContain('dívida');
    expect(notice.toLowerCase()).not.toContain('investimento');
    expect(notice.toLowerCase()).not.toContain('contrato');
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('apenas compromisso fixo presente: não fala de dívida/saúde/investimento', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: ALUG, amount: 2000 },
    ]));
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Aluguel ficou fora: é compromisso fixo e exige análise de contrato e condições.');
    expect(notice.toLowerCase()).not.toContain('dívida');
    expect(notice.toLowerCase()).not.toContain('saúde');
    expect(notice.toLowerCase()).not.toContain('investimento');
    expect(ans.response.geminiCallCount).toBe(0);
  });
});

// ═══════════════ 4. Lente "Só em combustível?" ═══════════════

describe('PESSOAL-13C3B.18 — lente "Só em combustível?"', () => {
  it('aviso curto e sem justificativas irrelevantes', async () => {
    const rows = monthlyRows([
      { cat: CMB, amount: 200 },
      { cat: SUP, amount: 400 },
      { cat: ALUG, amount: 2000 },
      { cat: EMP, amount: 1500 },
    ]);
    const { ans, fake } = await firstTurn('Onde posso economizar mais?', rows);
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Só em combustível?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.analysis?.categoryPath).toBe('Transporte > Combustível');
    expect((fu?.response.cards ?? []).map((c) => c.title)).toEqual(['Transporte > Combustível']);
    const notice = fu?.response.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(notice).toContain('Simulação de 10% sobre a média mensal recente');
    expect(notice.toLowerCase()).not.toContain('aluguel');
    expect(notice.toLowerCase()).not.toContain('empréstimo');
    expect(notice.toLowerCase()).not.toContain('compromisso fixo');
    expect(notice.toLowerCase()).not.toContain('dívida');
    expect(notice.toLowerCase()).not.toContain('exclusão');
    expect(fu?.response.geminiCallCount).toBe(0);
  });
});

// ═══════════════ 5. Fresca = cache = listMessages (F5) ═══════════════

type Row = Record<string, unknown>;

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

const JSON_HEADERS = { 'content-type': 'application/json' };

function postRequest(body: unknown): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: 'Bearer token-valido' },
    body: JSON.stringify(body),
  });
}

/** Datas dinâmicas (a janela six_complete usa o relógio REAL do handler). */
function slotDate(monthsBack: number, day = 15): string {
  const d = new Date();
  const dt = new Date(d.getFullYear(), d.getMonth() - monthsBack, day);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function fourExcludedRowsDynamic(): FakeRow[] {
  const BASE = [6, 5, 4, 3, 2, 1];
  const out: FakeRow[] = [];
  for (const off of BASE) {
    out.push(rowFor(SUP, 400, slotDate(off)));
    out.push(rowFor(ALUG, 2000, slotDate(off)));
    out.push(rowFor(EMP, 1500, slotDate(off)));
    out.push(rowFor(FAR, 300, slotDate(off)));
    out.push(rowFor(INVEST, 1200, slotDate(off)));
  }
  return out;
}

describe('PESSOAL-13C3B.18 — fresca = cache = listMessages (F5) no endpoint', () => {
  it('mesma resposta exata nos três caminhos, sem novas consultas no cache', async () => {
    const c = new StateFake();
    c.state.transactions = fourExcludedRowsDynamic();
    seedConv(c);

    authOk(c);
    const r1 = await handler(
      postRequest({ question: 'Onde tenho oportunidades de economia de 10%?', conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(r1.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b1 = (await r1.json()) as any;
    expect(b1.engine).toBe('deterministic');
    expect(b1.notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(b1.notice).toContain('Aluguel');
    expect(b1.cards).toHaveLength(1);

    const txBefore = c.calls.filter((x) => x.table === 'transactions').length;
    authOk(c);
    const r1b = await handler(
      postRequest({ question: 'Onde tenho oportunidades de economia de 10%?', conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(r1b.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b1b = (await r1b.json()) as any;
    expect(b1b.notice).toBe(b1.notice);
    expect(b1b.cards).toEqual(b1.cards);
    expect(c.calls.filter((x) => x.table === 'transactions').length).toBe(txBefore);

    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const completed = page.messages.filter((m) => m.role === 'assistant' && m.status === 'completed');
    const last = completed[completed.length - 1];
    expect(last.notice).toBe(b1.notice);
    expect(last.cards).toEqual(b1.cards);

    const persisted = c.state.chat_messages.find(
      (m) => m.role === 'assistant' && m.client_request_id === 'r1' && m.status === 'completed',
    )?.payload as { notice?: string } | undefined;
    expect(persisted?.notice).toBe(b1.notice);
  });
});

// ═══════════════ 6. Sanitizador com notice artificialmente longo ═══════════════

describe('PESSOAL-13C3B.18 — sanitizador corta em fronteira segura', () => {
  it('texto com várias frases: corta no último limite de frase, sem palavra mutilada, sem HTML', () => {
    const sentence =
      'A economia anualizada equivale ao valor mensal multiplicado por doze e nao representa uma previsao. ';
    const raw = sentence.repeat(20);
    const out = sanitizeChatPayload({ notice: raw });
    const notice = out.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(notice.endsWith('.')).toBe(true);
    expect(raw.startsWith(notice)).toBe(true);
    // O corte é exatamente após uma frase: o que vinha logo depois era um espaço.
    const nxt = raw.charAt(notice.length);
    expect(nxt === ' ' || nxt === '').toBe(true);
    expect(out.notice).not.toMatch(/[<>]/);
  });

  it('texto com palavras longas e SEM pontuação: corta no último espaço e adiciona reticências', () => {
    const raw = Array.from({ length: 120 }, (_, i) => `palavra${i}`).join(' ') + ' fim';
    const out = sanitizeChatPayload({ notice: raw });
    const notice = out.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(notice.endsWith('…')).toBe(true);
    // O texto antes das reticências termina em palavra completa (não em espaço).
    const prefix = notice.slice(0, -1);
    expect(/\s$/.test(prefix)).toBe(false);
    expect(raw.startsWith(prefix)).toBe(true);
  });

  it('palavra única menor que o limite permanece intacta; maior que o limite vira prefixo com reticências', () => {
    const short = sanitizeChatPayload({ notice: 'palavra' });
    expect(short.notice).toBe('palavra');

    const long = sanitizeChatPayload({ notice: 'X'.repeat(PAYLOAD_NOTICE_MAX * 2) });
    expect(long.notice?.length).toBe(PAYLOAD_NOTICE_MAX);
    expect(long.notice?.endsWith('…')).toBe(true);
  });

  it('HTML/tags são removidas antes do corte (resultado sem < e >)', () => {
    const raw = `<b>${'Frase curta e segura. '.repeat(40)}<i>fim</i></b>`;
    const out = sanitizeChatPayload({ notice: raw });
    const notice = out.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    expect(notice).not.toMatch(/[<>]/);
    expect(endsWithSentenceEnd(notice)).toBe(true);
  });
});

// ═══════════════ 7. Cards, valores e ranking inalterados ═══════════════

describe('PESSOAL-13C3B.18 — cards, valores e ranking preservados', () => {
  it('excluídas não consomem o limite de 3 cards; ranking e valores continuam corretos', async () => {
    const rows = monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: PAD, amount: 300 },
      { cat: CMB, amount: 200 },
      { cat: ALUG, amount: 2000 },
      { cat: EMP, amount: 1500 },
      { cat: FAR, amount: 500 },
      { cat: MED, amount: 300 },
      { cat: INVEST, amount: 1200 },
    ]);
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', rows);
    const cards = ans.response.cards ?? [];
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.title)).toEqual([
      'Alimentação > Supermercado',
      'Alimentação > Padaria',
      'Transporte > Combustível',
    ]);
    expect(cards.every((c) => c.kind === 'savings')).toBe(true);
    const byTitle = Object.fromEntries(cardRows(ans).map((r, i) => [cards[i]?.title, r]));
    expect(byTitle['Alimentação > Supermercado']?.['Economia mensal (cenário 10%)']).toContain('40,00');
    expect(byTitle['Alimentação > Supermercado']?.['Economia anualizada (simulação)']).toContain('480,00');
    expect(byTitle['Alimentação > Padaria']?.['Economia mensal (cenário 10%)']).toContain('30,00');
    expect(byTitle['Alimentação > Padaria']?.['Economia anualizada (simulação)']).toContain('360,00');
    expect(byTitle['Transporte > Combustível']?.['Economia mensal (cenário 10%)']).toContain('20,00');
    expect(byTitle['Transporte > Combustível']?.['Economia anualizada (simulação)']).toContain('240,00');

    const notice = ans.response.notice ?? '';
    expect(notice.length).toBeLessThanOrEqual(PAYLOAD_NOTICE_MAX);
    for (const name of ['Aluguel', 'Empréstimo', 'Farmácia', 'Medicamento', 'Investimentos']) {
      expect(notice).toContain(name);
    }
    expect(JSON.stringify(ans.response.cards)).not.toContain('Farmácia');
    expect(JSON.stringify(ans.response.cards)).not.toContain('Investimentos');
    expect(ans.response.geminiCallCount).toBe(0);
  });
});