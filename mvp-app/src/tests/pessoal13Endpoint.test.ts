// pessoal13Endpoint.test.ts — PESSOAL-13B1: endpoint /api/finances/ask.
// Testes executáveis do handler (Request → Response). Mocks injetáveis:
// auth Supabase server-side e client Gemini. Sem chamadas reais de rede.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// server/supabaseServer importa @supabase/supabase-js (resolução externa ao
// bundle de teste) — por isso é totalmente mockado, mantendo o endpoint testável
// sem dependência de node_modules no diretório api/.
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
  getRegisteredGeminiClient,
} from '../../server/finance-ai/geminiClient';
import type { GeminiClient, GeminiMessage, GeminiResponse } from '../../server/finance-ai/types';

const JSON_HEADERS = { 'content-type': 'application/json' };

function postRequest(body: unknown, token?: string): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function expectStatus(promise: Promise<Response>, status: number) {
  const res = await promise;
  expect(res.status).toBe(status);
  return res;
}

async function expectStatusAndBody(
  promise: Promise<Response>,
  status: number,
  errorCode: string,
): Promise<{ body: Record<string, unknown> }> {
  const res = await promise;
  expect(res.status).toBe(status);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.error).toBe(errorCode);
  return { body };
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

describe('PESSOAL-13B1 — Endpoint: autenticação', () => {
  it('rejeita sem Authorization (401)', async () => {
    const res = await handler(postRequest({ question: 'Oi' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe('Autenticação obrigatória.');
  });

  it('aceita apenas o scheme Bearer', async () => {
    const res = await handler(
      new Request('http://local/api/finances/ask', {
        method: 'POST',
        headers: { ...JSON_HEADERS, authorization: 'Basic abc' },
        body: JSON.stringify({ question: 'Oi' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('token inválido → 401 (auth.getUser falha)', async () => {
    vi.mocked(createUserSupabaseClient).mockRejectedValueOnce(new AuthTokenError());
    const res = await handler(
      postRequest({ question: 'Oi' }, 'token-invalido'),
    );
    expect(res.status).toBe(401);
    expect(createUserSupabaseClient).toHaveBeenCalledWith(
      expect.anything(),
      'token-invalido',
    );
  });

  it('token válido e pergunta → resposta estruturada (200)', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    registerGeminiClient(mockGeminiClient());
    const res = await handler(
      postRequest({ question: 'Qual o resumo?', period: { start: '2026-09-01', end: '2026-09-30' } }, 'token-valido'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      period: { start: string; end: string };
      toolsUsed: string[];
      evidence: unknown[];
    };
    expect(typeof body.answer).toBe('string');
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.period.start).toBe('2026-09-01');
    expect(body.period.end).toBe('2026-09-30');
    expect(body.toolsUsed).toEqual([]);
    expect(Array.isArray(body.evidence)).toBe(true);
  });
});

describe('PESSOAL-13B1 — Endpoint: compatibilidade com o runtime Node do Vercel', () => {
  // O runtime Node do Vercel entrega um IncomingMessage (headers como dicionário,
  // body como stream), não o Request Web padrão. O handler deve responder em
  // ambas as formas, senão produz `req.headers.get is not a function`.
  function nodeRequest(opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): unknown {
    const method = opts.method ?? 'POST';
    const req: {
      method: string;
      headers: Record<string, string>;
      [Symbol.asyncIterator]?: () => AsyncGenerator<Uint8Array<ArrayBuffer>, void, undefined>;
    } = {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
    };
    if (method === 'POST' && opts.body !== undefined) {
      req[Symbol.asyncIterator] = async function* () {
        yield Buffer.from(opts.body ?? '', 'utf8');
      };
    }
    return req;
  }

  it('GET no estilo Node (headers dicionário) → 405', async () => {
    const res = await handler(
      nodeRequest({ method: 'GET', headers: { authorization: 'Bearer x' } }) as Request,
    );
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('method_not_allowed');
  });

  it('POST no estilo Node sem Authorization → 401', async () => {
    const res = await handler(
      nodeRequest({ body: JSON.stringify({ question: 'Oi' }) }) as Request,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe('Autenticação obrigatória.');
  });

  it('POST no estilo Node com body em stream → 200', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    registerGeminiClient(mockGeminiClient());
    const res = await handler(
      nodeRequest({
        method: 'POST',
        headers: { authorization: 'Bearer token-node' },
        body: JSON.stringify({
          question: 'Resumo?',
          period: { start: '2026-09-01', end: '2026-09-30' },
        }),
      }) as Request,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; period: { start: string } };
    expect(typeof body.answer).toBe('string');
    expect(body.period.start).toBe('2026-09-01');
  });

  it('POST no estilo Node com JSON malformado → 400', async () => {
    const res = await handler(
      nodeRequest({
        method: 'POST',
        headers: { authorization: 'Bearer token-node' },
        body: '{nao-json',
      }) as Request,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe('Corpo da requisição inválido.');
  });

  it('responde escrevendo em res (GET → 405)', async () => {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      setHeader() {
        return res;
      },
      json(body: unknown) {
        captured.body = body;
        return res;
      },
    } as Parameters<typeof handler>[1];
    await handler(
      nodeRequest({ method: 'GET', headers: { authorization: 'Bearer x' } }) as unknown as Request,
      res,
    );
    expect(captured.status).toBe(405);
    expect((captured.body as { error?: string }).error).toBe('method_not_allowed');
  });

  it('responde escrevendo em res (POST sem Authorization → 401)', async () => {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      setHeader() {
        return res;
      },
      json(body: unknown) {
        captured.body = body;
        return res;
      },
    } as Parameters<typeof handler>[1];
    await handler(
      nodeRequest({ body: JSON.stringify({ question: 'Oi' }) }) as unknown as Request,
      res,
    );
    expect(captured.status).toBe(401);
    expect((captured.body as { message?: string }).message).toBe('Autenticação obrigatória.');
  });
});

describe('PESSOAL-13B1 — Endpoint: método e body', () => {
  it('método não-POST → 405', async () => {
    const res = await handler(
      new Request('http://local/api/finances/ask', {
        method: 'GET',
        headers: { authorization: 'Bearer x' },
      }),
    );
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('method_not_allowed');
  });

  it('JSON malformado → 400', async () => {
    const res = await handler(postRequest('{nao-json', 'token'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe('Corpo da requisição inválido.');
  });

  it('corpo sem pergunta → 400', async () => {
    const res = await handler(postRequest({}, 'token'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBe('Informe uma pergunta.');
  });

  it('pergunta acima do limite → 400', async () => {
    const res = await handler(postRequest({ question: 'x'.repeat(1001) }, 'token'));
    expect(res.status).toBe(400);
  });

  it('período com datas inválidas → 400', async () => {
    const res = await handler(
      postRequest({ question: 'Oi', period: { start: 'invalido', end: '2026-01-01' } }, 'token'),
    );
    expect(res.status).toBe(400);
  });

  it('período com start > end → 400', async () => {
    const res = await handler(
      postRequest({ question: 'Oi', period: { start: '2026-02-01', end: '2026-01-01' } }, 'token'),
    );
    expect(res.status).toBe(400);
  });

  it('período omitido → usa mês corrente (resposta ainda 200)', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    registerGeminiClient(mockGeminiClient());
    const res = await expectStatus(
      handler(postRequest({ question: 'Oi' }, 'token')),
      200,
    );
    const body = (await res.json()) as { period: { start: string; end: string } };
    expect(body.period.start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('profile_id no body é ignorado (não confiado)', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-real-do-jwt',
    });
    registerGeminiClient(mockGeminiClient());
    const res = await expectStatus(
      handler(postRequest({ question: 'Oi', profile_id: 'fake-profile' }, 'token')),
      200,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.profile_id).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('fake-profile');
  });

  it('profile_id malicioso NÃO influencia nenhuma query (spy nas queries)', async () => {
    const maliciousProfileId = 'outro-perfil-malicioso';
    const callArgs: unknown[] = [];

    // Chain minimalista para financial_summary com recorder em cada método.
    const recorder = (...a: unknown[]) => {
      callArgs.push(a);
      return chain;
    };
    const chain = {
      select: recorder,
      is: recorder,
      gte: recorder,
      lte: recorder,
      order: recorder,
      limit: recorder,
      ilike: recorder,
      data: [] as never[],
      error: null,
    };
    const fakeClient = {
      from: recorder,
    };

    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: fakeClient as never,
      userId: 'user-real-do-jwt',
    });

    // Mock Gemini: 1ª rodada pede financial_summary com período; 2ª responde.
    let turn = 0;
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              { name: 'financial_summary', args: { start: '2026-09-01', end: '2026-09-30' } },
            ],
          };
        }
        return { text: 'Resposta do resumo.', functionCalls: [] };
      },
    };
    registerGeminiClient(gemini);

    const res = await handler(
      postRequest({ question: 'teste', profile_id: maliciousProfileId }, 'token-real'),
    );
    expect(res.status).toBe(200);

    // As queries chegaram ao Supabase client derivado do JWT:
    const tables = callArgs.map((a) => (Array.isArray(a) && a.length > 0 ? a[0] : ''));
    expect(tables).toContain('transactions');

    // Nenhum argumento de query contém o profile_id malicioso nem "perfil":
    const flatArgs = JSON.stringify(callArgs);
    expect(flatArgs).not.toContain(maliciousProfileId);
    expect(flatArgs).not.toContain('outro-perfil');
  });
});

describe('PESSOAL-13B1 — Endpoint: sem Gemini configurado', () => {
  it('responde de forma controlada (200) sem GEMINI_API_KEY', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    expect(getRegisteredGeminiClient()).toBeNull();
    const res = await expectStatus(
      handler(postRequest({ question: 'Oi' }, 'token')),
      200,
    );
    const body = (await res.json()) as { answer: string };
    expect(body.answer).toContain('não está configurada');
  });
});

describe('PESSOAL-13B1 — Endpoint: falhas do Gemini', () => {
  it('Gemini quota/429 → 429 com mensagem amigável', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    const failing: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('RESOURCE_EXHAUSTED: 429 Quota exceeded');
      },
    };
    registerGeminiClient(failing);
    await expectStatusAndBody(
      handler(postRequest({ question: 'Oi' }, 'token')),
      429,
      'quota',
    );
  });

  it('Gemini erro genérico → 502 sem detalhes técnicos', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    const failing: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('connection refused: sensitive internal details');
      },
    };
    registerGeminiClient(failing);
    const { body } = await expectStatusAndBody(
      handler(postRequest({ question: 'Oi' }, 'token')),
      502,
      'upstream',
    );
    expect(body.message).not.toContain('connection refused');
    expect(body.message).not.toContain('sensitive');
  });

  it('tool loop → 502 controlado (sem stack trace)', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    const looping: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        return {
          text: '',
          functionCalls: [{ name: 'financial_summary', args: { start: '2026-09-01', end: '2026-09-30' } }],
        };
      },
    };
    registerGeminiClient(looping);
    const { body } = await expectStatusAndBody(
      handler(postRequest({ question: 'Oi' }, 'token')),
      502,
      'upstream',
    );
    expect(body.message).not.toContain('tool_loop');
  });
});

