// pessoal13c2Chat.test.ts — PESSOAL-13C2: chat persistente + contexto.
//
// Prova que:
//   1. chatContext (puro): título, resumo, contexto pós-turno (lens canônica
//      SOMENTE determinística), bloco compacto do Gemini com teto rígido;
//   2. chatStore: idempotência (fresh / in_flight / cached / cached_failure),
//      ownership (conversa inexistente = ChatOwnershipError, indistinguível de
//      "de outro perfil" — isolamento por design via RLS), concorrência
//      (UNIQUE 23505 re-resolve a âncora), complete/fail:
//   3. endpoint /api/finances/ask: persistence liga SÓ com os dois ids;
//      clique duplo devolve cache (mesma resposta SEM nova consulta);
//      in_flight = 409; falha anterior = 502 sanitizado; conversa de outro
//      perfil = 404; sem ids = 100% stateless;
//   4. rota determinística aplica contexto de follow-up ("E em maio?" herda
//      categoria; período do contexto prevalece sobre a tela);
//   5. chatState: reducer puro com mensagens otimistas reconciliadas por
//      clientRequestId, paginação (older_loaded prepend+dedupe) e deleção.
//   6. UI finance-ai aumenta sem perder o contrato da C1 (renderToString).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

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

vi.mock('../supabaseClient', () => ({ supabase: {} }));

