// server/finance-ai/observability.ts — Observabilidade estruturada e sanitizada
// para /api/finances/ask (PESSOAL-13B3.3).
//
// Objetivos:
//  - Um único ponto de saída: um evento JSON com conjunto FECHADO de campos,
//    suficiente para diferenciar Gemini/Supabase/ferramenta/timeout/parsing.
//  - Preservar a origem do erro de forma tipada (AskError / GeminiCallError)
//    propagada pelas camadas até o endpoint.
//  - NUNCA emitir conteúdo bruto: nem err.message, nem stack, nem body, nem
//    pergunta, nem dados financeiros, nem headers/tokens/chaves/UUIDs/emails.
//
// O classificador lê mensagens de erro APENAS para casar um token fixo de um
// allowlist em minúsculas; o que é emitido são sempre constantes do enum abaixo,
// nunca o texto original.

import { randomUUID } from 'node:crypto';
import type { AskEngine } from './types.js';

// ── Stages ─────────────────────────────────────────────────────

export const OBSERVABILITY_STAGES = [
  'auth',
  'profile_resolution',
  'gemini_initial_request',
  'tool_selection',
  'financial_tool_execution',
  'supabase_query',
  'gemini_followup',
  'response_parsing',
  'timeout',
  'unknown',
] as const;
export type AskStage = (typeof OBSERVABILITY_STAGES)[number];

// ── Categorias de falha ────────────────────────────────────────

export const OBSERVABILITY_CATEGORIES = [
  'gemini_api_key_invalid',
  'gemini_permission_denied',
  'gemini_api_not_enabled',
  'gemini_model_not_found',
  'gemini_bad_request',
  'gemini_rate_limited',
  'gemini_timeout',
  'supabase_auth_error',
  'supabase_query_error',
  'tool_failed',
  'response_parse_error',
  'unknown_upstream',
] as const;
export type AskFailureCategory = (typeof OBSERVABILITY_CATEGORIES)[number];

// ── Códigos de provedor permitidos (allowlist fechada) ─────────

export const SAFE_PROVIDER_CODES = [
  'API_KEY_INVALID',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'API_DISABLED',
  'MODEL_NOT_FOUND',
  'INVALID_ARGUMENT',
  'RESOURCE_EXHAUSTED',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'CANCELLED',
] as const;
export type AskProviderCode = (typeof SAFE_PROVIDER_CODES)[number];

export interface FailureClassification {
  category: AskFailureCategory;
  providerStatus?: number;
  providerCode?: AskProviderCode;
  retryable: boolean;
}

// ── Resultado público (HTTP + mensagem amigável preservados) ──

export type AskOutcome =
  | 'max_tool_calls'
  | 'tool_loop'
  | 'timeout'
  | 'quota'
  | 'upstream'
  | 'config';

// ── Erros tipados ──────────────────────────────────────────────

export class AskError extends Error {
  readonly stage: AskStage;
  readonly classification: FailureClassification;
  readonly outcome: AskOutcome;

  constructor(
    stage: AskStage,
    classification: FailureClassification,
    outcome: AskOutcome = 'upstream',
  ) {
    super('ask-failure');
    this.name = 'AskError';
    this.stage = stage;
    this.classification = classification;
    this.outcome = outcome;
  }
}

export class GeminiCallError extends Error {
  readonly classification: FailureClassification;

  constructor(classification: FailureClassification) {
    super('gemini-call-failure');
    this.name = 'GeminiCallError';
    this.classification = classification;
  }
}

// ── Sanitização de nomes ───────────────────────────────────────

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

export function sanitizeErrorName(err: unknown, fallback = 'unknown'): string {
  if (!err || typeof err !== 'object') return fallback;
  const name = (err as { name?: unknown }).name;
  if (typeof name === 'string' && SAFE_ERROR_NAME.test(name)) return name;
  return fallback;
}

// ── Classificação ──────────────────────────────────────────────

export function providerStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const rec = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode'] as const) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) {
      return v;
    }
  }
  return undefined;
}

