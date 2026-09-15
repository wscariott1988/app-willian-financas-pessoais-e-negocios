// geminiSdkClient.ts — Adapter concreto do SDK oficial @google/genai
// (PESSOAL-13B1). Lê GEMINI_API_KEY exclusivamente de process.env server-side.
//
// Garantias:
//  - Retorna null quando não há chave → estado controlado no runtime, NUNCA
//    erro de compilação (o endpoint responde de forma amigável).
//  - O modelo é configurável via GEMINI_MODEL (padrão gemini-2.5-flash).
//  - Nenhuma importação deste módulo pode estar no frontend/bundle Vite.
//  - Nenhuma chamada real de rede acontece na criação; apenas no sendMessage.
//  - Nunca envia JWT, UUIDs nem secrets para o Gemini.
//  - Continuação de function calling preserva o Content original do modelo
//    (functionCall, id e thoughtSignature) para os follow-ups (PESSOAL-13B3.9).

import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Tool,
} from '@google/genai';
import type { GeminiClient, GeminiMessage, GeminiResponse } from './types.js';
import { toolSchemasForGemini, systemInstructionForGemini } from './orchestrator.js';
import {
  GeminiCallError,
  classifyGeminiClientError,
} from './observability.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Converte schemas OpenAPI (type minúsculo) para o formato Type do SDK. */
function toSdkSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (typeof out.type === 'string') {
    out.type = (out.type as string).toUpperCase();
  }
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        toSdkSchema(v as Record<string, unknown>),
      ]),
    );
  }
  return out;
}

export function buildFunctionDeclarations(): FunctionDeclaration[] {
  return toolSchemasForGemini().map((s) => ({
    name: s.name as string,
    description: s.description as string,
    parameters: toSdkSchema((s.parameters ?? {}) as Record<string, unknown>),
  }));
}

export function createSdkTools(): Tool[] {
  return [{ functionDeclarations: buildFunctionDeclarations() }];
}

function parseParts(parts: string): Record<string, unknown> {
  try {
    const v = JSON.parse(parts) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { output: v };
  } catch {
    return { output: parts };
  }
}

export function messageToContent(m: GeminiMessage): Content {
  if (m.content) return m.content;
  if (m.responses && m.responses.length > 0) {
    // Contrato models.generateContent: functionResponse vive em Content com
    // role 'user'; N responses paralelas do mesmo turno formam UM turno user.
    return {
      role: 'user',
      parts: m.responses.map((r) => ({
        functionResponse: {
          id: r.id,
          name: r.name,
          response: parseParts(r.parts),
        },
      })),
    };
  }
  return {
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.parts }],
  };
}

/** Texto direto das parts textuais do candidato, sem consultar o getter
 * response.text (que emite warning quando há somente functionCalls). */
function extractCandidateText(content: Content | undefined): string {
  if (!content || !Array.isArray(content.parts)) return '';
  const chunks: string[] = [];
  for (const part of content.parts) {
    if (typeof part.text === 'string' && part.thought !== true) {
      chunks.push(part.text);
    }
  }
  return chunks.join('');
}

export function responseToGemini(response: GenerateContentResponse): GeminiResponse {
  const content = response.candidates?.[0]?.content;
  const functionCalls = (response.functionCalls ?? []).map((fc) => ({
    name: fc.name ?? '',
    args: fc.args ?? {},
    id: fc.id,
  }));
  return {
    text: functionCalls.length > 0 ? extractCandidateText(content) : (response.text ?? ''),
    functionCalls,
    sdkContent: content,
  };
}

/**
 * Cria o cliente Gemini concreto (SDK oficial @google/genai).
 * Retorna null quando GEMINI_API_KEY não está presente — o endpoint então
 * responde de forma controlada. A inicialização do GoogleGenAI é preguiçosa:
 * apenas o primeiro sendMessage instancia o client; nenhuma rede é tocada aqui.
 */
export function createGeminiSdkClient(
  env: Record<string, string | undefined>,
): GeminiClient | null {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  let ai: GoogleGenAI | null = null;

  return {
    async sendMessage(messages: GeminiMessage[]): Promise<GeminiResponse> {
      try {
        if (!ai) ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model,
          contents: messages.map(messageToContent),
          config: {
            systemInstruction: systemInstructionForGemini(),
            tools: createSdkTools(),
          },
        });
        return responseToGemini(response);
      } catch (err) {
        // Nunca registra err.message/stack: apenas classificação tipada e
        // sanitizada (categoria + status/providerCode do allowlist).
        throw new GeminiCallError(classifyGeminiClientError(err));
      }
    },
  };
}