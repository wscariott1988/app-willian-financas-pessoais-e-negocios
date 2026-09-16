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
import type { AskResponse } from '../../server/finance-ai/types.js';
import { getRegisteredGeminiClient } from '../../server/finance-ai/geminiClient.js';
import { createGeminiSdkClient } from '../../server/finance-ai/geminiSdkClient.js';
import { createUserSupabaseClient, AuthTokenError } from '../../server/supabaseServer.js';
import { trustedIdentityMissing } from '../../server/auth/identityGate.js';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter.js';
import {
  beginChatTurn,
  completeChatTurn,
  failChatTurn,
  ChatOwnershipError,
  type BeginTurnResult,
  type ChatConversationSnapshot,
} from '../../server/chat/chatStore.js';
import {
  contextFromTurn,
  geminiContextBlock,
  titleFromQuestion,
} from '../../server/chat/chatContext.js';
import type { ChatMessagePayload } from '../../server/chat/chatTypes.js';
import { CHAT_GEMINI_RECENT_MSGS } from '../../server/chat/chatTypes.js';
import {
  AskError,
  buildFailureEvent,
  buildSuccessEvent,
  classifyGeminiClientError,
  emitSanitizedFailureEvent,
  emitSanitizedSuccessEvent,
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

interface CachedTurn {
  answer: string;
  payload: ChatMessagePayload | null;
  periodAnalyzed: { start: string; end: string } | null;
}

/** Reconstitui a AskResponse de uma resposta já concluída (clique duplo/reenvio). */
function cachedResponseOf(turn: CachedTurn): AskResponse {
  return {
    answer: turn.answer,
    period: turn.periodAnalyzed ?? null,
    toolsUsed: turn.payload?.toolsUsed ?? [],
    evidence: turn.payload?.evidence ?? [],
    engine: turn.payload?.engine ?? 'deterministic',
    geminiCallCount: turn.payload?.geminiCallCount ?? 0,
    periodAnalyzed: turn.periodAnalyzed ?? undefined,
  };
}

/** Últimas respostas concluídas da conversa (para o bloco de contexto do Gemini). */
async function recentAssistantContents(
  client: SupabaseClient,
  conversationId: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await client
    .from('chat_messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ content?: string }>;
  return [...rows].reverse().map((r) => r.content ?? '');
}

export async function handler(req: Request): Promise<Response>;
export async function handler(req: Request, res: NodeResponseLike): Promise<void>;
export async function handler(req: Request, res?: NodeResponseLike): Promise<Response | void> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const env = process.env as Record<string, string | undefined>;

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
  const body = rawBody as {
    question: string;
    period?: { start: string; end: string };
    conversationId?: string;
    clientRequestId?: string;
  };

  // PESSOAL-13C2: chat persistente. A persistência é ativada SOMENTE quando o
  // cliente envia os DOIS ids (conversationId + clientRequestId). Sem eles o
  // fluxo permanece 100% stateless (comportamento atual).
  const persistenceEnabled = !!body.conversationId && !!body.clientRequestId;

  let userClient: {
    client: SupabaseClient;
    userId: string;
    user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null;
  };
  try {
    userClient = await createUserSupabaseClient(
      env,
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

  // PESSOAL-13C2A.1 — identidade FAIL-CLOSED. O corpo da requisição NUNCA
  // informa a identidade: ela vem exclusivamente do usuário autenticado
  // (metadados verificados pelo JWT no supabaseServer). Sem identidade
  // confiável — sem body, sem perfil padrão — a requisição falha com 403. O
  // fallback legado só existe fora de produção (ver identityGate) e é
  // IMPOSSÍVEL no runtime Vercel (environment estrito sempre).
  if (userClient?.user && trustedIdentityMissing(userClient.user, env)) {
    emitFailure({
      requestId,
      startedAt,
      stage: 'auth',
      category: 'supabase_auth_error',
      errorName: 'profile_not_identified',
      httpStatus: 403,
      classification: { category: 'supabase_auth_error', retryable: false },
    });
    return respond(res, 403, {
      error: 'profile_not_identified',
      message: 'Perfil não identificado. Entre novamente para continuar.',
    });
  }

  // PESSOAL-13C1: rota determinística ANTES de qualquer Gemini — perguntas
  // simples (totais, categoria, mês com maior gasto) são respondidas direto dos
  // dados financeiros com custo Gemini zero. Quando a intenção não é de alta
  // confiança (análise/conselho/recomendação), cai no fluxo Gemini atual.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ORCHESTRATOR_TIMEOUT_MS);

  // PESSOAL-13C2: turno ativo da conversa (âncora assistant + contexto).
  let activeTurn: BeginTurnResult | null = null;
  let freshConversation: ChatConversationSnapshot | null = null;
  let assistantCreated = false;

  try {
    if (persistenceEnabled) {
      const begun = await beginChatTurn(userClient.client, {
        conversationId: body.conversationId as string,
        clientRequestId: body.clientRequestId as string,
        question: body.question,
      });
      // PESSOAL-13C2B.1: união discriminada tratada por switch exaustivo. O
      // membro `conversation` SÓ existe no estado 'fresh' — nunca lemos o campo
      // pela união crua (acesso assim quebrava o type-check do builder
      // @vercel/node). Cada estado é tratado explicitamente; um novo `kind`
      // sem case vira erro de compilação no default (nenhuma asserção insegura).
      switch (begun.kind) {
        case 'in_flight':
          return respond(res, 409, {
            error: 'in_flight',
            message: 'Esta pergunta já está sendo processada.',
          });
        case 'cached':
          emitSanitizedSuccessEvent(
            buildSuccessEvent({
              requestId,
              engine: begun.payload?.engine ?? 'deterministic',
              elapsedMs: Date.now() - startedAt,
              geminiCallCount: begun.payload?.geminiCallCount ?? 0,
            }),
          );
          return respond(res, 200, cachedResponseOf(begun));
        case 'cached_failure':
          return respond(res, 502, {
            error: 'upstream',
            message: begun.message,
          });
        case 'fresh':
          freshConversation = begun.conversation;
          activeTurn = begun;
          assistantCreated = true;
          break;
        default: {
          const exhaustive: never = begun;
          void exhaustive;
          throw new Error('Estado de turno inesperado (unreachable).');
        }
      }
    }
    const conversationContext = freshConversation?.context ?? null;
    const conversationTitle = freshConversation?.title ?? '';

    const deterministic = await runDeterministicAsk({
      supabase: userClient.client,
      question: body.question,
      period: body.period,
      context: conversationContext ?? undefined,
    });
    if (deterministic) {
      if (activeTurn) {
        await completeChatTurn(userClient.client, {
          conversationId: body.conversationId as string,
          clientRequestId: body.clientRequestId as string,
          answer: deterministic.response.answer,
          payload: {
            engine: 'deterministic',
            geminiCallCount: 0,
            toolsUsed: deterministic.response.toolsUsed,
            evidence: deterministic.response.evidence ?? [],
          },
          intent: deterministic.intent,
          engine: 'deterministic',
          periodAnalyzed:
            deterministic.response.periodAnalyzed ?? deterministic.response.period,
          context: contextFromTurn(conversationContext, {
            intent: deterministic.intent,
            category: deterministic.category ?? null,
            periodAnalyzed:
              deterministic.response.periodAnalyzed ?? deterministic.response.period,
            answer: deterministic.response.answer,
          }),
          setTitle: !conversationTitle,
          title: titleFromQuestion(body.question),
        });
      }
      emitSanitizedSuccessEvent(
        buildSuccessEvent({
          requestId,
          engine: 'deterministic',
          intent: deterministic.intent,
          elapsedMs: Date.now() - startedAt,
          geminiCallCount: 0,
        }),
      );
      return respond(res, 200, deterministic.response);
    }

    // Prioridade: client injetável (mocks/testes) → SDK concreto quando há
    // GEMINI_API_KEY → null (resposta controlada sem a chave).
    const gemini =
      getRegisteredGeminiClient() ??
      createGeminiSdkClient(env);
    if (!gemini) {
      const current = currentMonthPeriod();
      const canned: AskResponse = {
        answer:
          'A análise de inteligência financeira ainda não está configurada neste ambiente. ' +
          'Por favor, tente novamente mais tarde.',
        period: current,
        toolsUsed: [],
        evidence: [],
        engine: 'gemini',
        geminiCallCount: 0,
        periodAnalyzed: current,
      };
      if (activeTurn) {
        await completeChatTurn(userClient.client, {
          conversationId: body.conversationId as string,
          clientRequestId: body.clientRequestId as string,
          answer: canned.answer,
          payload: {
            engine: 'gemini',
            geminiCallCount: 0,
            toolsUsed: [],
          },
          intent: null,
          engine: 'gemini',
          periodAnalyzed: current,
          context: contextFromTurn(conversationContext, {
            intent: null,
            category: null,
            periodAnalyzed: current,
            answer: canned.answer,
          }),
          setTitle: !conversationTitle,
          title: titleFromQuestion(body.question),
        });
      }
      emitSanitizedSuccessEvent(
        buildSuccessEvent({
          requestId,
          engine: 'gemini',
          elapsedMs: Date.now() - startedAt,
          geminiCallCount: 0,
        }),
      );
      return respond(res, 200, canned);
    }

    // Bloco de contexto compacto para o Gemini (teto rígido em chatContext).
    const recent = activeTurn
      ? await recentAssistantContents(userClient.client, body.conversationId as string, CHAT_GEMINI_RECENT_MSGS)
      : [];
    const contextSummary =
      activeTurn && conversationContext
        ? geminiContextBlock(conversationContext, recent)
        : undefined;

    const result = await runFinanceAsk({
      supabase: userClient.client,
      gemini,
      question: body.question,
      period: body.period,
      signal: controller.signal,
      contextSummary,
    });
    if (activeTurn) {
      await completeChatTurn(userClient.client, {
        conversationId: body.conversationId as string,
        clientRequestId: body.clientRequestId as string,
        answer: result.answer,
        payload: {
          engine: 'gemini',
          geminiCallCount: result.geminiCallCount ?? 0,
          toolsUsed: result.toolsUsed,
          evidence: result.evidence ?? [],
        },
        intent: null,
        engine: 'gemini',
        periodAnalyzed: result.periodAnalyzed ?? result.period,
        context: contextFromTurn(conversationContext, {
          intent: null,
          category: null,
          periodAnalyzed: result.periodAnalyzed ?? result.period,
          answer: result.answer,
        }),
        setTitle: !conversationTitle,
        title: titleFromQuestion(body.question),
      });
    }
    emitSanitizedSuccessEvent(
      buildSuccessEvent({
        requestId,
        engine: 'gemini',
        elapsedMs: Date.now() - startedAt,
        geminiCallCount: result.geminiCallCount ?? 0,
      }),
    );
    return respond(res, 200, result);
  } catch (err) {
    if (err instanceof ChatOwnershipError) {
      return respond(res, 404, {
        error: 'not_found',
        message: 'Conversa não encontrada.',
      });
    }
    const failure = resolveFailure(err);
    if (assistantCreated && activeTurn) {
      try {
        await failChatTurn(userClient.client, {
          conversationId: body.conversationId as string,
          clientRequestId: body.clientRequestId as string,
          message: friendlyForOutcome(failure.outcome).message,
        });
      } catch {
        // Persistência da falha é best-effort: a resposta de erro ao cliente é a prioridade.
      }
    }
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