function defineStatusCategory(
  status: number,
): FailureClassification | undefined {
  if (status === 429) {
    return { category: 'gemini_rate_limited', providerStatus: status, providerCode: 'RESOURCE_EXHAUSTED', retryable: true };
  }
  if (status === 401) {
    return { category: 'gemini_api_key_invalid', providerStatus: status, providerCode: 'UNAUTHENTICATED', retryable: false };
  }
  if (status === 404) {
    return { category: 'gemini_model_not_found', providerStatus: status, providerCode: 'MODEL_NOT_FOUND', retryable: false };
  }
  if (status === 403) {
    return { category: 'gemini_permission_denied', providerStatus: status, providerCode: 'PERMISSION_DENIED', retryable: false };
  }
  if (status === 400) {
    return { category: 'gemini_bad_request', providerStatus: status, providerCode: 'INVALID_ARGUMENT', retryable: false };
  }
  if (status === 503 || status === 502) {
    return { category: 'unknown_upstream', providerStatus: status, retryable: true };
  }
  return undefined;
}

interface TokenRule {
  category: AskFailureCategory;
  code?: AskProviderCode;
  retryable: boolean;
  find: string;
}

const GEMINI_TOKEN_RULES: ReadonlyArray<TokenRule> = [
  // rate limit primeiro, para não ser confundido com outros 4xx
  { category: 'gemini_rate_limited', code: 'RESOURCE_EXHAUSTED', retryable: true, find: 'resource_exhausted' },
  { category: 'gemini_rate_limited', code: 'RESOURCE_EXHAUSTED', retryable: true, find: 'quota exceeded' },
  { category: 'gemini_rate_limited', code: 'RESOURCE_EXHAUSTED', retryable: true, find: 'quota' },
  { category: 'gemini_rate_limited', code: 'RESOURCE_EXHAUSTED', retryable: true, find: 'rate limit' },
  // chave inválida
  { category: 'gemini_api_key_invalid', code: 'API_KEY_INVALID', retryable: false, find: 'api key not valid' },
  { category: 'gemini_api_key_invalid', code: 'API_KEY_INVALID', retryable: false, find: 'invalid api key' },
  { category: 'gemini_api_key_invalid', code: 'API_KEY_INVALID', retryable: false, find: 'invalid_key' },
  { category: 'gemini_api_key_invalid', code: 'API_KEY_INVALID', retryable: false, find: 'api_key_invalid' },
  // modelo não encontrado
  { category: 'gemini_model_not_found', code: 'MODEL_NOT_FOUND', retryable: false, find: 'model_not_found' },
  { category: 'gemini_model_not_found', code: 'MODEL_NOT_FOUND', retryable: false, find: 'model not found' },
  { category: 'gemini_model_not_found', code: 'MODEL_NOT_FOUND', retryable: false, find: 'not_found' },
  // API não habilitada
  { category: 'gemini_api_not_enabled', code: 'API_DISABLED', retryable: false, find: 'api not enabled' },
  { category: 'gemini_api_not_enabled', code: 'API_DISABLED', retryable: false, find: 'not enabled' },
  { category: 'gemini_api_not_enabled', code: 'API_DISABLED', retryable: false, find: 'api_disabled' },
  { category: 'gemini_api_not_enabled', code: 'API_DISABLED', retryable: false, find: 'access not granted' },
  // permissão negada
  { category: 'gemini_permission_denied', code: 'PERMISSION_DENIED', retryable: false, find: 'permission_denied' },
  { category: 'gemini_permission_denied', code: 'PERMISSION_DENIED', retryable: false, find: 'permission denied' },
  // requisição mal-formada
  { category: 'gemini_bad_request', code: 'INVALID_ARGUMENT', retryable: false, find: 'invalid_argument' },
  // timeout
  { category: 'gemini_timeout', code: 'DEADLINE_EXCEEDED', retryable: true, find: 'deadline_exceeded' },
  { category: 'gemini_timeout', code: 'DEADLINE_EXCEEDED', retryable: true, find: 'deadline exceeded' },
  { category: 'gemini_timeout', code: 'DEADLINE_EXCEEDED', retryable: true, find: 'timed out' },
  { category: 'gemini_timeout', code: 'DEADLINE_EXCEEDED', retryable: true, find: 'timeout' },
  { category: 'gemini_timeout', code: 'ABORTED', retryable: true, find: 'aborted' },
  // falha de parsing da resposta
  { category: 'response_parse_error', code: 'INVALID_ARGUMENT', retryable: false, find: 'is not valid json' },
  { category: 'response_parse_error', code: 'INVALID_ARGUMENT', retryable: false, find: 'json parse error' },
  { category: 'response_parse_error', code: 'INVALID_ARGUMENT', retryable: false, find: 'invalid response' },
  { category: 'response_parse_error', code: 'INVALID_ARGUMENT', retryable: false, find: 'unexpected token' },
];

