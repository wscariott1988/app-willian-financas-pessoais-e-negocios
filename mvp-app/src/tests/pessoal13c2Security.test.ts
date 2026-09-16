// pessoal13c2Security.test.ts — PESSOAL-13C2A.1: segurança e verificação do
// chat persistente.
//
// Prova que:
//   1. profileIdentity (server): regra canônica FAIL-CLOSED — em produção só
//      app_metadata.profile_id (uuid válido); user_metadata (editável pelo
//      usuário) é REJEITADO; identidade ausente → null, nunca perfil padrão;
//   2. /api/finances/ask: sem perfil confiável → 403 `profile_not_identified`
//      (prod); user_metadata forjado NÃO vira perfil em produção; o
//      profile_id do body é IGNORADO (identidade vem do usuário autenticado);
//   3. idempotência sob concorrência real: uma resposta só por clientRequestId
//      (uma linha user + uma assistant + UMA consulta a dados), mesmo com dois
//      handlers concorrentes e âncora pendente (sem Gemini duplicado);
//   4. chatStore trunca content no teto (CHAT_CONTENT_MAX_CHARS);
//   5. auditoria estática dos SQLs: 023 (grants/políticas/tetos), VERIFY
//      (comportamental BEGIN/ROLLBACK com claims + SET LOCAL ROLE), PREFLIGHT
//      read-only, ROLLBACK_TEST_ONLY (recusa defensiva) — sem DML persistente,
//      sem secrets, sem impressão de dados do usuário.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

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
  profileIdFromAuthUser,
  isProdServerEnv,
} from '../../server/auth/profileIdentity';
import { beginChatTurn, completeChatTurn } from '../../server/chat/chatStore';
import { CHAT_CONTENT_MAX_CHARS } from '../../server/chat/chatTypes';

const JSON_HEADERS = { 'content-type': 'application/json' };

// ── Fixtures determinísticas (mesma estrutura da suíte C2A) ────────────────

const SUP = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado', direction: 'expense' };
const SUP_CATS = [SUP];
const APRIL2026 = { start: '2026-04-01', end: '2026-04-30' };
const UUID_APP = '00000000-0000-4000-8000-0000000000aa';
const UUID_FORGED = '00000000-0000-4000-8000-0000000000bb';
const UUID_BODY = '00000000-0000-4000-8000-0000000000cc';
const CONV = {
  id: 'conv-1',
  profile_id: UUID_APP,
  title: '',
  context: null,
  created_at: '',
  updated_at: '',
  last_message_at: '',
};

// ── Fake Supabase com gate de concorrência ─────────────────────────────────

type Row = Record<string, any>;

interface Filter {
  op: 'is' | 'eq' | 'gte' | 'lte';
  key: string;
  value: unknown;
}

interface BuilderState {
  table: string;
  filters: Filter[];
  orders: Array<{ key: string; asc: boolean }>;
  fromRange: number;
  toRange: number;
  maybe: boolean;
  single: boolean;
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
  calls: Array<{ table: string; action: string; filters: string[] }> = [];
  gateEnabled = false;
  private insertGate: Array<() => void> = [];

  async gateChatMessagesInsert(): Promise<void> {
    if (!this.gateEnabled) return;
    await new Promise<void>((resolve) => {
      this.insertGate.push(resolve);
      if (this.insertGate.length >= 2) {
        const pending = this.insertGate;
        this.insertGate = [];
        for (const r of pending) r();
      }
    });
  }

