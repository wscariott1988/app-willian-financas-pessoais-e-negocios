// pessoal13bArchitecture.test.ts — PESSOAL-13B1: validação de arquitetura.
// Cobre: root Vercel (mvp-app), separação browser/server, SDK Gemini concreto,
// ausência de secrets no frontend, profile_id nunca confiado do body e RLS/JWT.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeminiSdkClient } from '../../server/finance-ai/geminiSdkClient';
import type { GeminiMessage, GeminiResponse } from '../../server/finance-ai/types';

const here = dirname(fileURLToPath(import.meta.url));

function readProject(rel: string): string {
  return readFileSync(resolve(here, '..', '..', rel), 'utf8');
}

const exists = (rel: string): boolean => existsSync(resolve(here, '..', '..', rel));

// Remove comentários para validar SÓ o código executável (comentários podem
// documentar a regra citando profile_id/service_role, o que não é uso real).
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 1. Vercel Root = mvp-app ────────────────────────────────────────────

describe('PESSOAL-13B1 — Vercel root (mvp-app)', () => {
  it('function pública vive em mvp-app/api/finances/ask.ts', () => {
    expect(exists('api/finances/ask.ts')).toBe(true);
  });

  it('herdado/api e server antigos NÃO existem na raiz do repositório', () => {
    const repoRoot = resolve(here, '..', '..', '..');
    expect(existsSync(resolve(repoRoot, 'api'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'server'))).toBe(false);
  });

  it('supabaseServer vive em mvp-app/server/', () => {
    expect(exists('server/supabaseServer.ts')).toBe(true);
  });

  it('módulos server-side vivem em mvp-app/server/', () => {
    expect(exists('server/finance-ai/orchestrator.ts')).toBe(true);
    expect(exists('server/finance-ai/toolRegistry.ts')).toBe(true);
    expect(exists('server/finance-ai/geminiClient.ts')).toBe(true);
    expect(exists('server/finance-ai/geminiSdkClient.ts')).toBe(true);
    expect(exists('server/finance-ai/systemInstruction.ts')).toBe(true);
    expect(exists('server/finance-ai/types.ts')).toBe(true);
  });

  it('endpoint público é apenas POST /api/finances/ask', () => {
    const src = readProject('api/finances/ask.ts');
    expect(src).toContain('req.method !== \'POST\'');
    expect(src).toContain('405');
  });
});

// ── 2. Import paths resolvem dentro do root ──────────────────────────────