import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import {
  beginChatTurn,
  completeChatTurn,
  failChatTurn,
  ChatOwnershipError,
} from '../../server/chat/chatStore';
import {
  emptyContext,
  summaryOf,
  titleFromQuestion,
  contextFromTurn,
  geminiContextBlock,
} from '../../server/chat/chatContext';
import {
  CHAT_GEMINI_CONTEXT_CHARS,
  CHAT_GEMINI_RECENT_MSGS,
  CHAT_SUMMARIES_MAX,
  type ChatContextState,
} from '../../server/chat/chatTypes';
import { applyContextToQuestion, runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import {
  chatReducer,
  createChatState,
  shouldSendOnEnter,
  uiTitleFor,
  mergeServerMessages,
  CHAT_PAGE_SIZE,
  type UiMessage,
} from '../../src/lib/chatState';
import { FinanceAiSection } from '../../src/components/FinanceAiSection';

const JSON_HEADERS = { 'content-type': 'application/json' };

// ── Fake Supabase (browser-less, com estado por tabela) ─────────────────────

type Row = Record<string, any>;

interface Filter {
  op: 'is' | 'eq' | 'gte' | 'lte';
  key: string;
  value: unknown;
}

interface BuilderState {
  table: string;
  columns: string;
  filters: Filter[];
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

class FakeClient {
  state: Record<string, Row[]> = {
    transactions: [],
    categories: [],
    chat_conversations: [],
    chat_messages: [],
  };
  calls: Array<{ table: string; action: string; filters: Filter[] }> = [];

  from(table: string): Record<string, any> {
    const self = this;
    const b: BuilderState = {
      table,
      columns: '*',
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: Record<string, any> = {
      select(cols = '*', opts?: { count?: 'exact' }) {
        b.columns = cols;
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
      delete() {
        b.action = 'delete';
        return base;
      },
      then(resolve: (v: unknown) => unknown) {
        self.calls.push({ table, action: b.action, filters: [...b.filters] });
        return resolve(execute(b));
      },
    };
    return base;
  }
}

function matchesFilter(row: Row, f: Filter): boolean {
  const v = row[f.key];
  if (f.op === 'is') return (f.value === null ? v === null : v === f.value);
  if (f.op === 'eq') return v === f.value;
  if (f.op === 'gte') return typeof v === 'string' ? v >= (f.value as string) : v >= (f.value as number);
  if (f.op === 'lte') return typeof v === 'string' ? v <= (f.value as string) : v <= (f.value as number);
  return false;
}

function uniqViolation(): Error & { code: string } {
  const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  e.code = '23505';
  return e;
}

// Postgres 15+ (migrations 023/026): índices UNIQUE são NULLS DISTINCT por
// padrão — NULL nunca colide com NULL. O FakeClient não pode considerar dois
// valores NULL iguais, senão fingiria um conflito que o banco real não tem.
function conflictKeyEqual(a: Row[keyof Row], b: Row[keyof Row]): boolean {
  if (a === null || b === null) return false;
  return a === b;
}

function dupCollides(a: Row, b: Row, keys: string[]): boolean {
  return keys.every((k) => conflictKeyEqual(a[k], b[k]));
}

function execute(b: BuilderState): { data: unknown; count: number | null; error: unknown } {
  if (b.action === 'upsert') {
    const keySet = b.onConflict.split(',');
    for (const row of b.rows) {
      const dup = rowsOf(b).some((r) => dupCollides(r, row, keySet));
      if (dup && !b.ignoreDuplicates) return { data: null, count: null, error: uniqViolation() };
      if (!dup) rowsPush(b, row);
    }
    return { data: null, count: null, error: null };
  }

  if (b.action === 'insert') {
    for (const row of b.rows) {
      if (
        b.table === 'chat_messages' &&
        rowsOf(b).some((r) => dupCollides(r, row, ['conversation_id', 'client_request_id', 'role']))
      ) {
        return { data: null, count: null, error: uniqViolation() };
      }
      rowsPush(b, row);
    }
    return { data: null, count: null, error: null };
  }

  let selected = rowsOf(b).filter((r) => b.filters.every((f) => matchesFilter(r, f)));
  for (const o of b.orders) {
    selected = [...selected].sort((a, r) => {
      const av = a[o.key];
      const rv = r[o.key];
      if (av === rv) return 0;
      if (av === undefined) return 1;
      if (rv === undefined) return -1;
      return av < rv ? -1 : 1;
    });
    if (!o.asc) selected.reverse();
  }

  if (b.action === 'update') {
    for (const row of selected) Object.assign(row, b.patch);
    return { data: null, count: null, error: null };
  }
  if (b.action === 'delete') {
    if (b.table === 'chat_messages') {
      bTableState(b, b.table, rowsOf(b).filter((r) => !selected.includes(r)));
    } else {
      bTableState(b, b.table, rowsOf(b).filter((r) => !selected.includes(r)));
    }
    return { data: null, count: null, error: null };
  }

  const total = selected.length;
  const page = selected.slice(b.fromRange, b.toRange + 1);
  if (b.maybe) return { data: page[0] ?? null, count: b.countOpt ? total : null, error: null };
  if (b.single) return { data: page[0] ?? null, count: b.countOpt ? total : null, error: null };
  return { data: page, count: b.countOpt ? total : null, error: null };
}

// Estado por tabela é mutável: helpers abaixo garantem leitura/escrita em `state[table]`.
let fakeClientRef: FakeClient | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setRef(c: any): FakeClient {
  fakeClientRef = c as FakeClient;
  return c as FakeClient;
}
function rowsOf(b: BuilderState): Row[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (fakeClientRef as any).state[b.table] as Row[];
}
function rowsPush(b: BuilderState, row: Row): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fakeClientRef as any).state[b.table].push(row);
}
function bTableState(b: BuilderState, table: string, rows: Row[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fakeClientRef as any).state[table] = rows;
}

// Fim das helpers: o BuilderState b depende do ref global; cada teste cria um
// FakeClient novo, então o ref é reatribuído antes de cada handler.

function detRows(rows: Row[]): FakeClient {
  const c = new FakeClient();
  c.state.transactions = rows;
  return setRef(c);
}

function withChat(conv: Row | null, messages: Row[]): FakeClient {
  const c = new FakeClient();
  if (conv) c.state.chat_conversations = [conv];
  c.state.chat_messages = messages;
  return setRef(c);
}

function authOk(client: FakeClient): void {
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

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

const SUP = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado', direction: 'expense' };
const SUP_CATS = [SUP];
const APRIL2026 = { start: '2026-04-01', end: '2026-04-30' };
const CONV = { id: 'conv-1', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

afterEach(() => {
  fakeClientRef = null;
});

// ── 1. chatContext: lógica pura ─────────────────────────────────────────────

describe('PESSOAL-13C2 — chatContext: título, resumo e contexto', () => {
  it('titleFromQuestion usa a primeira linha e trunca no teto', () => {
    expect(titleFromQuestion('  quanto gastei em maio?  ')).toBe('quanto gastei em maio?');
    expect(titleFromQuestion('linha 1\nlinha 2')).toBe('linha 1');
    const long = 'x'.repeat(300);
    expect(titleFromQuestion(long).length).toBeLessThanOrEqual(160);
    expect(titleFromQuestion('\n\n')).toBe('Conversa');
  });

  it('summaryOf vira linha única sem quebras e trunca em 240', () => {
    const s = summaryOf('primeira\nsegunda   linha   aqui');
    expect(s).toBe('primeira segunda linha aqui');
    expect(summaryOf('y'.repeat(500)).length).toBeLessThanOrEqual(240);
  });

  it('emptyContext não tem lente nem resumos', () => {
    expect(emptyContext()).toEqual({ category: null, intent: null, period: null, summaries: [] });
  });

  it('contextFromTurn persiste a lens determinística e descarta a anterior no turno Gemini', () => {
    const pre = { category: 'Alimentação > Supermercado', intent: 'category_total', period: APRIL2026, summaries: [] };
    const next = contextFromTurn(pre, {
      intent: 'total_expenses',
      category: null,
      periodAnalyzed: { start: '2026-05-01', end: '2026-05-31' },
      answer: 'Suas despesas em maio totalizaram R$ 100,00.',
    });
    expect(next.category).toBeNull();
    expect(next.intent).toBe('total_expenses');
    expect(next.period).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(next.summaries).toHaveLength(1);
  });

  it('summaries guardam no máximo CHAT_SUMMARIES_MAX resumos', () => {
    let ctx = emptyContext();
    for (let i = 0; i < 8; i += 1) {
      ctx = contextFromTurn(ctx, { intent: 'total_expenses', category: null, periodAnalyzed: null, answer: `resposta ${i}` });
    }
    expect(ctx.summaries.length).toBeLessThanOrEqual(CHAT_SUMMARIES_MAX);
    expect(ctx.summaries).toEqual(['resposta 4', 'resposta 5', 'resposta 6', 'resposta 7']);
  });
});

describe('PESSOAL-13C2 — geminiContextBlock (teto rígido)', () => {
  it('retorna "" sem contexto', () => {
    expect(geminiContextBlock(null)).toBe('');
    expect(geminiContextBlock(emptyContext())).toBe('');
  });

  it('descreve a lente e o período de forma legível', () => {
    const ctx: ChatContextState = {
      category: 'Alimentação > Supermercado',
      intent: 'category_total',
      period: APRIL2026,
      summaries: ['Suas despesas com Supermercado em abril de 2026 totalizaram R$ 100,00.'],
    };
    const block = geminiContextBlock(ctx);
    expect(block).toContain('Categoria em foco: Alimentação > Supermercado');
    expect(block).toContain('Intenção anterior: category_total');
    expect(block).toContain('Período do contexto: abril de 2026');
    expect(block).toContain('Resumos de respostas anteriores:');
  });

  it('recentes limitadas a CHAT_GEMINI_RECENT_MSGS e cada uma truncada em 300', () => {
    const recent = Array.from({ length: 10 }, (_, i) => 'm'.repeat(500 + i));
    const block = geminiContextBlock(emptyContext(), recent);
    // "Últimas mensagens:" aparece apenas UMA vez (não há linhas por mensagem).
    expect(block).toContain('Últimas mensagens:');
    const lines = block.split('\n');
    const recentLine = lines.find((l) => l.startsWith('Últimas mensagens:'));
    expect(recentLine).toBeDefined();
    const items = (recentLine as string).replace('Últimas mensagens: ', '').split(' | ').filter(Boolean);
    expect(items.length).toBeLessThanOrEqual(CHAT_GEMINI_RECENT_MSGS);
    for (const item of items) expect(item.length).toBeLessThanOrEqual(300);
  });

  it('bloco completo respeita CHAT_GEMINI_CONTEXT_CHARS', () => {
    const ctx: ChatContextState = {
      category: 'C'.repeat(1200),
      intent: 'category_total',
      period: APRIL2026,
      summaries: Array.from({ length: 20 }, () => 'z'.repeat(500)),
    };
    const block = geminiContextBlock(ctx, Array.from({ length: 20 }, () => 'w'.repeat(400)));
    expect(block.length).toBeLessThanOrEqual(CHAT_GEMINI_CONTEXT_CHARS);
  });
});

// ── 2. chatStore: idempotência e ownership ──────────────────────────────────

describe('PESSOAL-13C2 — chatStore: ownership e veredito do turno', () => {
  it('conversa inexistente (inclusive de OUTRO perfil) → ChatOwnershipError', async () => {
    const c = setRef(new FakeClient());
    await expect(
      beginChatTurn(c as never, { conversationId: 'conv-de-outra', clientRequestId: 'r1', question: 'oi' }),
    ).rejects.toBeInstanceOf(ChatOwnershipError);
  });

  it('fresh: grava a pergunta do usuário e a âncora assistant pending', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    const res = await beginChatTurn(c as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'Quanto gastei?' });
    expect(res.kind).toBe('fresh');
    const msgs = c.state.chat_messages;
    expect(msgs).toHaveLength(2);
    const user = msgs.find((m) => m.role === 'user');
    const anchor = msgs.find((m) => m.role === 'assistant');
    expect(user?.client_request_id).toBe('r1');
    expect(user?.status).toBe('completed');
    expect(anchor?.status).toBe('pending');
  });

  it('reenvio com âncora pending → in_flight (409 no endpoint)', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1' },
    ];
    const res = await beginChatTurn(c as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'Quanto gastei?' });
    expect(res.kind).toBe('in_flight');
  });

  it('reenvio com âncora completed → cached (mesma resposta, sem reprocessar)', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'completed', client_request_id: 'r1', content: 'Total: R$ 10,00.', payload: { engine: 'deterministic', toolsUsed: ['financial_summary'] }, period_analyzed: APRIL2026 },
    ];
    const res = await beginChatTurn(c as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'x' });
    expect(res).toEqual({
      kind: 'cached',
      answer: 'Total: R$ 10,00.',
      payload: { engine: 'deterministic', toolsUsed: ['financial_summary'] },
      periodAnalyzed: APRIL2026,
    });
  });

  it('reenvio com âncora failed → cached_failure (mensagem sanitizada)', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'failed', client_request_id: 'r1', content: '', error: 'Serviço temporariamente indisponível.' },
    ];
    const res = await beginChatTurn(c as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'x' });
    expect(res.kind).toBe('cached_failure');
    if (res.kind === 'cached_failure') expect(res.message).toContain('Serviço temporariamente indisponível.');
  });

  it('concorrência: violação UNIQUE na âncora re-resolve o vencedor (não lança PGRST bruto)', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [
      {
        id: 'a1',
        conversation_id: 'conv-1',
        role: 'assistant',
        status: 'completed',
        client_request_id: 'r2',
        content: 'Resposta concorrente.',
        payload: { engine: 'gemini', geminiCallCount: 1, toolsUsed: [] },
        period_analyzed: null,
      },
    ];
    const res = await beginChatTurn(c as never, { conversationId: 'conv-1', clientRequestId: 'r2', question: 'concorrente' });
    expect(res.kind).toBe('cached');
  });

  it('completeChatTurn grava resposta, lens e título automático na primeira pergunta', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV, title: '' }];
    c.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1' },
    ];
    await completeChatTurn(c as never, {
      conversationId: 'conv-1',
      clientRequestId: 'r1',
      answer: 'Suas despesas em abril totalizaram R$ 100,00.',
      payload: { engine: 'deterministic', geminiCallCount: 0, toolsUsed: ['financial_summary'], evidence: [] },
      intent: 'total_expenses',
      engine: 'deterministic',
      periodAnalyzed: APRIL2026,
      context: { category: null, intent: 'total_expenses', period: APRIL2026, summaries: ['...'] },
      setTitle: true,
      title: 'Quanto gastei?',
    });
    const conv = c.state.chat_conversations[0];
    expect(conv.title).toBe('Quanto gastei?');
    expect(conv.context?.intent).toBe('total_expenses');
    expect(conv.last_message_at).toBeTruthy();
    const anchor = c.state.chat_messages.find((m) => m.role === 'assistant');
    expect(anchor?.status).toBe('completed');
    expect(anchor?.engine).toBe('deterministic');
    expect(anchor?.period_analyzed).toEqual(APRIL2026);
  });

  it('failChatTurn marca a âncora como failed com erro sanitizado (teto 2000)', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1' },
    ];
    await failChatTurn(c as never, {
      conversationId: 'conv-1',
      clientRequestId: 'r1',
      message: 'A análise demorou demais. Tente novamente.',
    });
    const anchor = c.state.chat_messages.find((m) => m.role === 'assistant');
    expect(anchor?.status).toBe('failed');
    expect(anchor?.content).toBe('');
    expect(anchor?.error).toBe('A análise demorou demais. Tente novamente.');
    expect(c.state.chat_conversations[0].updated_at).toBeTruthy();
  });

  it('nenhum perfil atravessa a camada de store (fonte sem profile_id)', async () => {
    const src = (await import('node:fs')).readFileSync(
      new URL('../../server/chat/chatStore.ts', import.meta.url),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toContain('profile_id');
    expect(src).not.toContain('profileId');
    expect(src).not.toContain('service_role');
  });
});

