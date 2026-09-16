// pessoal13b3bObservability.test.ts — PESSOAL-13B3.3: observabilidade
// estruturada e sanitizada de /api/finances/ask.
//
// Prova que:
//   1. a classificação por stage/categoria é correta;
//   2. status conhecidos (400, 401/403, 404, 429, timeout) mapeiam corretamente;
//   3. Gemini, Supabase e ferramentas são diferenciados;
//   4. nenhum dado sensível chega ao evento/log final, mesmo quando o erro
//      artificial contém chave, JWT, UUID, email, pergunta e valores em reais.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// server/supabaseServer é totalmente mockado (mesmo padrão do endpoint test).
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

import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient, AuthTokenError } from '../../server/supabaseServer';
import {
  registerGeminiClient,
  mockGeminiClient,
} from '../../server/finance-ai/geminiClient';
import {
  setSanitizedEventSink,
  classifyGeminiClientError,
  isSupabaseQueryError,
  isAbortLikeError,
  OBSERVABILITY_FIELDS,
  type SanitizedFailureEvent,
} from '../../server/finance-ai/observability';
import type { GeminiClient, GeminiMessage, GeminiResponse } from '../../server/finance-ai/types';

const JSON_HEADERS = { 'content-type': 'application/json' };

function postRequest(body: unknown, token = 'token-valido'): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function asError(err: unknown, name: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  e.name = name;
  return e;
}

function okClient(): unknown {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'gte', 'lte', 'order', 'ilike', 'limit'] as const) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return { from: () => chain };
}

function failingSupabase(err: unknown): unknown {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'gte', 'lte', 'order', 'ilike', 'limit'] as const) {
    chain[m] = () => chain;
  }
  chain.then = (_resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => reject(err);
  return { from: () => chain };
}

function authOk(fakeClient: unknown): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: fakeClient as never,
    userId: 'user-test-0000-0000-0000-000000000000',
    user: null,
  });
}

async function run(body: unknown, token = 'token-valido'): Promise<Response> {
  return handler(postRequest(body, token));
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  setSanitizedEventSink(null);
});

afterEach(() => {
  setSanitizedEventSink(null);
});

// ── Classificação pura (classifyGeminiClientError) ─────────────