  from(table: string): Record<string, any> {
    const self = this;
    const b: BuilderState = {
      table,
      filters: [],
      orders: [],
      fromRange: 0,
      toRange: Number.POSITIVE_INFINITY,
      maybe: false,
      single: false,
      action: 'select',
      rows: [],
      patch: {},
      onConflict: 'id',
      ignoreDuplicates: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: Record<string, any> = {
      select() {
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
        self.calls.push({ table, action: b.action, filters: b.filters.map((f) => `${f.op}:${f.key}`) });
        return Promise.resolve(execute(b)).then(resolve);
      },
    };
    return base;
  }
}

function matchesFilter(row: Row, f: Filter): boolean {
  const v = row[f.key];
  if (f.op === 'is') return f.value === null ? v === null : v === f.value;
  if (f.op === 'eq') return v === f.value;
  if (f.op === 'gte') return typeof v === 'string' ? v >= (f.value as string) : v >= (f.value as number);
  if (f.op === 'lte') return typeof v === 'string' ? v <= (f.value as string) : v <= (f.value as number);
  return false;
}

let clientRef: FakeClient | null = null;
function setRef(c: FakeClient): FakeClient {
  clientRef = c;
  return c;
}
function rowsOf(b: BuilderState): Row[] {
  return (clientRef as FakeClient).state[b.table];
}

function uniqViolation(): Error & { code: string } {
  const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  e.code = '23505';
  return e;
}

async function execute(b: BuilderState): Promise<{ data: unknown; count: number | null; error: unknown }> {
  if (b.action === 'upsert') {
    const keySet = b.onConflict.split(',');
    for (const row of b.rows) {
      const dup = rowsOf(b).some((r) => keySet.every((k) => r[k] === row[k]));
      if (dup && !b.ignoreDuplicates) return { data: null, count: null, error: uniqViolation() };
      if (!dup) rowsOf(b).push(row);
    }
    return { data: null, count: null, error: null };
  }

  if (b.action === 'insert') {
    // Gate: em teste de concorrência, ambos os handlers esperam até 2 inserts
    // chegarem antes de qualquer um prosseguir (simula o 23505 real).
    await (clientRef as FakeClient).gateChatMessagesInsert();
    for (const row of b.rows) {
      if (
        b.table === 'chat_messages' &&
        rowsOf(b).some(
          (r) =>
            r.conversation_id === row.conversation_id &&
            r.client_request_id === row.client_request_id &&
            r.role === row.role,
        )
      ) {
        return { data: null, count: null, error: uniqViolation() };
      }
      rowsOf(b).push(row);
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
    (clientRef as FakeClient).state[b.table] = rowsOf(b).filter((r) => !selected.includes(r));
    return { data: null, count: null, error: null };
  }

  const page = selected.slice(b.fromRange, b.toRange + 1);
  if (b.maybe || b.single) return { data: page[0] ?? null, count: null, error: null };
  return { data: page, count: null, error: null };
}

// ── Helpers de requisição/autenticação ─────────────────────────────────────

interface FakeAuthUser {
  id?: string;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

function authOk(user: FakeAuthUser | null): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValue({
    client: clientRef as never,
    userId: 'u-server-0000-0000-0000-000000000000',
    user,
  } as never);
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

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  clientRef = null;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.NODE_ENV;
});

// ── 1. profileIdentity (server): regra canônica FAIL-CLOSED ────────────────

describe('PESSOAL-13C2A.1 — profileIdentity (server)', () => {
  it('app_metadata.profile_id (uuid válido) é a identidade em qualquer ambiente', () => {
    expect(
      profileIdFromAuthUser({ app_metadata: { profile_id: UUID_APP } }, { allowLegacy: false }),
    ).toBe(UUID_APP);
    expect(
      profileIdFromAuthUser({ app_metadata: { profile_id: UUID_APP } }, { allowLegacy: true }),
    ).toBe(UUID_APP);
  });

  it('user_metadata (editável pelo usuário) é REJEITADO em produção; aceito só fora dela', () => {
    const user = { user_metadata: { profile_id: UUID_FORGED } };
    expect(profileIdFromAuthUser(user, { allowLegacy: false })).toBeNull();
    expect(profileIdFromAuthUser(user, { allowLegacy: true })).toBe(UUID_FORGED);
  });

  it('identidade ausente, não-uuid ou inválida → null (nunca um perfil padrão)', () => {
    expect(profileIdFromAuthUser(null, { allowLegacy: true })).toBeNull();
    expect(profileIdFromAuthUser({}, { allowLegacy: true })).toBeNull();
    expect(profileIdFromAuthUser({ app_metadata: { profile_id: 123 } }, { allowLegacy: false })).toBeNull();
    expect(profileIdFromAuthUser({ app_metadata: { profile_id: 'nao-e-uuid' } }, { allowLegacy: false })).toBeNull();
    expect(profileIdFromAuthUser({ user_metadata: { profile_id: 'nao-e-uuid' } }, { allowLegacy: true })).toBeNull();
    // Perfil válido do app vence mesmo com user_metadata forjado presente.
    expect(
      profileIdFromAuthUser(
        { app_metadata: { profile_id: UUID_APP }, user_metadata: { profile_id: UUID_FORGED } },
        { allowLegacy: true },
      ),
    ).toBe(UUID_APP);
  });

  it('isProdServerEnv: Vercel/branch-vercel/produção → estrito; local dev → flexível', () => {
    expect(isProdServerEnv({ VERCEL: '1' })).toBe(true);
    expect(isProdServerEnv({ VERCEL_ENV: 'production' })).toBe(true);
    expect(isProdServerEnv({ NODE_ENV: 'production' })).toBe(true);
    expect(isProdServerEnv({ VERCEL: '0', VERCEL_ENV: 'preview', NODE_ENV: 'development' })).toBe(false);
    expect(isProdServerEnv({ VERCEL: '0', NODE_ENV: 'test' })).toBe(false);
    expect(isProdServerEnv({})).toBe(false);
  });
});

// ── 2. Endpoint: fail-closed da identidade + body profile_id ignorado ──────

describe('PESSOAL-13C2A.1 — endpoint fail-closed', () => {
  it('perfil ausente em produção → 403 profile_not_identified (sem Gemini, sem dados)', async () => {
    process.env.VERCEL = '1';
    registerGeminiClient(neverGemini());
    const c = setRef(new FakeClient());
    c.state.transactions = [{ transaction_kind: 'expense', amount: 10, occurred_on: '2026-04-05', deleted_at: null, categories: SUP }];
    c.state.categories = [...SUP_CATS];
    authOk({ id: 'u-1', app_metadata: {}, user_metadata: {} });
    const res = await handler(postRequest({ question: 'Quanto gastei em abril?' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('profile_not_identified');
    expect(c.calls).toHaveLength(0);
  });

  it('mesmo com user_metadata forjado, produção recusa (403) — fallback só em dev', async () => {
    process.env.VERCEL = '1';
    registerGeminiClient(neverGemini());
    const c = setRef(new FakeClient());
    authOk({ id: 'u-1', app_metadata: {}, user_metadata: { profile_id: UUID_FORGED } });
    const forged = await handler(postRequest({ question: 'q' }));
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { error: string }).error).toBe('profile_not_identified');

    // Fora de produção o fallback legado vale (gateway local da fase 4B) — mas
    // NUNCA em runtime Vercel (NODE_ENV=production lá).
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    c.state.transactions = [{ transaction_kind: 'expense', amount: 9, occurred_on: '2026-04-05', deleted_at: null, categories: SUP }];
    c.state.categories = [...SUP_CATS];
    authOk({ id: 'u-1', app_metadata: {}, user_metadata: { profile_id: UUID_FORGED } });
    const res = await handler(postRequest({ question: 'Quanto gastei em abril?' }));
    expect(res.status).toBe(200);
  });

  it('produção com app_metadata.profile_id válido → segue o fluxo (200)', async () => {
    process.env.VERCEL = '1';
    registerGeminiClient(neverGemini());
    const c = setRef(new FakeClient());
    c.state.transactions = [{ transaction_kind: 'expense', amount: 15, occurred_on: '2026-04-06', deleted_at: null, categories: SUP }];
    c.state.categories = [...SUP_CATS];
    authOk({ id: 'u-1', app_metadata: { profile_id: UUID_APP } });
    const res = await handler(postRequest({ question: 'Quanto gastei em abril?' }));
    expect(res.status).toBe(200);
  });

  it('profile_id do body é IGNORADO: identidade vem do usuário autenticado', async () => {
    registerGeminiClient(neverGemini());
    const c = setRef(new FakeClient());
    c.state.transactions = [{ transaction_kind: 'expense', amount: 120, occurred_on: '2026-04-06', deleted_at: null, categories: SUP }];
    c.state.categories = [...SUP_CATS];
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [];
    authOk({ id: 'u-1', app_metadata: { profile_id: UUID_APP }, user_metadata: {} });
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em supermercado em abril?',
        period: APRIL2026,
        conversationId: 'conv-1',
        clientRequestId: 'r1',
        profile_id: UUID_BODY,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; engine?: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(120));
    // Nenhuma consulta, linha ou atualização com o profile_id do body.
    expect(JSON.stringify(c.calls)).not.toContain(UUID_BODY);
    expect(JSON.stringify(c.state)).not.toContain(UUID_BODY);
    expect(c.state.chat_conversations[0].profile_id).toBe(UUID_APP);
  });
});

// ── 3. Concorrência real: uma resposta por clientRequestId ─────────────────

describe('PESSOAL-13C2A.1 — idempotência sob concorrência real', () => {
  it('um 200 (vencedor) + outro bloqueado (in_flight/cache), 1 consulta a dados, 1 linha por papel', async () => {
    registerGeminiClient(neverGemini());
    const c = setRef(new FakeClient());
    c.gateEnabled = true;
    c.state.transactions = [{ transaction_kind: 'expense', amount: 42, occurred_on: '2026-04-06', deleted_at: null, categories: SUP }];
    c.state.categories = [...SUP_CATS];
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [];
    authOk({ id: 'u-1', app_metadata: { profile_id: UUID_APP } });

    const body = {
      question: 'Quanto gastei em supermercado em abril?',
      period: APRIL2026,
      conversationId: 'conv-1',
      clientRequestId: 'r-x',
    };
    const [r1, r2] = await Promise.all([handler(postRequest(body)), handler(postRequest(body))]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);

    // Apenas UMA consulta a dados financeiros (o perdedor não consulta nada).
    const txQueries = c.calls.filter((x) => x.table === 'transactions').length;
    expect(txQueries).toBe(1);

    // Uma linha user + uma linha assistant por clientRequestId (nunca duplicado).
    const assistantRows = c.state.chat_messages.filter((m) => m.role === 'assistant' && m.client_request_id === 'r-x');
    const userRows = c.state.chat_messages.filter((m) => m.role === 'user' && m.client_request_id === 'r-x');
    expect(assistantRows).toHaveLength(1);
    expect(userRows).toHaveLength(1);
    expect(assistantRows[0].status).toBe('completed');
  });
});

// ── 4. chatStore: teto de conteúdo ─────────────────────────────────────────

describe('PESSOAL-13C2A.1 — tetos de storage', () => {
  it('completeChatTurn trunca a resposta no teto (nunca estoura o CHECK)', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    c.state.chat_messages = [
      { id: 'u1', conversation_id: 'conv-1', role: 'user', status: 'completed', content: 'q', client_request_id: 'r1' },
      { id: 'a1', conversation_id: 'conv-1', role: 'assistant', status: 'pending', content: '', client_request_id: 'r1' },
    ];
    const huge = 'Z'.repeat(CHAT_CONTENT_MAX_CHARS + 5000);
    await completeChatTurn(c as never, {
      conversationId: 'conv-1',
      clientRequestId: 'r1',
      answer: huge,
      payload: { engine: 'deterministic', geminiCallCount: 0, toolsUsed: [] },
      intent: 'category_total',
      engine: 'deterministic',
      periodAnalyzed: null,
      context: { category: null, intent: null, period: null, summaries: [] },
      setTitle: false,
      title: 'Conversa',
    });
    const anchor = c.state.chat_messages.find((m) => m.role === 'assistant' && m.client_request_id === 'r1');
    expect(anchor?.content.length).toBeLessThanOrEqual(CHAT_CONTENT_MAX_CHARS);
    expect(anchor?.content).toBe(huge.slice(0, CHAT_CONTENT_MAX_CHARS));
  });

  it('beginChatTurn grava a pergunta do user (teto do schema aplicado no ask) e âncora vazia', async () => {
    const c = setRef(new FakeClient());
    c.state.chat_conversations = [{ ...CONV }];
    const res = await beginChatTurn(c as never, {
      conversationId: 'conv-1',
      clientRequestId: 'r1',
      question: 'Quanto gastei?',
    });
    expect(res.kind).toBe('fresh');
    const msgs = c.state.chat_messages;
    expect(msgs).toHaveLength(2);
    expect(msgs.find((m) => m.role === 'user')?.content).toBe('Quanto gastei?');
    expect(msgs.find((m) => m.role === 'assistant')?.status).toBe('pending');
  });
});

