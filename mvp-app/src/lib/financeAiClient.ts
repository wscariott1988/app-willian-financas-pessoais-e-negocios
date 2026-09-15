// financeAiClient.ts — Cliente frontend do endpoint /api/finances/ask
// (PESSOAL-13B1). Obtém a sessão Supabase atual e envia o access_token SOMENTE
// no header Authorization. Nunca conhece/expõe a chave Gemini e nunca registra
// token no console.

import { supabase } from '../supabaseClient';

export interface AskApiResponse {
  answer: string;
  period: { start: string; end: string } | null;
  toolsUsed: string[];
  evidence?: Array<{ label: string; value: string }>;
}

/**
 * Remove marcadores Markdown literais do texto de resposta (apresentação).
 * Nunca altera valores: trabalha somente sobre marcadores (** * _ # ` e
 * marcadores de lista/heading no início de linha).
 */
export function stripMarkdownMarkers(text: string): string {
  const body = (text ?? '').replace(/```[\s\S]*?```/g, '').split('\n');
  const cleaned = body.map((line) =>
    line
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*(?=$|[.,;:!?)\s])/g, '$1$2')
      .replace(/(^|[^_])_([^_\n]+)_(?=$|[.,;:!?)\s])/g, '$1$2')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^\s*>\s+/, ''),
  );
  return cleaned
    .join('\n')
    .replace(/[*_]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function financeApiUrl(): string {
  return '/api/finances/ask';
}

export class FinanceApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FinanceApiError';
    this.status = status;
  }
}

export interface AskFinanceParams {
  question: string;
  period?: { start: string; end: string };
  signal?: AbortSignal;
}

export async function askFinance(params: AskFinanceParams): Promise<AskApiResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new FinanceApiError(401, 'Sessão expirada. Entre novamente para continuar.');
  }

  let res: Response;
  try {
    res = await fetch(financeApiUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        question: params.question,
        period: params.period,
      }),
      signal: params.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new FinanceApiError(0, 'Não foi possível conectar. Verifique sua conexão e tente novamente.');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  if (res.ok) {
    return {
      answer: stripMarkdownMarkers(typeof payload.answer === 'string' ? payload.answer : ''),
      period:
        payload.period &&
        typeof payload.period === 'object' &&
        !Array.isArray(payload.period)
          ? (payload.period as { start: string; end: string })
          : null,
      toolsUsed: Array.isArray(payload.toolsUsed)
        ? payload.toolsUsed.filter((t): t is string => typeof t === 'string')
        : [],
      evidence: Array.isArray(payload.evidence)
        ? payload.evidence.filter(
            (e): e is { label: string; value: string } =>
              !!e &&
              typeof e === 'object' &&
              typeof (e as { label?: unknown }).label === 'string' &&
              typeof (e as { value?: unknown }).value === 'string',
          )
        : undefined,
    };
  }

  let message = 'Não foi possível responder agora. Tente novamente.';
  const apiMessage = payload.message;
  if (typeof apiMessage === 'string' && apiMessage) message = apiMessage;

  if (res.status === 400) throw new FinanceApiError(400, message);
  if (res.status === 401) throw new FinanceApiError(401, message);
  if (res.status === 405) throw new FinanceApiError(405, message);
  if (res.status === 429) throw new FinanceApiError(429, message);
  if (res.status === 502) throw new FinanceApiError(502, message);
  if (res.status === 504) throw new FinanceApiError(504, message);
  throw new FinanceApiError(res.status, message);
}