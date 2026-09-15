// pessoal13b3cFunctionCallContinuity.test.ts — PESSOAL-13B3.11: role e
// agrupamento das function responses.
//
// Contrato models.generateContent (https://ai.google.dev/api/generate-content):
//  - Content.role deve ser somente 'user' ou 'model';
//  - functionResponse é enviado em um Content com role 'user';
//  - N functionResponses de um mesmo turno ocupam UM único turno user;
//  - exatamente uma FunctionResponse para cada FunctionCall, id/name iguais.
//
// Também prova que o follow-up reenviado ao Gemini preserva integralmente o
// Content original do modelo (functionCall, id, thought e thoughtSignature como
// dado opaco) e que o getter response.text não é acessado quando a resposta tem
// somente functionCalls. Usa apenas valores fictícios; @google/genai é mockado.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const genaiMock = vi.hoisted(() => {
  const requests: Array<{ contents: any[] }> = [];
  const responses: unknown[] = [];
  return { requests, responses };
});

vi.mock('@google/genai', () => {
  class FakeGoogleGenAI {
    models = {
      generateContent: async (params: { contents: any[] }): Promise<any> => {
        genaiMock.requests.push(params);
        const next = genaiMock.responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }
  return { GoogleGenAI: FakeGoogleGenAI };
});

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
import {
  messageToContent,
  responseToGemini,
  createGeminiSdkClient,
} from '../../server/finance-ai/geminiSdkClient';
import {
  registerGeminiClient,
} from '../../server/finance-ai/geminiClient';
import {
  createUserSupabaseClient,
} from '../../server/supabaseServer';

const here = dirname(fileURLToPath(import.meta.url));

function readAdapterSource(): string {
  return readFileSync(
    resolve(here, '..', '..', 'server', 'finance-ai', 'geminiSdkClient.ts'),
    'utf8',
  );
}

const SIG = 'c2lnbmF0dXJlLWZha2UtNDIxZTBkYmEtczY2OA==';
const QUESTION = 'Quanto gastei em setembro?';

function okSupabase(): unknown {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'gte', 'lte', 'order', 'ilike', 'limit'] as const) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return { from: () => chain };
}

function authOk(): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: okSupabase() as never,
    userId: 'user-fake-0000-0000-0000-000000000000',
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer token-fake',
    },
    body: JSON.stringify(body),
  });
}

function fc(id: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, name: 'financial_summary', args };
}

function modelTurn(parts: any[]): Record<string, unknown> {
  return { role: 'model', parts };
}