// ── 3. Endpoint: persistência, idempotência e isolamento ────────────────────

describe('PESSOAL-13C2 — endpoint com persistência', () => {
  it('sem ids (stateless) continua respondendo 200 e NÃO toca tabelas de chat', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([
      { transaction_kind: 'expense', amount: 100, occurred_on: '2026-04-05', categories: SUP },
    ]);
    authOk(c);
    const res = await handler(postRequest({ question: 'Quanto gastei em abril?', period: APRIL2026 }));
    expect(res.status).toBe(200);
    const tables = c.calls.map((x) => x.table);
    expect(tables).not.toContain('chat_messages');
    expect(tables).not.toContain('chat_conversations');
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
  });

  it('primeira pergunta da conversa persiste user+assistant e define título', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([
      { transaction_kind: 'expense', amount: 120, occurred_on: '2026-04-06', deleted_at: null, categories: SUP },
    ]);
    c.state.categories = [...SUP_CATS];
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [];
    authOk(c);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril?', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string; evidence: Array<{ label: string; value: string }> };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(120));
    const conv = c.state.chat_conversations[0];
    expect(conv.title).toBe('Quanto gastei em supermercado em abril?');
    expect(conv.context?.category).toBe('Alimentação > Supermercado');
    const msgs = c.state.chat_messages;
    expect(msgs).toHaveLength(2);
    expect(msgs.some((m) => m.role === 'assistant' && m.status === 'completed')).toBe(true);
    const hadTransactionQueries = c.calls.filter((x) => x.table === 'transactions');
    expect(hadTransactionQueries.length).toBeGreaterThan(0);
  });

  it('clique duplo (mesmo clientRequestId) devolve CACHE sem nova consulta de dados', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([
      { transaction_kind: 'expense', amount: 77, occurred_on: '2026-04-06', deleted_at: null, categories: SUP },
    ]);
    c.state.categories = [...SUP_CATS];
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [];
    authOk(c);
    const body1 = { question: 'Quanto gastei em supermercado em abril?', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' };
    const res1 = await handler(postRequest(body1));
    expect(res1.status).toBe(200);
    const txAfterFirst = c.calls.filter((x) => x.table === 'transactions').length;

    authOk(c);
    const res2 = await handler(postRequest(body1));
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { answer: string; engine?: string; evidence: Array<{ label: string; value: string }> };
    expect(b2.answer).toContain(brl(77));
    // Só o begin (lookup) foi tocado; NENHUMA consulta nova a transactions/categories.
    const txAfterSecond = c.calls.filter((x) => x.table === 'transactions').length;
    expect(txAfterSecond).toBe(txAfterFirst);
  });

  it('âncora pending em processamento → 409 in_flight (sem duplicar)', async () => {
    const c = withChat({ ...CONV }, [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1' },
    ]);
    authOk(c);
    const res = await handler(
      postRequest({ question: 'q', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('in_flight');
  });

  it('falha anterior com MESMO id → 502 com a mensagem sanitizada (retry usa novo id)', async () => {
    const c = withChat({ ...CONV }, [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'failed', client_request_id: 'r1', content: '', error: 'Serviço de inteligência indisponível no momento.' },
    ]);
    authOk(c);
    const res = await handler(
      postRequest({ question: 'q', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('upstream');
    expect(body.message).toContain('Serviço de inteligência indisponível no momento.');
  });

  it('conversa de OUTRO perfil (invisível à RLS) → 404 not_found', async () => {
    const c = withChat(null, []);
    authOk(c);
    const res = await handler(
      postRequest({ question: 'q', period: APRIL2026, conversationId: 'conv-de-outra', clientRequestId: 'r9' }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('erro em turno persistente marca a âncora como failed (best-effort)', async () => {
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('provider_boom');
      },
    });
    const c = withChat({ ...CONV }, []);
    authOk(c);
    const res = await handler(
      postRequest({ question: 'Devo investir mais?', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'rx' }),
    );
    expect(res.status).toBe(502);
    const anchor = c.state.chat_messages.find((m) => m.role === 'assistant' && m.client_request_id === 'rx');
    expect(anchor?.status).toBe('failed');
    expect(anchor?.error).toBeTruthy();
    // Mensagem amigável, SEM stack trace.
    expect(anchor?.error).not.toContain('provider_boom');
    expect(anchor?.error).not.toContain(' at ');
  });

  it('conversationId sem clientRequestId (ou inválido) → 400 (contrato do par)', async () => {
    const res1 = await handler(postRequest({ question: 'q', conversationId: 'conv-1', period: APRIL2026 }));
    expect(res1.status).toBe(400);
    const res2 = await handler(
      postRequest({ question: 'q', conversationId: 'conv-1', clientRequestId: 'id inválido!', period: APRIL2026 }),
    );
    expect(res2.status).toBe(400);
  });
});

// ── 4. Rota determinística com contexto de follow-up ─────────────────────────

describe('PESSOAL-13C2 — contexto determinístico (lens de continuidade)', () => {
  const ctx: ChatContextState = {
    category: 'Alimentação > Supermercado',
    intent: 'category_total',
    period: APRIL2026,
    summaries: [],
  };

  it('"E em maio?" herda a categoria e mantém maio explicitamente', () => {
    const applied = applyContextToQuestion('E em maio?', ctx);
    expect(applied.inheritedCategory).toBe('Alimentação > Supermercado');
    expect(applied.question).toBe('quanto gastei em Alimentação > Supermercado em maio de 2026');
    expect(applied.contextPeriodFallback).toBe(false);
  });

  it('"E com combustível?" troca a lente e herda o período do contexto', () => {
    const applied = applyContextToQuestion('E com combustível?', ctx);
    expect(applied.inheritedCategory).toBeNull();
    expect(applied.contextPeriodFallback).toBe(true);
  });

  it('"E aí?" vira pergunta canônica herdando categoria e período do contexto', () => {
    const applied = applyContextToQuestion('E aí?', ctx);
    expect(applied.inheritedCategory).toBe('Alimentação > Supermercado');
    expect(applied.question).toBe('quanto gastei em Alimentação > Supermercado no período');
    expect(applied.contextPeriodFallback).toBe(true);
  });

  it('pergunta nova (sem prefixo de continuidade) não é contaminada', () => {
    const applied = applyContextToQuestion('Quanto gastei em aluguel em maio?', ctx);
    expect(applied.question).toBe('Quanto gastei em aluguel em maio?');
    expect(applied.inheritedCategory).toBeNull();
  });

  it('integração: "E em maio?" responde o total do SUPERMERCADO em MAIO (período do contexto supera a tela)', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([
      // Supermercado em maio: o alvo do follow-up
      { transaction_kind: 'expense', amount: 333, occurred_on: '2026-05-03', deleted_at: null, categories: SUP },
      // Aluguel em maio: NÃO deve entrar
      { transaction_kind: 'expense', amount: 1000, occurred_on: '2026-05-05', deleted_at: null, categories: { display_name: 'Aluguel', canonical_path: 'Aluguel' } },
      // Supermercado em ABRIL (tela): NÃO deve entrar (contexto prevalece)
      { transaction_kind: 'expense', amount: 9999, occurred_on: '2026-04-03', deleted_at: null, categories: SUP },
    ]);
    c.state.categories = [
      { display_name: 'Alimentação', canonical_path: 'Alimentação', direction: 'expense' },
      ...SUP_CATS,
      { display_name: 'Aluguel', canonical_path: 'Aluguel', direction: 'expense' },
    ];
    authOk(c);
    const answer = await runDeterministicAsk({
      supabase: c as never,
      question: 'E em maio?',
      period: APRIL2026,
      context: ctx,
    });
    expect(answer).not.toBeNull();
    expect(answer?.intent).toBe('category_total');
    expect(answer?.category).toBe('Alimentação > Supermercado');
    expect(answer?.response.period).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(answer?.response.answer).toContain(brl(333));
    expect(answer?.response.answer).not.toContain(brl(9999));
  });

  it('sem contexto o follow-up scroll continua na tela (comportamento atual)', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([{ transaction_kind: 'expense', amount: 500, occurred_on: '2026-04-03', categories: SUP }]);
    c.state.categories = SUP_CATS;
    authOk(c);
    const answer = await runDeterministicAsk({
      supabase: c as never,
      question: 'E em maio?',
      period: APRIL2026,
    });
    // Sem contexto, "E em maio?" não tem intenção financeira → não determinístico.
    expect(answer).toBeNull();
  });
});

// ── 5. chatState: reducer puro ──────────────────────────────────────────────

describe('PESSOAL-13C2 — chatState: reducer e helpers', () => {
  it('send_start cria user+assistant otimistas com o MESMO clientRequestId', () => {
    const s = chatReducer(createChatState(), { type: 'send_start', clientRequestId: 'r1', question: 'Quanto gastei?' });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: 'user', status: 'sent', text: 'Quanto gastei?', clientRequestId: 'r1', optimistic: true });
    expect(s.messages[1]).toMatchObject({ role: 'assistant', status: 'pending', clientRequestId: 'r1', optimistic: true });
  });

  it('send_success reconhece a âncora pelo clientRequestId e aplica o payload', () => {
    let s = createChatState();
    s = chatReducer(s, { type: 'send_start', clientRequestId: 'r1', question: 'q' });
    s = chatReducer(s, {
      type: 'send_success',
      clientRequestId: 'r1',
      payload: {
        answer: 'Total: R$ 100,00.',
        engine: 'deterministic',
        periodAnalyzed: APRIL2026,
        evidence: [{ label: 'Despesas', value: 'R$ 100,00' }],
      },
    });
    const assistant = s.messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('completed');
    expect(assistant?.optimistic).toBe(false);
    expect(assistant?.text).toBe('Total: R$ 100,00.');
    expect(assistant?.engine).toBe('deterministic');
    expect(assistant?.periodAnalyzed).toEqual(APRIL2026);
    const user = s.messages.find((m) => m.role === 'user');
    expect(user?.status).toBe('sent');
  });

  it('send_error marca a âncora como failed com a mensagem amigável (retry não duplica)', () => {
    let s = createChatState();
    s = chatReducer(s, { type: 'send_start', clientRequestId: 'r1', question: 'q' });
    s = chatReducer(s, { type: 'send_error', clientRequestId: 'r1', message: 'Não foi possível responder agora.' });
    const assistant = s.messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('failed');
    expect(assistant?.error).toBe('Não foi possível responder agora.');

    // Retry usa NOVO clientRequestId → mensagens antigas permanecem (histórico) E o novo par é adicionado.
    s = chatReducer(s, { type: 'send_start', clientRequestId: 'r2', question: 'q' });
    expect(s.messages.filter((m) => m.clientRequestId === 'r1').length).toBe(2);
    expect(s.messages.filter((m) => m.clientRequestId === 'r2').length).toBe(2);
  });

  it('mergeServerMessages remove otimistas do MESMO clientRequestId (reconciliação server)', () => {
    const optimistic = [
      { key: 'u-r1', role: 'user', text: 'q', status: 'sent', optimistic: true, clientRequestId: 'r1', createdAt: 't' },
      { key: 'r1', role: 'assistant', text: '', status: 'pending', optimistic: true, clientRequestId: 'r1', createdAt: 't' },
    ] as UiMessage[];
    const server = [
      { key: 'db-user', role: 'user', text: 'q', status: 'sent', optimistic: false, clientRequestId: 'r1', createdAt: 't' },
      { key: 'db-ai', role: 'assistant', text: 'Resposta.', status: 'completed', optimistic: false, clientRequestId: 'r1', createdAt: 't' },
    ] as UiMessage[];
    const merged = mergeServerMessages(optimistic, server);
    expect(merged.filter((m) => m.optimistic)).toHaveLength(0);
    expect(merged.some((m) => m.key === 'db-ai' && m.text === 'Resposta.')).toBe(true);
  });

  it('older_loaded faz prepend sem duplicar (chave/requestId já presentes)', () => {
    let s = createChatState();
    const page1 = [
      { key: 'a1', role: 'assistant', text: 'resposta', status: 'completed', optimistic: false, clientRequestId: 'r1', createdAt: 't' },
    ] as UiMessage[];
    s = chatReducer(s, { type: 'messages_loaded', messages: page1, hasMore: true });
    const older = [
      { key: 'a0', role: 'assistant', text: 'antiga', status: 'completed', optimistic: false, clientRequestId: 'r0', createdAt: 't0' },
      { key: 'a1', role: 'assistant', text: 'duplicada', status: 'completed', optimistic: false, clientRequestId: 'r1', createdAt: 't' },
    ] as UiMessage[];
    s = chatReducer(s, { type: 'older_loaded', messages: older, hasMore: true });
    expect(s.messages.map((m) => m.key)).toEqual(['a0', 'a1']);
    expect(s.messages[0].text).toBe('antiga');
  });

  it('conversations_loaded detecta e limpa a conversa ativa desaparecida', () => {
    let s = createChatState();
    s = chatReducer(s, { type: 'conversations_loaded', conversations: [{ id: 'c1', title: 'T', lastMessageAt: 't' }] });
    s = chatReducer(s, { type: 'select', id: 'c1' });
    s = chatReducer(s, { type: 'messages_loaded', messages: [{ key: 'k', role: 'assistant', text: 'x', status: 'completed', optimistic: false, clientRequestId: null, createdAt: 't' }], hasMore: false });
    s = chatReducer(s, { type: 'conversations_loaded', conversations: [] });
    expect(s.activeId).toBeNull();
    expect(s.messages).toHaveLength(0);
  });

  it('delete_confirm → deleted remove do histórico e limpa a ativa', () => {
    let s = createChatState();
    s = chatReducer(s, { type: 'conversations_loaded', conversations: [{ id: 'c1', title: 'T', lastMessageAt: 't' }] });
    s = chatReducer(s, { type: 'select', id: 'c1' });
    s = chatReducer(s, { type: 'delete_confirm', id: 'c1' });
    expect(s.confirmDeleteId).toBe('c1');
    s = chatReducer(s, { type: 'deleted', id: 'c1' });
    expect(s.conversations).toHaveLength(0);
    expect(s.activeId).toBeNull();
    expect(s.confirmDeleteId).toBeNull();
  });

  it('shouldSendOnEnter envia com Enter, quebra com Shift+Enter', () => {
    expect(shouldSendOnEnter('Enter', false)).toBe(true);
    expect(shouldSendOnEnter('Enter', true)).toBe(false);
    expect(shouldSendOnEnter('A', false)).toBe(false);
  });

  it('uiTitleFor usa a primeira linha e trunca no teto de exibição', () => {
    expect(uiTitleFor('  quanto gastei em maio?  ')).toBe('quanto gastei em maio?');
    const long = 'w'.repeat(200);
    const t = uiTitleFor(long);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(uiTitleFor('')).toBe('Conversa');
    expect(CHAT_PAGE_SIZE).toBe(40);
  });
});