function tokenClassification(err: unknown): FailureClassification | undefined {
  if (!(err instanceof Error)) return undefined;
  const lower = err.message.toLowerCase();
  for (const rule of GEMINI_TOKEN_RULES) {
    if (lower.includes(rule.find)) {
      return {
        category: rule.category,
        providerCode: rule.code,
        retryable: rule.retryable,
      };
    }
  }
  return undefined;
}

export function classifyGeminiClientError(err: unknown): FailureClassification {
  // Erros de abortação de transporte são timeouts (gemini_timeout / ABORTED).
  if (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return { category: 'gemini_timeout', providerCode: 'ABORTED', retryable: true };
  }

  const byToken = tokenClassification(err);
  if (byToken) return byToken;

  const status = providerStatusOf(err);
  if (status !== undefined) {
    const byStatus = defineStatusCategory(status);
    if (byStatus) return byStatus;
  }

  // Verificação extra de status textual SAFE (apenas allowlist, nunca texto bruto).
  if (err && typeof err === 'object') {
    const textual = (err as { status?: unknown }).status;
    if (typeof textual === 'string' && (SAFE_PROVIDER_CODES as readonly string[]).includes(textual)) {
      const code = textual as AskProviderCode;
      const byCode: FailureClassification = {
        category: 'gemini_permission_denied',
        providerCode: code,
        retryable: false,
      };
      if (code === 'RESOURCE_EXHAUSTED') {
        byCode.category = 'gemini_rate_limited';
        byCode.retryable = true;
      } else if (code === 'UNAUTHENTICATED') {
        byCode.category = 'gemini_api_key_invalid';
      } else if (code === 'INVALID_ARGUMENT') {
        byCode.category = 'gemini_bad_request';
      } else if (code === 'DEADLINE_EXCEEDED' || code === 'ABORTED' || code === 'CANCELLED') {
        byCode.category = 'gemini_timeout';
        byCode.retryable = true;
      } else if (code === 'API_DISABLED') {
        byCode.category = 'gemini_api_not_enabled';
      }
      return byCode;
    }
  }

  return { category: 'unknown_upstream', providerStatus: status, retryable: false };
}

export function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const lower = err.message.toLowerCase();
  return (
    lower.includes('operation was aborted') ||
    lower.includes('this operation was aborted')
  );
}

export function isSupabaseQueryError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; hint?: unknown; details?: unknown };
  if (e.name === 'PostgrestError') return true;
  if (typeof e.hint === 'string' && e.hint.length > 0) return true;
  if (typeof e.details === 'string' && e.details.length > 0) return true;
  return false;
}

export function stageForClassification(category: AskFailureCategory): AskStage {
  if (category === 'supabase_auth_error') return 'auth';
  if (category === 'supabase_query_error') return 'supabase_query';
  if (category === 'tool_failed') return 'financial_tool_execution';
  if (category === 'response_parse_error') return 'response_parsing';
  if (category === 'gemini_timeout') return 'timeout';
  return 'unknown';
}

// ── Evento sanitizado ──────────────────────────────────────────

export interface SanitizedFailureEvent {
  event: 'ask_failure';
  requestId: string;
  stage: AskStage;
  category: AskFailureCategory;
  errorName: string;
  httpStatus: number;
  providerStatus?: number;
  providerCode?: AskProviderCode;
  retryable: boolean;
  elapsedMs: number;
}