describe('PESSOAL-13B3.3 — Classificador: status e códigos', () => {
  it('400 INVALID_ARGUMENT → gemini_bad_request', () => {
    const c = classifyGeminiClientError(new Error('INVALID_ARGUMENT: tool schema invalid'));
    expect(c.category).toBe('gemini_bad_request');
    expect(c.providerCode).toBe('INVALID_ARGUMENT');
    expect(c.retryable).toBe(false);
  });

  it('400 "API key not valid" → gemini_api_key_invalid', () => {
    const err = asError(new Error('API key not valid. Please pass a valid API key.'), 'Error');
    (err as { status?: unknown }).status = 400;
    const c = classifyGeminiClientError(err);
    expect(c.category).toBe('gemini_api_key_invalid');
    expect(c.providerCode).toBe('API_KEY_INVALID');
    expect(c.retryable).toBe(false);
  });

  it('401 → gemini_api_key_invalid (UNAUTHENTICATED)', () => {
    const err = asError(new Error('permission required'), 'Error');
    (err as { status?: unknown }).status = 401;
    const c = classifyGeminiClientError(err);
    expect(c.category).toBe('gemini_api_key_invalid');
    expect(c.providerCode).toBe('UNAUTHENTICATED');
  });

  it('403 PERMISSION_DENIED → gemini_permission_denied', () => {
    const c = classifyGeminiClientError(
      asError(new Error('PERMISSION_DENIED: caller has no permission'), 'Error'),
    );
    expect(c.category).toBe('gemini_permission_denied');
    expect(c.providerCode).toBe('PERMISSION_DENIED');
    expect(c.retryable).toBe(false);
  });

  it('403 "API not enabled" → gemini_api_not_enabled', () => {
    const c = classifyGeminiClientError(
      asError(new Error('API not enabled for this project. Enable the Gemini API.'), 'Error'),
    );
    expect(c.category).toBe('gemini_api_not_enabled');
    expect(c.providerCode).toBe('API_DISABLED');
    expect(c.retryable).toBe(false);
  });

  it('404 MODEL_NOT_FOUND → gemini_model_not_found', () => {
    const c = classifyGeminiClientError(
      asError(new Error('404 MODEL_NOT_FOUND: model not found'), 'Error'),
    );
    expect(c.category).toBe('gemini_model_not_found');
    expect(c.providerCode).toBe('MODEL_NOT_FOUND');
    expect(c.retryable).toBe(false);
  });

  it('429 RESOURCE_EXHAUSTED → gemini_rate_limited', () => {
    const c = classifyGeminiClientError(
      asError(new Error('RESOURCE_EXHAUSTED: 429 Quota exceeded for the project'), 'Error'),
    );
    expect(c.category).toBe('gemini_rate_limited');
    expect(c.providerCode).toBe('RESOURCE_EXHAUSTED');
    expect(c.retryable).toBe(true);
  });

  it('AbortError name → gemini_timeout (retryable)', () => {
    const c = classifyGeminiClientError(
      asError(new Error('This operation was aborted'), 'AbortError'),
    );
    expect(c.category).toBe('gemini_timeout');
    expect(c.providerCode).toBe('ABORTED');
    expect(c.retryable).toBe(true);
  });

  it('DEADLINE_EXCEEDED token → gemini_timeout (retryable)', () => {
    const c = classifyGeminiClientError(
      asError(new Error('DEADLINE_EXCEEDED: request timed out'), 'Error'),
    );
    expect(c.category).toBe('gemini_timeout');
    expect(c.providerCode).toBe('DEADLINE_EXCEEDED');
    expect(c.retryable).toBe(true);
  });

  it('falha de parsing → response_parse_error', () => {
    const c = classifyGeminiClientError(
      asError(new Error('Is not valid JSON: unexpected token at 3:5'), 'Error'),
    );
    expect(c.category).toBe('response_parse_error');
    expect(c.retryable).toBe(false);
  });

  it('status textual do allowlist (RESOURCE_EXHAUSTED) → gemini_rate_limited', () => {
    const c = classifyGeminiClientError({ status: 'RESOURCE_EXHAUSTED' });
    expect(c.category).toBe('gemini_rate_limited');
    expect(c.providerCode).toBe('RESOURCE_EXHAUSTED');
    expect(c.retryable).toBe(true);
  });

  it('erro sem sinal conhecido → unknown_upstream (sem vazamento)', () => {
    const c = classifyGeminiClientError(
      asError(new Error('connection refused: obscure internal tunnel detail'), 'Error'),
    );
    expect(c.category).toBe('unknown_upstream');
    expect(c.providerCode).toBeUndefined();
    expect(c.retryable).toBe(false);
  });

  it('detectores auxiliares: PostgrestError e AbortError', () => {
    expect(
      isSupabaseQueryError({ name: 'PostgrestError', message: 'x', details: '', hint: '' }),
    ).toBe(true);
    expect(isSupabaseQueryError(new Error('boom'))).toBe(false);
    expect(isAbortLikeError(asError(new Error('abort'), 'AbortError'))).toBe(true);
    expect(isAbortLikeError(new Error('boom'))).toBe(false);
  });
});

// ── Evento sanitizado na integração (endpoint real) ────────────

describe('PESSOAL-13B3.3 — Endpoint: resumo autenticado com sucesso NÃO registra evento', () => {
  it('200 com mock → sink vazio (nenhum conteúdo financeiro no log)', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    registerGeminiClient(mockGeminiClient());
    const res = await run({ question: 'Quanto gastei em agosto de 2026? R$ 1.234,56' });
    expect(res.status).toBe(200);
    expect(captured).toEqual([]);
  });

  it('200 com tool executando e valores financeiros → sink vazio', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    let turn = 0;
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'financial_summary', args: { start: '2026-08-01', end: '2026-08-31' } },
            ],
          };
        }
        return { text: 'Você gastou R$ 8.123,45 em agosto.', functionCalls: [] };
      },
    };
    registerGeminiClient(gemini);
    const res = await run({ question: 'Quanto gastei em agosto de 2026? (R$ 8.123,45 no banco)' });
    expect(res.status).toBe(200);
    expect(captured).toEqual([]);
  });
});