function textResponse(text: string): Record<string, unknown> {
  return {
    text,
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    functionCalls: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  genaiMock.requests.length = 0;
  genaiMock.responses.length = 0;
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

afterEach(() => {
  registerGeminiClient(null);
});

function registerSdkClient(): void {
  const client = createGeminiSdkClient({ GEMINI_API_KEY: 'fake-key' });
  expect(client).not.toBeNull();
  registerGeminiClient(client);
}

// ── Adaptador: mapeamento puro ────────────────────────────────────────────────

describe('PESSOAL-13B3.11 — messageToContent preserva Content original', () => {
  it('model content é reenviado tal qual (sem reconstrução por texto)', () => {
    const content: any = {
      role: 'model',
      parts: [
        { text: 'extra' },
        { thought: true, text: 'raciocínio', thoughtSignature: SIG },
        { functionCall: { id: 'fc-001', name: 'financial_summary', args: { start: '2026-09-01' } } },
      ],
    };
    const out = messageToContent({ role: 'model', parts: '', content });
    expect(out).toBe(content);
  });

  it('lote de results vira UM Content role user com N functionResponses', () => {
    const out = messageToContent({
      role: 'function',
      parts: '',
      responses: [
        {
          id: 'fc-001',
          name: 'financial_summary',
          parts: '{"income":1,"expense":1,"balance":0,"totalCount":0,"expenseShare":null}',
        },
        { id: 'fc-002', name: 'top_expenses', parts: '{"count":0,"rows":[]}' },
      ],
    });
    expect(out.role).toBe('user');
    expect(out.parts).toHaveLength(2);
    const first = (out.parts?.[0] as any)?.functionResponse;
    expect(first.id).toBe('fc-001');
    expect(first.name).toBe('financial_summary');
    expect(first.response.expenseShare).toBeNull();
    const second = (out.parts?.[1] as any)?.functionResponse;
    expect(second.id).toBe('fc-002');
    expect(second.name).toBe('top_expenses');
  });

  it('nenhum Content de saída usa role function', () => {
    const out = messageToContent({
      role: 'function',
      parts: '',
      responses: [{ id: 'fc-001', name: 'financial_summary', parts: '{"income":0}' }],
    });
    expect(out.role).toBe('user');
    expect(out.role).not.toBe('function');
  });

  it('user message mantém formato anterior', () => {
    const out = messageToContent({ role: 'user', parts: QUESTION });
    expect(out.role).toBe('user');
    expect((out.parts?.[0] as any)?.text).toBe(QUESTION);
  });
});

describe('PESSOAL-13B3.11 — responseToGemini preserva sdkContent e id', () => {
  it('captura candidates[0].content completo e o id de cada functionCall', () => {
    const content: any = modelTurn([
      { thought: true, thoughtSignature: SIG, text: 'r' },
      { functionCall: fc('fc-001', { start: '2026-09-01', end: '2026-09-30' }) },
    ]);
    const r = responseToGemini({
      candidates: [{ content }],
      functionCalls: [{ id: 'fc-001', name: 'financial_summary', args: { start: '2026-09-01' } }],
    } as any);
    expect(r.sdkContent).toBe(content);
    expect(r.functionCalls[0].id).toBe('fc-001');
    expect(r.functionCalls[0].name).toBe('financial_summary');
  });

  it('não acessa o getter response.text quando a resposta tem só functionCalls', () => {
    const content: any = modelTurn([
      { thought: true, thoughtSignature: SIG, text: 'raciocínio' },
      { functionCall: fc('fc-001', { start: '2026-09-01', end: '2026-09-30' }) },
    ]);
    const response: any = {
      candidates: [{ content }],
      functionCalls: [fc('fc-001', { start: '2026-09-01', end: '2026-09-30' })],
      get text() {
        throw new Error('getter response.text acessado indevidamente');
      },
    };
    const r = responseToGemini(response);
    expect(r.functionCalls).toHaveLength(1);
    expect(r.text).toBe('');
  });
});

// ── Fluxo real: uma chamada simples ────────────────────────────────────────────

describe('PESSOAL-13B3.11 — Fluxo com uma functionCall', () => {
  it('follow-up reenvia Content integral e UM Content role user com uma functionResponse', async () => {
    const call = fc('fc-001', { start: '2026-09-01', end: '2026-09-30' });
    const originalParts = [
      { text: 'Vou consultar os dados primeiro.' },
      { thought: true, text: 'raciocínio interno', thoughtSignature: SIG },
      { functionCall: call },
    ];
    genaiMock.responses.push({ candidates: [{ content: modelTurn(originalParts) }], functionCalls: [call] });
    genaiMock.responses.push(textResponse('Você gastou R$ 0,00 em setembro.'));

    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(200);

    expect(genaiMock.requests).toHaveLength(2);
    const contents = genaiMock.requests[1].contents as any[];

    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts[0].text).toBe(QUESTION);

    expect(contents[1].role).toBe('model');
    expect(contents[1].parts).toEqual(originalParts);
    const preservedThought = contents[1].parts.find((p: any) => p.thoughtSignature !== undefined);
    expect(preservedThought.thoughtSignature).toBe(SIG);
    const preservedFc = contents[1].parts.find((p: any) => p.functionCall);
    expect(preservedFc.functionCall).toEqual(call);

    expect(contents[2].role).toBe('user');
    expect(contents[2].parts).toHaveLength(1);
    expect(contents[2].parts[0].functionResponse.id).toBe('fc-001');
    expect(contents[2].parts[0].functionResponse.name).toBe('financial_summary');
  });

  it('nenhum Content do transcript usa role function', async () => {
    const call = fc('fc-001', { start: '2026-09-01', end: '2026-09-30' });
    genaiMock.responses.push({ candidates: [{ content: modelTurn([{ functionCall: call }]) }], functionCalls: [call] });
    genaiMock.responses.push(textResponse('Resposta final.'));
    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(200);
    for (const req of genaiMock.requests) {
      for (const content of req.contents as any[]) {
        expect(['user', 'model']).toContain(content.role);
      }
    }
  });

  it('resposta final textual continua funcionando e não gera novo turno de tools', async () => {
    const call = fc('fc-001', { start: '2026-09-01', end: '2026-09-30' });
    genaiMock.responses.push({ candidates: [{ content: modelTurn([{ functionCall: call }]) }], functionCalls: [call] });
    genaiMock.responses.push(textResponse('Resposta final.'));
    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.answer).toBe('Resposta final.');
    expect(genaiMock.requests).toHaveLength(2);
  });

  it('seguinte sem função chamada: response.text só com texto não emite warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    genaiMock.responses.push(textResponse('Texto direto, sem tools.'));
    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: 'Oi' }));
    expect(res.status).toBe(200);
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('non-text parts'))).toBe(false);
    warnSpy.mockRestore();
  });
});

