// orchestrator.ts — Orquestração Gemini ↔ tools financeiras (PESSOAL-13B1).
// Lógica pura e testável; nenhum I/O de rede direto (depende dos clientes
// injetados). Proteções: teto de tool calls, detecção de loop (mesma tool com os
// mesmos argumentos), timeout global via AbortSignal, validação de argumentos.
//
// Contrato stateless: cada pergunta é independente — sem histórico persistido,
// sem previous_interaction_id, sem armazenamento de conversas.

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AskRequest,
  AskResponse,
  GeminiClient,
  GeminiFunctionResult,
  GeminiMessage,
  GeminiResponse,
  EvidenceItem,
  ToolArgSchema,
} from './types.js';
import {
  FINANCE_TOOLS,
  getFinanceTool,
  validateToolArgs,
  toolResultToEvidence,
} from './toolRegistry.js';
import { SYSTEM_INSTRUCTION } from './systemInstruction.js';
import {
  AskError,
  GeminiCallError,
  classifyGeminiClientError,
  isSupabaseQueryError,
  providerStatusOf,
  type AskStage,
  type FailureClassification,
} from './observability.js';

export const MAX_TOOL_CALLS = 6;
export const MAX_QUESTION_LENGTH = 1000;
export const ORCHESTRATOR_TIMEOUT_MS = 60_000;

export function isValidISODate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parts = v.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return (
    d.getFullYear() === parts[0] &&
    d.getMonth() === parts[1] - 1 &&
    d.getDate() === parts[2]
  );
}

export interface ResolvedPeriod {
  start: string;
  end: string;
  fromRequest: boolean;
}

export function resolvePeriod(req: AskRequest): ResolvedPeriod {
  if (req.period) {
    const start = typeof req.period.start === 'string' ? req.period.start : '';
    const end = typeof req.period.end === 'string' ? req.period.end : '';
    if (start && end && isValidISODate(start) && isValidISODate(end) && start <= end) {
      return { start, end, fromRequest: true };
    }
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, fromRequest: false };
}

export function currentMonthPeriod(): { start: string; end: string } {
  const r = resolvePeriod({ question: '' });
  return { start: r.start, end: r.end };
}

export function validateAskRequest(body: unknown): { ok: true } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Corpo da requisição inválido.' };
  }
  const req = body as Partial<AskRequest>;
  if (typeof req.question !== 'string' || !req.question.trim()) {
    return { ok: false, error: 'Informe uma pergunta.' };
  }
  const question = req.question.trim();
  if (question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: 'A pergunta é muito longa.' };
  }
  if (req.period !== undefined) {
    if (!req.period || typeof req.period !== 'object' || Array.isArray(req.period)) {
      return { ok: false, error: 'Período inválido.' };
    }
    const start = typeof req.period.start === 'string' ? req.period.start : '';
    const end = typeof req.period.end === 'string' ? req.period.end : '';
    if (!isValidISODate(start) || !isValidISODate(end)) {
      return { ok: false, error: 'Datas do período devem estar no formato AAAA-MM-DD.' };
    }
    if (start > end) {
      return { ok: false, error: 'A data inicial não pode ser posterior à data final.' };
    }
  }
  return { ok: true };
}