describe('PESSOAL-13B3.3 — Endpoint: autenticação', () => {
  it('AuthTokenError → 401 e evento stage=auth / category=supabase_auth_error', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    vi.mocked(createUserSupabaseClient).mockRejectedValueOnce(
      new AuthTokenError(),
    );
    const res = await run({ question: 'Oi' }, 'token-invalido-sensivel');
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe('ask_failure');
    expect(captured[0].stage).toBe('auth');
    expect(captured[0].category).toBe('supabase_auth_error');
    expect(captured[0].httpStatus).toBe(401);
    expect(captured[0].retryable).toBe(false);
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain('token-invalido-sensivel');
    expect(serialized).not.toContain('Token inválido');
  });
});

describe('PESSOAL-13B3.3 — Endpoint: separação Gemini × Supabase × ferramenta', () => {
  it('falha da Gemini na 1ª chamada → stage=gemini_initial_request', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    const failing: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw asError(new Error('RESOURCE_EXHAUSTED: 429 Quota exceeded'), 'Error');
      },
    };
    registerGeminiClient(failing);
    const res = await run({ question: 'Oi' });
    expect(res.status).toBe(429);
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('gemini_initial_request');
    expect(captured[0].category).toBe('gemini_rate_limited');
    expect(captured[0].httpStatus).toBe(429);
    expect(captured[0].providerStatus).toBeUndefined();
    expect(captured[0].retryable).toBe(true);
  });

  it('falha da Gemini na 2ª chamada (follow-up) → stage=gemini_followup', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    let turn = 0;
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'financial_summary', args: { start: '2026-08-01', end: '2026-08-31' } },
            ],
          };
        }
        throw asError(new Error('connection reset by peer'), 'Error');
      },
    };
    registerGeminiClient(gemini);
    const res = await run({ question: 'Resumo de agosto?' });
    expect(res.status).toBe(502);
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('gemini_followup');
    expect(captured[0].category).toBe('unknown_upstream');
  });

  it('falha de query Supabase na ferramenta → stage=supabase_query', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    const postgrest = {
      name: 'PostgrestError',
      message: 'permission denied for table transactions (42501)',
      details: 'Some detail about RLS',
      hint: 'No hints',
      code: '42501',
    };
    authOk(failingSupabase(postgrest));
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        return {
          text: '',
          functionCalls: [
            { name: 'financial_summary', args: { start: '2026-08-01', end: '2026-08-31' } },
          ],
        };
      },
    };
    registerGeminiClient(gemini);
    const res = await run({ question: 'Quanto gastei em agosto?' });
    expect(res.status).toBe(502);
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('supabase_query');
    expect(captured[0].category).toBe('supabase_query_error');
    expect(captured[0].httpStatus).toBe(502);
  });

  it('falha não-Supabase dentro da ferramenta → stage=financial_tool_execution', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(failingSupabase(new Error('boom interno do executor')));
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        return {
          text: '',
          functionCalls: [
            { name: 'financial_summary', args: { start: '2026-08-01', end: '2026-08-31' } },
          ],
        };
      },
    };
    registerGeminiClient(gemini);
    const res = await run({ question: 'Quanto gastei em agosto?' });
    expect(res.status).toBe(502);
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('financial_tool_execution');
    expect(captured[0].category).toBe('tool_failed');
    expect(captured[0].errorName).toBe('AskError');
    expect(JSON.stringify(captured[0])).not.toContain('boom interno');
  });
});