// ── 6. UI: renderToString (reducer puro + contrato C1 preservado) ───────────

describe('PESSOAL-13C2 — FinanceAiSection renderiza o chat inicial', () => {
  it('renderToString produz o layout e mantém o contrato da C1', () => {
    const html = renderToString(
      createElement(FinanceAiSection, { period: APRIL2026 }),
    );
    expect(html).toContain('Pergunte às suas finanças');
    expect(html).toContain('Onde estou gastando mais?');
    expect(html).toContain('Compare com o mês passado');
    expect(html).toContain('Quanto ainda tenho para pagar?');
    expect(html).toContain('Quais são meus maiores gastos?');
    expect(html).toContain('textarea');
    expect(html).toContain('finance-ai-submit');
    expect(html).toContain('aria-label');
    expect(html).toContain('Enter envia');
    expect(html).toContain('Nova conversa');
  });
});

// ── 7. PESSOAL-13C2B.1: contrato tipado do turno (BeginTurnResult) ───────────

describe('PESSOAL-13C2B.1 — BeginTurnResult: narrowing exaustivo sem leitura pela união crua', () => {
  it('fonte do endpoint usa switch exaustivo e NUNCA lê `.conversation` pela união crua', async () => {
    const src = (await import('node:fs')).readFileSync(
      new URL('../../api/finances/ask.ts', import.meta.url),
      'utf8',
    );
    // A variável que guarda a união inteira não pode expor membros de estado.
    expect(src).not.toContain('activeTurn?.conversation');
    expect(src).not.toContain('activeTurn.conversation');
    // O único caminho para `conversation` é o branch 'fresh' do switch —
    // narrowing explícito por discriminante, copiado para freshConversation.
    expect(src).toContain('switch (begun.kind)');
    expect(src).toContain("case 'in_flight':");
    expect(src).toContain("case 'cached':");
    expect(src).toContain("case 'cached_failure':");
    expect(src).toContain("case 'fresh':");
    expect(src).toContain('freshConversation = begun.conversation;');
    // Exaustividade garantida em tempo de compilação (nenhuma asserção insegura).
    expect(src).toContain('const exhaustive: never = begun;');
    // As leituras de uso derivam da snapshot capturada no caso 'fresh', nunca
    // de um membro opcional da união inteira.
    expect(src).toContain('freshConversation?.context');
    expect(src).toContain('freshConversation?.title');
  });

  it('beginChatTurn expõe `conversation` SÓ no estado fresh; demais estados não carregam o membro', async () => {
    const freshClient = setRef(new FakeClient());
    freshClient.state.chat_conversations = [
      { ...CONV, context: { category: 'Supermercado', intent: 'category_total', period: APRIL2026, summaries: [] } },
    ];
    const fresh = await beginChatTurn(freshClient as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'q' });
    expect(fresh.kind).toBe('fresh');
    if (fresh.kind === 'fresh') {
      expect(fresh.conversation.title).toBe('');
      expect(fresh.conversation.context?.category).toBe('Supermercado');
    }

    const cachedClient = setRef(new FakeClient());
    cachedClient.state.chat_conversations = [{ ...CONV }];
    cachedClient.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'completed', client_request_id: 'r1', content: 'ok', payload: { engine: 'gemini' }, period_analyzed: null },
    ];
    const cached = await beginChatTurn(cachedClient as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'x' });
    expect(cached.kind).toBe('cached');
    expect('conversation' in cached).toBe(false);

    const inflightClient = setRef(new FakeClient());
    inflightClient.state.chat_conversations = [{ ...CONV }];
    inflightClient.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1' },
    ];
    const inflight = await beginChatTurn(inflightClient as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'x' });
    expect(inflight.kind).toBe('in_flight');
    expect('conversation' in inflight).toBe(false);

    const failedClient = setRef(new FakeClient());
    failedClient.state.chat_conversations = [{ ...CONV }];
    failedClient.state.chat_messages = [
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'failed', client_request_id: 'r1', content: '', error: 'Serviço indisponível.' },
    ];
    const failed = await beginChatTurn(failedClient as never, { conversationId: 'conv-1', clientRequestId: 'r1', question: 'x' });
    expect(failed.kind).toBe('cached_failure');
    expect('conversation' in failed).toBe(false);
  });

  it('endpoint aplica o contexto capturado no estado fresh (conversation sem acesso pré-narrowing)', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([
      { transaction_kind: 'expense', amount: 90, occurred_on: '2026-05-08', deleted_at: null, categories: SUP },
    ]);
    c.state.categories = [...SUP_CATS];
    c.state.chat_conversations = [
      { ...CONV, context: { category: 'Supermercado', intent: 'category_total', period: APRIL2026, summaries: [] } },
    ];
    c.state.chat_messages = [];
    authOk(c);
    const res = await handler(
      postRequest({
        question: 'E em maio?',
        period: { start: '2026-05-01', end: '2026-05-31' },
        conversationId: 'conv-1',
        clientRequestId: 'r1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(90));
    expect(body.answer).toMatch(/supermercado/i);
  });

  it('reenvio com cache reproduz o geminiCallCount — zero chamada Gemini duplicada (idempotência intacta)', async () => {
    let geminiCalls = 0;
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiCalls += 1;
        return { text: 'investimento', functionCalls: [] };
      },
    });
    const c = withChat({ ...CONV }, []);
    authOk(c);
    const body1 = { question: 'Devo investir mais?', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' };
    const res1 = await handler(postRequest(body1));
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as { engine?: string; geminiCallCount?: number };
    expect(b1.engine).toBe('gemini');
    expect(geminiCalls).toBe(1);

    authOk(c);
    const res2 = await handler(postRequest(body1));
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { engine?: 'gemini' | 'deterministic'; geminiCallCount?: number };
    // Cache reconstitui o payload anterior; o Gemini NÃO é chamado de novo.
    expect(geminiCalls).toBe(1);
    expect(b2.engine).toBe('gemini');
    expect(b2.geminiCallCount).toBe(b1.geminiCallCount ?? 0);
  });
});