// ── Múltiplas chamadas paralelas ──────────────────────────────────────────────

describe('PESSOAL-13B3.11 — Múltiplas functionCalls paralelas', () => {
  it('geram UM único Content role user com N parts, ordem preservada', async () => {
    const calls = [
      fc('fc-p1', { start: '2026-09-01', end: '2026-09-10' }),
      fc('fc-p2', { start: '2026-09-11', end: '2026-09-20' }),
      fc('fc-p3', { start: '2026-09-21', end: '2026-09-30' }),
    ];
    genaiMock.responses.push({
      candidates: [{ content: modelTurn(calls.map((c) => ({ functionCall: c }))) }],
      functionCalls: calls,
    });
    genaiMock.responses.push(textResponse('Pronto.'));

    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(200);

    const contents = genaiMock.requests[1].contents as any[];
    expect(contents).toHaveLength(3);
    expect(contents[1].role).toBe('model');
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts).toHaveLength(calls.length);
    for (let i = 0; i < calls.length; i += 1) {
      const fr = contents[2].parts[i].functionResponse;
      const c = calls[i];
      expect(fr.id).toBe(c.id as string);
      expect(fr.name).toBe(c.name as string);
    }
  });

  it('quantidade de functionResponses é exatamente a de functionCalls', async () => {
    const calls = [
      fc('fc-a1', { start: '2026-09-01', end: '2026-09-15' }),
      fc('fc-a2', { start: '2026-09-16', end: '2026-09-30' }),
    ];
    genaiMock.responses.push({
      candidates: [{ content: modelTurn(calls.map((c) => ({ functionCall: c }))) }],
      functionCalls: calls,
    });
    genaiMock.responses.push(textResponse('Ok.'));
    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(200);
    const contents = genaiMock.requests[1].contents as any[];
    const frCount = contents[2].parts.reduce(
      (acc: number, p: any) => acc + (p.functionResponse ? 1 : 0), 0,
    );
    expect(frCount).toBe(calls.length);
  });

  it('follow-up não emite warning de non-text parts', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = [
      fc('fc-b1', { start: '2026-09-01', end: '2026-09-15' }),
      fc('fc-b2', { start: '2026-09-16', end: '2026-09-30' }),
    ];
    genaiMock.responses.push({
      candidates: [{ content: modelTurn(calls.map((c) => ({ functionCall: c }))) }],
      functionCalls: calls,
    });
    genaiMock.responses.push(textResponse('Consolidado.'));
    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(200);
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('non-text parts'))).toBe(false);
    warnSpy.mockRestore();
  });
});