describe('PESSOAL-13B1 — Endpoint: max tool calls', () => {
  it('excede MAX_TOOL_CALLS → 502 controlado', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: { from: () => ({ select: () => ({ is: () => ({ gte: () => ({ lte: () => ({ data: [], error: null }) }) }) }) }) } as never,
      userId: 'user-123',
    });
    let turn = 0;
    const maxing: GeminiClient = {
      async sendMessage(_messages: GeminiMessage[]): Promise<GeminiResponse> {
        turn += 1;
        const variants = [
          { start: '2026-09-01', end: '2026-09-30' },
          { start: '2026-08-01', end: '2026-08-31' },
          { start: '2026-07-01', end: '2026-07-31' },
          { start: '2026-06-01', end: '2026-06-30' },
          { start: '2026-05-01', end: '2026-05-31' },
          { start: '2026-04-01', end: '2026-04-30' },
          { start: '2026-03-01', end: '2026-03-31' },
        ];
        return {
          text: '',
          functionCalls: [
            { name: 'financial_summary', args: variants[Math.min(turn - 1, variants.length - 1)] },
          ],
        };
      },
    };
    registerGeminiClient(maxing);
    const res = await handler(postRequest({ question: 'Oi' }, 'token'));
    expect([502]).toContain(res.status);
    const body = (await res.json()) as { error: string };
    expect(['too_many_tools', 'upstream']).toContain(body.error);
  });
});

describe('PESSOAL-13B1 — Endpoint: não expõe detalhes internos', () => {
  it('erro 502 nunca devolve stack trace', async () => {
    vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
      client: {} as never,
      userId: 'user-123',
    });
    const failing: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('Something went wrong at line 42 with stack push');
      },
    };
    registerGeminiClient(failing);
    const { body } = await expectStatusAndBody(
      handler(postRequest({ question: 'Oi' }, 'token')),
      502,
      'upstream',
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain('stack');
    expect(text).not.toContain('line 42');
    expect(text).not.toContain('token');
  });
});