// ── 5. Auditoria estática dos artefatos SQL ────────────────────────────────

function sqlAt(rel: string): string {
  return readFileSync(new URL(`../../../supabase/cloud/${rel}`, import.meta.url), 'utf8');
}

const MIGRATION_023 = readFileSync(new URL('../../../supabase/migrations/023_chat_persistence.sql', import.meta.url), 'utf8');

describe('PESSOAL-13C2A.1 — auditoria dos SQLs', () => {
  it('023: grants só authenticated, sem DELETE de mensagens, RLS habilitada, políticas e tetos', () => {
    expect(MIGRATION_023).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations TO authenticated;');
    expect(MIGRATION_023).toContain('GRANT SELECT, INSERT, UPDATE ON chat_messages TO authenticated;');
    expect(MIGRATION_023).not.toContain('TO anon');
    expect(MIGRATION_023).not.toMatch(/GRANT[\s\S]*service_role/i);
    expect(MIGRATION_023).toContain('ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;');
    expect(MIGRATION_023).toContain('ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;');
    for (const name of ['chat_conversations_select_own', 'chat_conversations_insert_own', 'chat_conversations_update_own', 'chat_conversations_delete_own', 'chat_messages_select_own', 'chat_messages_insert_own', 'chat_messages_update_own', 'chat_messages_delete_own']) {
      expect(MIGRATION_023).toContain(name);
    }
    expect(MIGRATION_023).toContain('chat_conversations_context_size');
    expect(MIGRATION_023).toContain('chat_messages_payload_size');
    // Idempotência: chave única (conversation_id, client_request_id).
    expect(MIGRATION_023).toContain('uq_chat_messages_conversation_client_request');
  });

  it('VERIFY: Verificação comportamental em BEGIN/ROLLBACK com claims e SET LOCAL ROLE authenticated', () => {
    const v = sqlAt('VERIFY_POST_CLOUD_023_CHAT_RLS_READONLY.sql');
    expect(v).toContain('BEGIN;');
    expect(v).toContain('ROLLBACK;');
    expect(v).toContain('SET LOCAL ROLE authenticated');
    expect(v).toContain('set_config(');
    expect(v).toContain('request.jwt.claims');
    expect(v).toContain('to_regprocedure(');
    expect(v).toContain('has_table_privilege');
    // Sem DDL/DML persistente nem privilégios.
    expect(v).not.toContain('INSERT INTO public.profiles');
    expect(v).not.toContain('GRANT ');
    expect(v).not.toContain('DROP ');
    expect(v).not.toContain('service_role');
    expect(v).not.toContain('GEMINI_API_KEY');
  });

  it('VERIFY: nunca invoca helpers app.jwt_* sob authenticated/anon (regressão PESSOAL-13C2A.2 — 42501)', () => {
    const v = sqlAt('VERIFY_POST_CLOUD_023_CHAT_RLS_READONLY.sql');
    // Na Parte A (e na guarda da Parte B) os helpers só aparecem no CATÁLOGO
    // (to_regprocedure), na sessão administrativa, antes de qualquer troca de
    // role — isso é permitido. A REGRA é: DEPOIS do primeiro SET LOCAL ROLE
    // (authenticated/anon) NENHUMA referência app.jwt_* pode existir: chamar
    // o helper diretamente sob esses papeis exigiria USAGE no schema app →
    // 42501. A RLS é provada pelo comportamento das tabelas, e os helpers são
    // exercidos apenas pela própria política (como em produção).
    const beginIdx = v.indexOf('BEGIN;');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    const roleSwitchIdx = v.indexOf('SET LOCAL ROLE authenticated;', beginIdx);
    expect(roleSwitchIdx).toBeGreaterThan(beginIdx);
    const sobRoleSimulada = v.slice(roleSwitchIdx);
    expect(sobRoleSimulada).not.toMatch(/app\.jwt_(profile_id|role|sub)/);
  });

  it('PREFLIGHT: leitura pura, apenas catálogo (sem DDL/DML/grants)', () => {
    const p = sqlAt('PREFLIGHT_CLOUD_023_CHAT_RLS_READONLY.sql');
    expect(p).toContain('SELECT');
    expect(p).not.toContain('DROP ');
    expect(p).not.toContain('INSERT INTO');
    expect(p).not.toContain('GRANT ');
    expect(p).toContain("to_regprocedure('app.jwt_profile_id()')");
    expect(p).not.toContain('GEMINI_API_KEY');
  });

  it('ROLLBACK_TEST_ONLY: recusa defensiva, termina em ROLLBACK, sem COMMIT', () => {
    const r = sqlAt('ROLLBACK_TEST_ONLY_023_CHAT_PERSISTENCE.sql');
    expect(r).toContain('ROLLBACK;');
    expect(r).toContain('DROP TABLE public.chat_messages;');
    expect(r).toContain('DROP TABLE public.chat_conversations;');
    expect(r).toContain('RAISE EXCEPTION');
    expect(r).toContain('DROP POLICY IF EXISTS');
    expect(r).not.toContain('COMMIT;');
    expect(r).not.toContain('service_role');
    expect(r).not.toContain('GEMINI_API_KEY');
  });

  it('nenhum dos scripts exige service_role nem transporta secrets', () => {
    for (const rel of ['VERIFY_POST_CLOUD_023_CHAT_RLS_READONLY.sql', 'PREFLIGHT_CLOUD_023_CHAT_RLS_READONLY.sql', 'ROLLBACK_TEST_ONLY_023_CHAT_PERSISTENCE.sql']) {
      expect(sqlAt(rel)).not.toContain('service_role');
    }
  });
});