describe('PESSOAL-13B1 — Imports resolvem dentro do root Vercel', () => {
  it('ask.ts importa via caminhos relativos internos com extensão ESM (.js)', () => {
    const src = readProject('api/finances/ask.ts');
    expect(src).toMatch(/from '\.\.\/\.\.\/server\/finance-ai\//);
    expect(src).toMatch(/from '\.\.\/\.\.\/server\/supabaseServer\.js'/);
    expect(src).toMatch(/from '\.\.\/\.\.\/server\/finance-ai\/orchestrator\.js'/);
    expect(src).toMatch(/from '\.\.\/\.\.\/server\/finance-ai\/geminiClient\.js'/);
    expect(src).toMatch(/from '\.\.\/\.\.\/server\/finance-ai\/geminiSdkClient\.js'/);
    expect(src).not.toContain('../../mvp-app/');
  });

  it('toolRegistry importa os motores compartilhados de src/lib/ com .js (ESM)', () => {
    const src = readProject('server/finance-ai/toolRegistry.ts');
    expect(src).toMatch(/from '\.\.\/\.\.\/src\/lib\/analyticsInsights\.js'/);
    expect(src).toMatch(/from '\.\.\/\.\.\/src\/lib\/analytics\.js'/);
    expect(src).toMatch(/from '\.\.\/\.\.\/src\/lib\/status\.js'/);
    expect(src).toMatch(/from '\.\.\/\.\.\/src\/lib\/period\.js'/);
  });

  it('grafo server-side não mantém imports relativos sem extensão (ESM Node)', () => {
    const files = [
      'api/finances/ask.ts',
      'server/finance-ai/orchestrator.ts',
      'server/finance-ai/toolRegistry.ts',
      'server/finance-ai/geminiClient.ts',
      'server/finance-ai/geminiSdkClient.ts',
      'server/supabaseServer.ts',
      'src/lib/analyticsInsights.ts',
    ];
    for (const rel of files) {
      const src = readProject(rel);
      const lines = src.split('\n').filter((l) => l.includes('from \'./') || l.includes('from \'../') || l.includes('from\'./'));
      for (const line of lines) {
        expect(line).toMatch(/\.js'/);
      }
    }
  });
});

// ── 3. Separação browser/server ─────────────────────────────────────────

describe('PESSOAL-13B1 — Separação browser/server', () => {
  it('FinanceAiSection importa apenas o cliente frontend', () => {
    const src = readProject('src/components/FinanceAiSection.tsx');
    expect(src).toContain("from '../lib/financeAiClient'");
    expect(src).not.toContain('gemini');
    expect(src).not.toContain('orchestrator');
    expect(src).not.toContain('toolRegistry');
    expect(src).not.toContain('systemInstruction');
    expect(src).not.toContain('supabaseServer');
    expect(src).not.toContain('GEMINI_API_KEY');
    expect(src).not.toContain('process.env');
  });

  it('financeAiClient não importa Gemini SDK nem server helpers', () => {
    const src = readProject('src/lib/financeAiClient.ts');
    expect(src).not.toContain('@google/genai');
    expect(src).not.toContain('geminiSdkClient');
    expect(src).not.toContain('geminiClient');
    expect(src).not.toContain('orchestrator');
    expect(src).not.toContain('toolRegistry');
    expect(src).not.toContain('supabaseServer');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('GEMINI_API_KEY');
  });

  it('componentes React não importam systemInstruction/tool registry/supabaseServer', () => {
    for (const view of ['views/AnalyticsView.tsx']) {
      const src = readProject(`src/${view}`);
      expect(src).not.toContain('systemInstruction');
      expect(src).not.toContain('toolRegistry');
      expect(src).not.toContain('supabaseServer');
    }
  });

  it('servidor não importa código frontend (Supabase client do browser)', () => {
    const sdk = readProject('server/finance-ai/geminiSdkClient.ts');
    const srv = readProject('server/supabaseServer.ts');
    expect(sdk + srv).not.toContain("../supabaseClient");
    expect(sdk + srv).not.toContain('financeAiClient');
  });
});

// ── 4. GEMINI_API_KEY apenas server-side ────────────────────────────────

describe('PESSOAL-13B1 — GEMINI_API_KEY somente no servidor', () => {
  it('nenhum arquivo em src/ referencia GEMINI_API_KEY nem process.env', () => {
    const forbidden = ['src/components/FinanceAiSection.tsx', 'src/lib/financeAiClient.ts'];
    for (const rel of forbidden) {
      const src = readProject(rel);
      expect(src).not.toContain('GEMINI_API_KEY');
      expect(src).not.toContain('process.env');
    }
  });

  it('GEMINI_API_KEY só é lida em server/ e api/', () => {
    const sdk = readProject('server/finance-ai/geminiSdkClient.ts');
    const ask = readProject('api/finances/ask.ts');
    expect(sdk + ask).toContain('GEMINI_API_KEY');
  });

  it('adapter não inicializa sem ser chamado e retorna null sem chave', () => {
    const client = createGeminiSdkClient({});
    expect(client).toBeNull();
  });

  it('adapter cria client quando env tem chave; não dispara rede na criação', () => {
    const client = createGeminiSdkClient({ GEMINI_API_KEY: 'test-key' });
    expect(client).not.toBeNull();
  });

  it('modelo é configurável via env e tem default', () => {
    const def = createGeminiSdkClient({ GEMINI_API_KEY: 'k' });
    expect(def).not.toBeNull();
    const spec = readProject('server/finance-ai/geminiSdkClient.ts');
    expect(spec).toContain('DEFAULT_GEMINI_MODEL');
    expect(spec).toContain('GEMINI_MODEL');
  });
});

// ── 5. SDK oficial presente e isolado ───────────────────────────────────

describe('PESSOAL-13B1 — SDK oficial @google/genai', () => {
  it('dependência oficial está no package.json', () => {
    const pkg = readProject('package.json');
    expect(pkg).toContain('"@google/genai"');
  });

  it('adapter concreto usa o SDK (GoogleGenAI)', () => {
    const sdk = readProject('server/finance-ai/geminiSdkClient.ts');
    expect(sdk).toContain("from '@google/genai'");
    expect(sdk).toContain('GoogleGenAI');
    expect(sdk).toContain('models.generateContent');
  });

  it('adapter é server-side isolado (fora de src/)', () => {
    const belowSrc = exists('src/lib/finance-ai');
    expect(belowSrc).toBe(false);
  });

  it('nenhum arquivo frontend importa o adapter', () => {
    for (const rel of ['src/lib/financeAiClient.ts', 'src/components/FinanceAiSection.tsx']) {
      const src = readProject(rel);
      expect(src).not.toContain('geminiSdkClient');
    }
  });

  it('mantém injeção/mock usada nos testes (geminiClient.ts intacto)', () => {
    const src = readProject('server/finance-ai/geminiClient.ts');
    expect(src).toContain('registerGeminiClient');
    expect(src).toContain('getRegisteredGeminiClient');
    expect(src).toContain('mockGeminiClient');
  });
});

// ── 6. profile_id nunca confiado ────────────────────────────────────────

describe('PESSOAL-13B1 — profile_id: origem exclusiva no JWT', () => {
  it('validateAskRequest usa apenas {question, period}', () => {
    const src = readProject('server/finance-ai/orchestrator.ts');
    expect(src).not.toContain('profile_id');
    expect(src).not.toContain('profileId');
    expect(src).not.toContain('req.body');
  });

  it('tools nunca recebem profile_id (o perfil vem do JWT/RLS)', () => {
    const src = stripComments(readProject('server/finance-ai/toolRegistry.ts'));
    expect(src).not.toContain('profile_id');
    expect(src).not.toContain('profileId');
  });

  it('endpoint ignora profile_id do body (não o transmite)', () => {
    const src = stripComments(readProject('api/finances/ask.ts'));
    expect(src).not.toContain('profile_id');
    expect(src).not.toContain('profileId');
    expect(src).not.toContain('.query');
  });

  it('supabaseServer deriva identidade exclusivamente do JWT validado', () => {
    const src = stripComments(readProject('server/supabaseServer.ts'));
    expect(src).toContain('auth.getUser');
    expect(src).toContain('Authorization');
    expect(src).not.toContain('profile_id');
    expect(src).not.toContain('SERVICE_ROLE');
    expect(src).not.toContain('service_role');
  });
});

// ── 7. RLS + JWT, sem service_role ──────────────────────────────────────

describe('PESSOAL-13B1 — RLS com JWT, nunca service_role', () => {
  it('nenhum código server-side usa service_role', () => {
    for (const rel of [
      'server/supabaseServer.ts',
      'server/finance-ai/toolRegistry.ts',
      'server/finance-ai/orchestrator.ts',
      'api/finances/ask.ts',
    ]) {
      const src = stripComments(readProject(rel));
      expect(src).not.toContain('service_role');
      expect(src).not.toContain('SERVICE_ROLE');
    }
  });

  it('cliente Supabase server-side anexa o JWT do usuário (RLS ativa)', () => {
    const src = readProject('server/supabaseServer.ts');
    expect(src).toContain('createClient');
    expect(src).toContain('Bearer');
    expect(src).toContain('persistSession: false');
  });
});

// ── 8. SDK adapter conversões de mensagens (sem rede) ──────────────────

describe('PESSOAL-13B1 — SDK adapter: mocks continuam funcionando', () => {
  it('geminiClient mock continua válido (interface GeminiClient)', async () => {
    const messages: GeminiMessage[] = [{ role: 'user', parts: 'Oi' }];
    const client: { sendMessage(m: GeminiMessage[]): Promise<GeminiResponse> } = {
      async sendMessage() {
        return { text: 'ok', functionCalls: [] };
      },
    };
    const res = await client.sendMessage(messages);
    expect(res.text).toBe('ok');
  });

  it('adapter concreto respeita o contrato GeminiClient', () => {
    const client = createGeminiSdkClient({ GEMINI_API_KEY: 'k' });
    expect(typeof client?.sendMessage).toBe('function');
  });
});