// ── 8. PESSOAL-13C2B.3: idempotência user+assistant por client_request_id ───

describe('PESSOAL-13C2B.3 — índice único triplo (conversation_id, client_request_id, role)', () => {
  it('chatStore upserta a mensagem user com alvo de conflito TRIPLO e role user (nunca o alvo antigo de 2 colunas)', async () => {
    const src = (await import('node:fs')).readFileSync(
      new URL('../../server/chat/chatStore.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("onConflict: 'conversation_id,client_request_id,role'");
    // O alvo antigo do 023 (sem role) precisa ter desaparecido do upsert.
    expect(src).not.toContain("onConflict: 'conversation_id,client_request_id',");
    expect(src).toContain("role: 'user',");
  });

  it('migration 026 define o índice UNIQUE com as 3 colunas e remove o índice antigo de 2 colunas', async () => {
    const migrationSql = (await import('node:fs')).readFileSync(
      new URL('../../../supabase/migrations/026_chat_message_idempotency_role.sql', import.meta.url),
      'utf8',
    );
    expect(migrationSql).toContain('uq_chat_messages_conversation_client_request_role');
    expect(migrationSql).toContain('(conversation_id, client_request_id, role)');
    expect(migrationSql).toContain('DROP INDEX IF EXISTS public.uq_chat_messages_conversation_client_request');
  });

  it('FakeClient reproduz a unicidade FINAL: user+assistant do MESMO crid coexistem, duplicata da MESMA role é 23505, e a regra antiga de 2 colunas teria conflitado', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    const rUser = (await c.from('chat_messages').insert({
      id: 'u1', conversation_id: 'conv-1', client_request_id: 'r1', role: 'user', status: 'completed', content: 'q',
    })) as { error: unknown };
    expect(rUser.error).toBeNull();
    const rAnchor = (await c.from('chat_messages').insert({
      id: 'a1', conversation_id: 'conv-1', client_request_id: 'r1', role: 'assistant', status: 'pending', content: '',
    })) as { error: unknown };
    expect(rAnchor.error).toBeNull();
    expect(c.state.chat_messages).toHaveLength(2);

    // Reenvio da user com ignoreDuplicates → nenhuma duplicata, nada lançado.
    const re = (await c.from('chat_messages').upsert(
      { id: 'u1', conversation_id: 'conv-1', client_request_id: 'r1', role: 'user', status: 'completed', content: 'q' },
      { onConflict: 'conversation_id,client_request_id,role', ignoreDuplicates: true },
    )) as { error: unknown };
    expect(re.error).toBeNull();
    expect(c.state.chat_messages.filter((m) => m.role === 'user' && m.client_request_id === 'r1')).toHaveLength(1);

    // Duplicata da MESMA role (segunda âncora assistant idêntica) → exatamente 23505.
    const dupSameRole = (await c.from('chat_messages').insert({
      id: 'a2', conversation_id: 'conv-1', client_request_id: 'r1', role: 'assistant', status: 'pending', content: '',
    })) as { error?: { code: string } };
    expect(dupSameRole.error?.code).toBe('23505');

    // Regra antiga (023, SEM role): a MESMA combinação conv+crid que o turno
    // precisa gravar como user+assistant era um conflito — o bug de 502 que o
    // índice triplo e o onConflict triplo corrigem. Este teste falha se o
    // alvo de conflito voltar a ignorar a role.
    const oldTwoCol = (await c.from('chat_messages').upsert(
      { id: 'a1', conversation_id: 'conv-1', client_request_id: 'r1', role: 'assistant', status: 'pending', content: '' },
      { onConflict: 'conversation_id,client_request_id' },
    )) as { error?: { code: string } };
    expect(oldTwoCol.error?.code).toBe('23505');
  });

  it('primeira pergunta persiste EXATAMENTE 1 user + 1 assistant (mesmo crid), determinístico com GeminiCallCount=0', async () => {
    registerGeminiClient(neverGemini());
    const c = detRows([
      { transaction_kind: 'expense', amount: 90, occurred_on: '2026-05-08', deleted_at: null, categories: SUP },
    ]);
    c.state.categories = [...SUP_CATS];
    c.state.chat_conversations = [
      { ...CONV, context: { category: 'Supermercado', intent: 'category_total', period: APRIL2026, summaries: [] } },
    ];
    c.state.chat_messages = [];
    authOk(c);
    const res = await handler(
      postRequest({
        question: 'E em maio?',
        period: { start: '2026-05-01', end: '2026-05-31' },
        conversationId: 'conv-1',
        clientRequestId: 'r1',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; geminiCallCount?: number };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(c.state.chat_messages).toHaveLength(2);
    expect(c.state.chat_messages.filter((m) => m.role === 'user' && m.client_request_id === 'r1')).toHaveLength(1);
    expect(c.state.chat_messages.filter((m) => m.role === 'assistant' && m.client_request_id === 'r1')).toHaveLength(1);
  });

  it('reenvio durante pending → 409/in_flight, nada duplicado no store', async () => {
    const c = withChat({ ...CONV }, [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1', content: 'q' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', client_request_id: 'r1', content: '' },
    ]);
    authOk(c);
    const res = await handler(postRequest({ question: 'q2', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('in_flight');
    expect(c.state.chat_messages).toHaveLength(2);
  });

  it('reenvio após completed → cache determinístico (GeminiCallCount=0), sem nova consulta/Gemini nem linha nova', async () => {
    registerGeminiClient(neverGemini());
    const c = withChat({ ...CONV }, [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', client_request_id: 'r1', content: 'q' },
      {
        id: 'a1',
        conversation_id: 'conv-1',
        role: 'assistant',
        status: 'completed',
        client_request_id: 'r1',
        content: 'ok',
        payload: { engine: 'deterministic', geminiCallCount: 0 },
      },
    ]);
    authOk(c);
    const res = await handler(postRequest({ question: 'q', period: APRIL2026, conversationId: 'conv-1', clientRequestId: 'r1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; geminiCallCount?: number; answer?: string };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(body.answer).toBe('ok');
    expect(c.state.chat_messages).toHaveLength(2);
  });
});