// ── Chamadas sequenciais ──────────────────────────────────────────────────────

describe('PESSOAL-13B3.11 — Chamadas sequenciais alternam user/model', () => {
  it('cada lote de responses vira um único turno user entre turnos model', async () => {
    const c1 = fc('fc-s1', { start: '2026-09-01', end: '2026-09-15' });
    const c2 = fc('fc-s2', { start: '2026-09-16', end: '2026-09-30' });
    genaiMock.responses.push({ candidates: [{ content: modelTurn([{ functionCall: c1 }]) }], functionCalls: [c1] });
    genaiMock.responses.push({ candidates: [{ content: modelTurn([{ functionCall: c2 }]) }], functionCalls: [c2] });
    genaiMock.responses.push(textResponse('Final.'));

    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(200);
    expect(genaiMock.requests).toHaveLength(3);

    const second = genaiMock.requests[1].contents as any[];
    const third = genaiMock.requests[2].contents as any[];

    expect(second).toHaveLength(3);
    expect(second.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);

    expect(third).toHaveLength(5);
    expect(third.map((c: any) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    expect(third[3].parts[0].functionCall.id).toBe('fc-s2');
    expect(third[4].parts[0].functionResponse.id).toBe('fc-s2');
    expect(third[4].parts).toHaveLength(1);
  });
});

// ── Falha no follow-up: classificação inalterada e nenhum dado cru nos logs ──

describe('PESSOAL-13B3.11 — Falha no follow-up mantém contrato sanitizado', () => {
  it('INVALID_ARGUMENT no follow-up mantém 502 e evento igual ao diagnóstico B3.8', async () => {
    const call = fc('fc-001', { start: '2026-09-01', end: '2026-09-30' });
    genaiMock.responses.push({ candidates: [{ content: modelTurn([{ functionCall: call }]) }], functionCalls: [call] });
    genaiMock.responses.push(
      Object.assign(new Error('INVALID_ARGUMENT: function response structure invalid'), { name: 'GoogleGenAIError' }),
    );

    const logSpy = vi.spyOn(console, 'error');
    registerSdkClient();
    authOk();
    const res = await handler(postRequest({ question: QUESTION }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('upstream');

    const emitted = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith('[finance-ask]'));
    expect(emitted).toBeTruthy();
    const event = JSON.parse((emitted as string).replace('[finance-ask] ', '')) as Record<string, unknown>;
    expect(event.event).toBe('ask_failure');
    expect(event.stage).toBe('gemini_followup');
    expect(event.category).toBe('gemini_bad_request');
    expect(event.errorName).toBe('AskError');
    expect(event.httpStatus).toBe(502);
    expect(event.providerCode).toBe('INVALID_ARGUMENT');
    expect(event.providerStatus).toBeUndefined();
    expect(event.retryable).toBe(false);
    expect(typeof event.requestId).toBe('string');

    const raw = logSpy.mock.calls.map((call) => String(call[0])).join(' ');
    expect(raw).not.toContain(SIG);
    expect(raw).not.toContain(QUESTION);
    expect(raw).not.toContain('function response structure invalid');
    expect(raw).not.toContain('fc-001');
    logSpy.mockRestore();
  });

  it('adapter e observability nunca registram partes/thoughtSignature brutos', () => {
    const src = readAdapterSource();
    expect(src).not.toMatch(/console\.(log|error|debug|warn)/);
    const obs = readFileSync(
      resolve(here, '..', '..', 'server', 'finance-ai', 'observability.ts'),
      'utf8',
    );
    expect(obs).toMatch(/OBSERVABILITY_FIELDS/);
  });
});