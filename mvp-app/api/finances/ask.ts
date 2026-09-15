// api/finances/ask.ts — Function Vercel única (PESSOAL-13B1).
// POST /api/finances/ask
//
// Fluxo: Browser → endpoint → validação Supabase Auth → consultas com o JWT do
// usuário (RLS/app.jwt_profile_id() isolam Pessoal/Negócio) → tools financeiras
// determinísticas → Gemini → resposta estruturada.
//
// Regras de segurança:
//  - Nunca confia em profile_id vindo do frontend (não é aceito no body).
//  - Nunca usa service_role; GEMINI_API_KEY é lida somente server-side.
//  - Nunca envia o JWT nem a chave ao Gemini; nenhum stack trace é exposto.
//
// Contrato de runtime (Vercel Node): a função recebe um IncomingMessage e um
// `res` estilo VercelResponse — NÃO o Request Web padrão. Escrever a resposta
// em `res` é obrigatório; retornar apenas um `Response` faz o runtime aguardar
// para sempre. Para manter os testes (Request → Response) as duas formas são
// suportadas: com `res` presente escreve nele; sem `res` devolve um Response.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  validateAskRequest,
  runFinanceAsk,
  currentMonthPeriod,
  ORCHESTRATOR_TIMEOUT_MS,
} from '../../server/finance-ai/orchestrator.js';
import { getRegisteredGeminiClient } from '../../server/finance-ai/geminiClient.js';
import { createGeminiSdkClient } from '../../server/finance-ai/geminiSdkClient.js';
import { createUserSupabaseClient, AuthTokenError } from '../../server/supabaseServer.js';
import {
  AskError,
  buildFailureEvent,
  classifyGeminiClientError,
  emitSanitizedFailureEvent,
  isAbortLikeError,
  newRequestId,
  providerStatusOf,
  sanitizeErrorName,
  stageForClassification,
  type AskFailureCategory,
  type AskOutcome,
  type AskStage,
  type FailureClassification,
} from '../../server/finance-ai/observability.js';

interface NodeResponseLike {
  status?: (code: number) => NodeResponseLike;
  json?: (body: unknown) => unknown;
  setHeader?: (name: string, value: string) => unknown;
  send?: (body: string) => unknown;
  end?: (chunk?: string) => unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function respond(res: NodeResponseLike | undefined, status: number, body: unknown): Response | void {
  if (res) {
    if (typeof res.status === 'function') res.status(status);
    if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    if (typeof res.json === 'function') {
      res.json(body);
      return;
    }
    if (typeof res.send === 'function') {
      res.send(JSON.stringify(body));
      return;
    }
    if (typeof res.end === 'function') {
      res.end(JSON.stringify(body));
      return;
    }
  }
  return jsonResponse(status, body);
}

function readBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : null;
}

// Compatibilidade com o runtime Node do Vercel: a função recebe um
// IncomingMessage (headers como dicionário, body como stream), não o
// Request Web padrão. Suporta as duas formas.
function readHeader(req: { headers?: unknown }, name: string): string | null {
  const headers = req.headers;
  if (!headers) return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    return (get as (n: string) => string | null).call(headers, name);
  }
  const dict = headers as Record<string, string | string[] | undefined>;
  const raw = dict[name] ?? dict[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' ? raw : null;
}

async function readBodyText(req: unknown): Promise<string> {
  const json = (req as { json?: () => Promise<unknown> }).json;
  if (typeof json === 'function') {
    const parsed = await (req as Request).json();
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  }
  const iterable = req as AsyncIterable<Uint8Array<ArrayBuffer> | string>;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of iterable) {
    chunks.push(
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk,
    );
  }
  return new Blob(chunks).text();
}

function httpStatusForOutcome(outcome: AskOutcome): number {
  if (outcome === 'timeout') return 504;
  if (outcome === 'quota') return 429;
  return 502;
}

function friendlyForOutcome(outcome: AskOutcome): { error: string; message: string } {
  if (outcome === 'max_tool_calls') {
    return {
      error: 'too_many_tools',
      message: 'Não foi possível concluir a análise agora. Tente uma pergunta mais simples.',
    };
  }
  if (outcome === 'tool_loop') {
    return {
      error: 'upstream',
      message: 'Não foi possível concluir a análise agora. Tente reformular a pergunta.',
    };
  }
  if (outcome === 'timeout') {
    return { error: 'timeout', message: 'A análise demorou demais. Tente novamente.' };
  }
  if (outcome === 'quota') {
    return {
      error: 'quota',
      message: 'A cota do serviço de inteligência foi atingida. Tente novamente em alguns minutos.',
    };
  }
  if (outcome === 'config') {
    return { error: 'upstream', message: 'Configuração do provedor incompleta.' };
  }
  return { error: 'upstream', message: 'Serviço de inteligência indisponível no momento.' };
}

function resolveAskOutcome(err: unknown): AskOutcome {
  if (err instanceof Error) {
    if (err.message === 'max_tool_calls') return 'max_tool_calls';
    if (err.message === 'tool_loop') return 'tool_loop';
    if (err.message === 'timeout' || err.message === 'aborted') return 'timeout';
  }
  if (classifyGeminiClientError(err).category === 'gemini_rate_limited') {
    return 'quota';
  }
  return 'upstream';
}