export function validateToolArgsStrict(
  name: string,
  args: unknown,
  schema: ToolArgSchema,
): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Argumentos inválidos para a ferramenta ${name}.`);
  }
  const rec = args as Record<string, unknown>;
  for (const [key, def] of Object.entries(schema)) {
    if (rec[key] !== undefined && rec[key] !== null) {
      if (def.type === 'number') {
        const n = Number(rec[key]);
        if (!Number.isFinite(n)) throw new Error(`Argumento inválido para ${key}.`);
      } else if (def.type === 'string' && typeof rec[key] !== 'string') {
        throw new Error(`Argumento inválido para ${key}.`);
      }
    }
  }
  return validateToolArgs(name, args);
}

export interface ToolExecutionRecord {
  name: string;
  args: Record<string, unknown>;
  error?: string;
}

export interface OrchestratorDeps {
  supabase: SupabaseClient;
  gemini: GeminiClient;
  question: string;
  period?: { start: string; end: string };
  signal?: AbortSignal;
  maxToolCalls?: number;
}

async function sendGeminiStage(
  deps: OrchestratorDeps,
  stage: AskStage,
  messages: GeminiMessage[],
): Promise<GeminiResponse> {
  try {
    return await deps.gemini.sendMessage(messages);
  } catch (err) {
    if (err instanceof AskError) throw err;
    const classification: FailureClassification =
      err instanceof GeminiCallError
        ? err.classification
        : classifyGeminiClientError(err);
    throw new AskError(stage, classification);
  }
}

function pushModelTurn(messages: GeminiMessage[], response: GeminiResponse): void {
  if (response.sdkContent) {
    messages.push({ role: 'model', parts: '', content: response.sdkContent });
  } else {
    messages.push({ role: 'model', parts: response.text });
  }
}

export async function runFinanceAsk(deps: OrchestratorDeps): Promise<AskResponse> {
  const q = deps.question.trim();
  if (!q) throw new Error('Pergunta vazia.');
  if (q.length > MAX_QUESTION_LENGTH) throw new Error('Pergunta muito longa.');

  const resolved: { start: string; end: string } =
    deps.period &&
    isValidISODate(deps.period.start) &&
    isValidISODate(deps.period.end) &&
    deps.period.start <= deps.period.end
      ? { start: deps.period.start, end: deps.period.end }
      : currentMonthPeriod();

  const messages: GeminiMessage[] = [
    { role: 'user', parts: q },
  ];
  const toolsUsed: string[] = [];
  const evidence: EvidenceItem[] = [];
  const seenCalls = new Map<string, number>();
  const seenNonUnique = new Map<string, number>();

  // PESSOAL-13B3.12: o período exibido deve refletir o intervalo realmente
  // consultado pelas ferramentas (periodAnalyzed), não apenas o filtro da tela.
  let consultedPeriod: { start: string; end: string } | null = null;

  const maxCalls = deps.maxToolCalls ?? MAX_TOOL_CALLS;
  let toolCalls = 0;
  const deadline = Date.now() + ORCHESTRATOR_TIMEOUT_MS;

  const ensureNotAborted = () => {
    if (deps.signal?.aborted) {
      throw new AskError(
        'timeout',
        { category: 'gemini_timeout', retryable: true },
        'timeout',
      );
    }
    if (Date.now() > deadline) {
      throw new AskError(
        'timeout',
        { category: 'gemini_timeout', retryable: true },
        'timeout',
      );
    }
  };

  ensureNotAborted();
  let geminiCallCount = 0;
  geminiCallCount += 1;
  let response = await sendGeminiStage(deps, 'gemini_initial_request', messages);
  pushModelTurn(messages, response);

  while (response.functionCalls.length > 0) {
    if (toolCalls >= maxCalls) {
      throw new AskError(
        'tool_selection',
        { category: 'tool_failed', retryable: false },
        'max_tool_calls',
      );
    }
    const batchResults: GeminiFunctionResult[] = [];
    for (const call of response.functionCalls) {
      ensureNotAborted();
      const tool = getFinanceTool(call.name);
      if (!tool) {
        throw new AskError('tool_selection', {
          category: 'response_parse_error',
          retryable: false,
        });
      }
      const key = `${call.name}:${JSON.stringify(call.args ?? {})}`;
      const prev = seenCalls.get(key) ?? 0;
      if (prev >= 1) {
        throw new AskError(
          'tool_selection',
          { category: 'tool_failed', retryable: false },
          'tool_loop',
        );
      }
      seenCalls.set(key, prev + 1);
      seenNonUnique.set(call.name, (seenNonUnique.get(call.name) ?? 0) + 1);

      let result: unknown;
      try {
        const cleanArgs = validateToolArgsStrict(call.name, call.args, tool.argSchema);
        result = await tool.execute(deps.supabase, cleanArgs, todayISO());
        if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        evidence.push(...toolResultToEvidence(call.name, result));
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const rec = result as Record<string, unknown>;
          const pa = rec.periodAnalyzed;
          if (
            pa &&
            typeof pa === 'object' &&
            !Array.isArray(pa) &&
            typeof (pa as Record<string, unknown>).start === 'string' &&
            typeof (pa as Record<string, unknown>).end === 'string' &&
            isValidISODate((pa as Record<string, unknown>).start as string) &&
            isValidISODate((pa as Record<string, unknown>).end as string)
          ) {
            consultedPeriod = {
              start: (pa as Record<string, unknown>).start as string,
              end: (pa as Record<string, unknown>).end as string,
            };
          }
        }
      } catch (err) {
        if (err instanceof AskError) throw err;
        if (isSupabaseQueryError(err)) {
          throw new AskError('supabase_query', {
            category: 'supabase_query_error',
            providerStatus: providerStatusOf(err),
            retryable: false,
          });
        }
        throw new AskError('financial_tool_execution', {
          category: 'tool_failed',
          providerStatus: providerStatusOf(err),
          retryable: false,
        });
      }

      batchResults.push({
        id: call.id,
        name: call.name,
        parts: JSON.stringify(result ?? null),
      });
      toolCalls += 1;
    }

    // PESSOAL-13B3.11: N functionResponses de um mesmo turno viram um único
    // Content role:'user' (um Content subsequente por turno do modelo).
    if (batchResults.length > 0) {
      messages.push({ role: 'function', parts: '', responses: batchResults });
    }

    ensureNotAborted();
    geminiCallCount += 1;
    response = await sendGeminiStage(deps, 'gemini_followup', messages);
    pushModelTurn(messages, response);
  }

  const dedupEvidence: EvidenceItem[] = [];
  const seenEvidence = new Set<string>();
  for (const item of evidence) {
    const key = `${item.label}::${item.value}`;
    if (!seenEvidence.has(key)) {
      seenEvidence.add(key);
      dedupEvidence.push(item);
    }
  }

  return {
    answer: response.text,
    period: consultedPeriod ?? resolved,
    toolsUsed,
    evidence: dedupEvidence.slice(0, 8),
    engine: 'gemini',
    geminiCallCount,
    periodAnalyzed: consultedPeriod ?? resolved,
  };
}

function todayISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function toolSchemasForGemini(): Array<Record<string, unknown>> {
  return FINANCE_TOOLS.map((tool) => {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, def] of Object.entries(tool.argSchema)) {
      props[key] = { type: def.type, description: def.description };
      if (def.required) required.push(key);
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: props, ...(required.length ? { required } : {}) },
    };
  });
}

export function systemInstructionForGemini(): string {
  return SYSTEM_INSTRUCTION;
}