export function newRequestId(): string {
  try {
    return `${Date.now().toString(36)}-${randomUUID().replace(/-/g, '')}`;
  } catch {
    let out = '';
    for (let i = 0; i < 16; i += 1) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return `${Date.now().toString(36)}-${out}`;
  }
}

export function buildFailureEvent(opts: {
  requestId: string;
  stage: AskStage;
  category: AskFailureCategory;
  errorName: string;
  httpStatus: number;
  providerStatus?: number;
  providerCode?: AskProviderCode;
  retryable: boolean;
  elapsedMs: number;
}): SanitizedFailureEvent {
  const event: SanitizedFailureEvent = {
    event: 'ask_failure',
    requestId: opts.requestId,
    stage: opts.stage,
    category: opts.category,
    errorName: opts.errorName,
    httpStatus: opts.httpStatus,
    retryable: opts.retryable,
    elapsedMs: opts.elapsedMs,
  };
  if (opts.providerStatus !== undefined) event.providerStatus = opts.providerStatus;
  if (opts.providerCode !== undefined) event.providerCode = opts.providerCode;
  return event;
}

export type SanitizedEventSink = (event: SanitizedFailureEvent) => void;

let eventSink: SanitizedEventSink | null = null;

export function setSanitizedEventSink(sink: SanitizedEventSink | null): void {
  eventSink = sink;
}

export function getSanitizedEventSink(): SanitizedEventSink | null {
  return eventSink;
}

export function emitSanitizedFailureEvent(event: SanitizedFailureEvent): void {
  if (eventSink) {
    eventSink(event);
    return;
  }
  const line = `[finance-ask] ${JSON.stringify(event)}`;
  try {
    // eslint-disable-next-line no-console
    console.error(line);
  } catch {
    // nunca deixar a telemetria derrubar a response
  }
}

export const OBSERVABILITY_FIELDS = [
  'event',
  'requestId',
  'stage',
  'category',
  'errorName',
  'httpStatus',
  'providerStatus',
  'providerCode',
  'retryable',
  'elapsedMs',
] as const;

// ── Evento de SUCESSO sanitizado (PESSOAL-13C1) ────────────────
// Permite comprovar custo Gemini zero na rota determinística sem expor nenhum
// dado sensível: apenas requestId, engine, intent, latência e contagem de
// chamadas. NUNCA contém pergunta, resposta, valores financeiros, UUIDs, JWT,
// tokens ou conteúdo do Gemini.

export const OBSERVABILITY_SUCCESS_FIELDS = [
  'event',
  'requestId',
  'engine',
  'intent',
  'elapsedMs',
  'geminiCallCount',
] as const;

export interface SanitizedSuccessEvent {
  event: 'ask_resolved';
  requestId: string;
  engine: AskEngine;
  /** Intenção determinística quando engine='deterministic'; ausente ou 'gemini' caso contrário. */
  intent?: string;
  elapsedMs: number;
  geminiCallCount: number;
}

export function buildSuccessEvent(opts: {
  requestId: string;
  engine: AskEngine;
  intent?: string;
  elapsedMs: number;
  geminiCallCount: number;
}): SanitizedSuccessEvent {
  const event: SanitizedSuccessEvent = {
    event: 'ask_resolved',
    requestId: opts.requestId,
    engine: opts.engine,
    elapsedMs: opts.elapsedMs,
    geminiCallCount: opts.geminiCallCount,
  };
  if (opts.intent && opts.engine === 'deterministic') event.intent = opts.intent;
  return event;
}

export type SanitizedSuccessSink = (event: SanitizedSuccessEvent) => void;

let successSink: SanitizedSuccessSink | null = null;

export function setSanitizedSuccessSink(sink: SanitizedSuccessSink | null): void {
  successSink = sink;
}

export function getSanitizedSuccessSink(): SanitizedSuccessSink | null {
  return successSink;
}

export function emitSanitizedSuccessEvent(event: SanitizedSuccessEvent): void {
  if (successSink) {
    successSink(event);
    return;
  }
  const line = `[finance-ask] ${JSON.stringify(event)}`;
  try {
    // eslint-disable-next-line no-console
    console.info(line);
  } catch {
    // nunca deixar a telemetria derrubar a response
  }
}