function resolveFailure(err: unknown): {
  stage: AskStage;
  classification: FailureClassification;
  outcome: AskOutcome;
  status: number;
  errorName: string;
} {
  if (err instanceof AskError) {
    const finalOutcome: AskOutcome =
      err.outcome === 'upstream' &&
      err.classification.category === 'gemini_rate_limited'
        ? 'quota'
        : err.outcome;
    return {
      stage:
        err.classification.category === 'gemini_timeout' ? 'timeout' : err.stage,
      classification: err.classification,
      outcome: finalOutcome,
      status: httpStatusForOutcome(finalOutcome),
      errorName: sanitizeErrorName(err, 'AskError'),
    };
  }
  if (isAbortLikeError(err)) {
    // Preserva o comportamento atual: erro de transporte/abort vira 502 (nunca 504).
    const classification = classifyGeminiClientError(err);
    return {
      stage: 'timeout',
      classification,
      outcome: 'upstream',
      status: 502,
      errorName: sanitizeErrorName(err),
    };
  }
  const classification = classifyGeminiClientError(err);
  const outcome = resolveAskOutcome(err);
  const stage: AskStage =
    outcome === 'timeout'
      ? 'timeout'
      : stageForClassification(classification.category);
  return {
    stage,
    classification,
    outcome,
    status: httpStatusForOutcome(outcome),
    errorName: sanitizeErrorName(err),
  };
}

function emitFailure(opts: {
  requestId: string;
  startedAt: number;
  stage: AskStage;
  category: AskFailureCategory;
  errorName: string;
  httpStatus: number;
  classification: FailureClassification;
}): void {
  emitSanitizedFailureEvent(
    buildFailureEvent({
      requestId: opts.requestId,
      stage: opts.stage,
      category: opts.category,
      errorName: opts.errorName,
      httpStatus: opts.httpStatus,
      providerStatus: opts.classification.providerStatus,
      providerCode: opts.classification.providerCode,
      retryable: opts.classification.retryable,
      elapsedMs: Date.now() - opts.startedAt,
    }),
  );
}

export async function handler(req: Request): Promise<Response>;
export async function handler(req: Request, res: NodeResponseLike): Promise<void>;
export async function handler(req: Request, res?: NodeResponseLike): Promise<Response | void> {
  const requestId = newRequestId();
  const startedAt = Date.now();

  if (req.method !== 'POST') {
    return respond(res, 405, { error: 'method_not_allowed', message: 'Método não permitido. Use POST.' });
  }

  const authHeader = readHeader(req, 'authorization');
  const token = readBearer(authHeader);
  if (!token) {
    return respond(res, 401, { error: 'unauthorized', message: 'Autenticação obrigatória.' });
  }

  let rawBody: unknown;
  try {
    const text = await readBodyText(req);
    rawBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return respond(res, 400, { error: 'bad_request', message: 'Corpo da requisição inválido.' });
  }

  const validation = validateAskRequest(rawBody);
  const error = (validation as { ok: boolean; error?: string }).error;
  if (validation.ok !== true) {
    return respond(res, 400, { error: 'bad_request', message: error ?? 'Corpo da requisição inválido.' });
  }
  const body = rawBody as { question: string; period?: { start: string; end: string } };

  let userClient: { client: SupabaseClient; userId: string };
  try {
    userClient = await createUserSupabaseClient(
      process.env as Record<string, string | undefined>,
      token,
    );
  } catch (err) {
    if (err instanceof AuthTokenError) {
      emitFailure({
        requestId,
        startedAt,
        stage: 'auth',
        category: 'supabase_auth_error',
        errorName: sanitizeErrorName(err, 'AuthTokenError'),
        httpStatus: 401,
        classification: { category: 'supabase_auth_error', retryable: false },
      });
      return respond(res, 401, { error: 'unauthorized', message: 'Sessão expirada. Entre novamente.' });
    }
    const classification: FailureClassification = {
      category: 'unknown_upstream',
      providerStatus: providerStatusOf(err),
      retryable: false,
    };
    emitFailure({
      requestId,
      startedAt,
      stage: 'auth',
      category: 'unknown_upstream',
      errorName: sanitizeErrorName(err),
      httpStatus: 502,
      classification,
    });
    return respond(res, 502, friendlyForOutcome('config'));
  }

  // Prioridade: client injetável (mocks/testes) → SDK concreto quando há
  // GEMINI_API_KEY → null (resposta controlada sem a chave).
  const gemini =
    getRegisteredGeminiClient() ??
    createGeminiSdkClient(process.env as Record<string, string | undefined>);
  if (!gemini) {
    return respond(res, 200, {
      answer:
        'A análise de inteligência financeira ainda não está configurada neste ambiente. ' +
        'Por favor, tente novamente mais tarde.',
      period: currentMonthPeriod(),
      toolsUsed: [],
      evidence: [],
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ORCHESTRATOR_TIMEOUT_MS);

  try {
    const result = await runFinanceAsk({
      supabase: userClient.client,
      gemini,
      question: body.question,
      period: body.period,
      signal: controller.signal,
    });
    return respond(res, 200, result);
  } catch (err) {
    const failure = resolveFailure(err);
    emitFailure({
      requestId,
      startedAt,
      stage: failure.stage,
      category: failure.classification.category,
      errorName: failure.errorName,
      httpStatus: failure.status,
      classification: failure.classification,
    });
    return respond(res, failure.status, friendlyForOutcome(failure.outcome));
  } finally {
    clearTimeout(timeout);
  }
}

export default handler;