describe('PESSOAL-13B3.3 — Endpoint: timeout e loops preservam comportamento', () => {
  it('AbortError → 502 preservado, evento stage=timeout / categoria=gemini_timeout', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    const abort = asError(new Error('This operation was aborted'), 'AbortError');
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw abort;
      },
    };
    registerGeminiClient(gemini);
    const res = await run({ question: 'Oi' });
    expect(res.status).toBe(502);
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('timeout');
    expect(captured[0].category).toBe('gemini_timeout');
    expect(captured[0].providerCode).toBe('ABORTED');
  });

  it('tool loop → stage=tool_selection / categoria=tool_failed', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    const looping: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        return {
          text: '',
          functionCalls: [
            { name: 'financial_summary', args: { start: '2026-08-01', end: '2026-08-31' } },
          ],
        };
      },
    };
    registerGeminiClient(looping);
    const res = await run({ question: 'Oi' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('upstream');
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('tool_selection');
    expect(captured[0].category).toBe('tool_failed');
  });

  it('max tool calls → stage=tool_selection / categoria=tool_failed (httpStatus 502)', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    let turn = 0;
    const variants = [
      '2026-01-01/2026-01-31',
      '2026-02-01/2026-02-28',
      '2026-03-01/2026-03-31',
      '2026-04-01/2026-04-30',
      '2026-05-01/2026-05-31',
      '2026-06-01/2026-06-30',
    ];
    const maxing: GeminiClient = {
      async sendMessage(_messages: GeminiMessage[]): Promise<GeminiResponse> {
        const [start, end] = variants[turn % variants.length].split('/');
        turn += 1;
        return {
          text: '',
          functionCalls: [{ name: 'financial_summary', args: { start, end } }],
        };
      },
    };
    registerGeminiClient(maxing);
    const res = await run({ question: 'Oi' });
    expect(res.status).toBe(502);
    expect(captured).toHaveLength(1);
    expect(captured[0].stage).toBe('tool_selection');
    expect(captured[0].category).toBe('tool_failed');
    expect(captured[0].httpStatus).toBe(502);
  });
});

describe('PESSOAL-13B3.3 — Proteção contra vazamento (erro artificial hostil)', () => {
  const IDENTIFIERS = {
    apiKey: 'AIzaSyFAKE-FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-FAKE',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWFidGExIn0.FAKE-SIGNATURE-FAKE-FAKE',
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    email: 'conta.sensivel@example.com',
    question: 'Quanto gastei em agosto de 2026 com padaria e mercado?',
    brl: 'R$ 1.234,56',
    toolData: 'financial_summary income=999999 expense=88888 balance=111111',
  };

  it('nenhum identificador do erro hostil aparece no evento nem na resposta', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());

    const hostileMessage =
      `connection refused: ${IDENTIFIERS.apiKey} ${IDENTIFIERS.jwt} ${IDENTIFIERS.uuid} ` +
      `${IDENTIFIERS.email} question="${IDENTIFIERS.question}" ${IDENTIFIERS.brl} ` +
      `tool=${IDENTIFIERS.toolData} Bearer ${IDENTIFIERS.jwt}`;
    const hostile = asError(new Error(hostileMessage), 'Error');
    hostile.stack =
      `Error: ${hostileMessage}\n    at Object.<anonymous>` +
      ` (${IDENTIFIERS.apiKey}::${IDENTIFIERS.jwt})\n    at /var/task/finance-ai/index.mjs:1:1`;

    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw hostile;
      },
    };
    registerGeminiClient(gemini);

    const res = await run({ question: IDENTIFIERS.question });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    const publicText = JSON.stringify(body);

    for (const value of Object.values(IDENTIFIERS)) {
      expect(JSON.stringify(captured)).not.toContain(value);
      expect(publicText).not.toContain(value);
    }
    expect(publicText).toBe(
      JSON.stringify({ error: 'upstream', message: 'Serviço de inteligência indisponível no momento.' }),
    );
  });

  it('evento usa apenas campos permitidos (conjunto fechado)', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    const failing: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw asError(new Error('INVALID_ARGUMENT: schema'), 'Error');
      },
    };
    registerGeminiClient(failing);
    await run({ question: 'Oi' });
    expect(captured).toHaveLength(1);
    const keys = Object.keys(captured[0]);
    for (const key of keys) {
      expect(OBSERVABILITY_FIELDS).toContain(key);
    }
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });

  it('requestId é aleatório entre requisições falhas', async () => {
    const captured: SanitizedFailureEvent[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    authOk(okClient());
    const failing: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw asError(new Error('boom hostil'), 'Error');
      },
    };
    registerGeminiClient(failing);
    await run({ question: 'Oi' });
    await run({ question: 'Oi' });
    expect(captured).toHaveLength(2);
    expect(captured[0].requestId).not.toBe(captured[1].requestId);
    expect(captured[0].requestId.length).toBeGreaterThan(8);
    expect(captured[1].requestId.length).toBeGreaterThan(8);
  });
});