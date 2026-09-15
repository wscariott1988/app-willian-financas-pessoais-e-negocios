// geminiClient.ts — Cliente Gemini abstraído/injetável (PESSOAL-13B1).
// Contrato em `GeminiClient`: apenas texto + function calls. A implementação
// concreta com o SDK oficial @google/genai (Interactions API) é plugada via
// `createGeminiClient`; nesta etapa SEM chave nenhum cliente real é construído
// e o sistema responde de forma controlada. Nada aqui lê secrets no browser;
// GEMINI_API_KEY é lida exclusivamente server-side.

import type { GeminiClient, GeminiMessage, GeminiResponse } from './types.js';
import { toolResultToEvidence } from './toolRegistry.js';

let geminiClientImpl: GeminiClient | null = null;

export function registerGeminiClient(client: GeminiClient | null): void {
  geminiClientImpl = client;
}

export function getRegisteredGeminiClient(): GeminiClient | null {
  return geminiClientImpl;
}

export function buildFunctionalResponse(messages: GeminiMessage[]): GeminiResponse {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser?.parts ?? '';
  const results = messages.flatMap((m) => m.responses ?? []);
  const toolsUsed = results.map((r) => r.name);
  const uniqueTools = [...new Set(toolsUsed)].filter(Boolean);
  let text =
    'A análise de IA ainda não está configurada neste ambiente. ' +
    'Faça a pergunta novamente quando a inteligência financeira estiver disponível.';
  if (question && uniqueTools.length > 0) {
    text =
      `Com base nos dados retornados pelas ferramentas utilizadas (${uniqueTools.join(', ')}), ` +
      'não foi possível gerar uma conclusão neste ambiente, pois a inteligência ainda não está configurada.';
  }
  const evidence: Array<{ label: string; value: string }> = [];
  const lastResult = results.length > 0 ? results[results.length - 1] : undefined;
  if (lastResult) {
    const name = lastResult.name;
    if (lastResult.parts) {
      try {
        const parsed = JSON.parse(lastResult.parts) as unknown;
        evidence.push(...toolResultToEvidence(name, parsed));
      } catch {
        // resposta não-JSON: sem evidência estruturada
      }
    }
  }
  return { text, functionCalls: [] };
}

export function mockGeminiClient(): GeminiClient {
  return {
    async sendMessage(messages: GeminiMessage[]): Promise<GeminiResponse> {
      return buildFunctionalResponse(messages);
    },
  };
}
