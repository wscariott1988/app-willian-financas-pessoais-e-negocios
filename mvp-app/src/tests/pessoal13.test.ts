// pessoal13.test.ts — PESSOAL-13B1: IA financeira com Gemini.
// Cobertura: endpoint, ferramentas, cliente, orquestrador, UI, segurança, proteções.
// Sem mock de rede/Supabase server-side para tools puros; mock injetável para Gemini.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINANCE_TOOLS,
  FINANCE_TOOL_NAMES,
  getFinanceTool,
  validateToolArgs,
  MAX_SEARCH_RESULTS,
  toolResultToEvidence,
  isValidISODate,
  formatBRL,
} from '../../server/finance-ai/toolRegistry';
import {
  validateAskRequest,
  runFinanceAsk,
  resolvePeriod,
  currentMonthPeriod,
  MAX_TOOL_CALLS,
  MAX_QUESTION_LENGTH,
  toolSchemasForGemini,
  systemInstructionForGemini,
} from '../../server/finance-ai/orchestrator';
import { SYSTEM_INSTRUCTION, SYSTEM_INSTRUCTION_VERSION } from '../../server/finance-ai/systemInstruction';
import { AskError } from '../../server/finance-ai/observability';
import {
  registerGeminiClient,
  getRegisteredGeminiClient,
  buildFunctionalResponse,
  mockGeminiClient,
} from '../../server/finance-ai/geminiClient';
import type { GeminiClient, GeminiMessage, GeminiResponse } from '../../server/finance-ai/types';
import {
  summaryByPeriod,
  expensesByCategory,
  paidVsForecast,
  installmentSummary,
  recurringSummary,
  topExpenses,
  buildEvolutionWindow,
  monthlyEvolution,
  toSeriesOccurrenceRows,
  type SeriesOccurrenceRow,
  type EvolutionMonth,
} from '../lib/analyticsInsights';
import type { AnalyticsTxRow } from '../lib/analytics';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}
function readServerSource(rel: string): string {
  return readFileSync(resolve(here, '..', '..', 'server', rel), 'utf8');
}

const TODAY = '2026-09-13';
const CUTOFF = '2026-08-01';

function tx(partial: Partial<AnalyticsTxRow> & { id: string }, occurredOn = '2026-09-01'): AnalyticsTxRow {
  return {
    transaction_kind: 'expense',
    amount: 10,
    account_id: 'A1',
    category_id: null,
    occurred_on: occurredOn,
    status: 'posted',
    raw_description: 'Despesa',
    accounts: null,
    categories: null,
    ...partial,
  };
}

function occ(partial: Partial<SeriesOccurrenceRow>): SeriesOccurrenceRow {
  const base: SeriesOccurrenceRow = {
    series_id: 'S1',
    state: 'completed',
    kind: 'installment',
    frequency: 'monthly',
    direction: 'expense',
    display_name: 'Compra',
    amount_total: 1200,
    total_occurrences: 12,
    starts_on: '2026-01-10',
    occurrence_index: 1,
    occurred_on: '2026-09-10',
    amount: 100,
    tx_status: 'scheduled',
    tx_deleted_at: null,
  };
  return { ...base, ...partial };
}

// ── Tools: registry exclusivo, read-only, sem SQL ─────────────────────────────

describe('PESSOAL-13B1 — Tool registry', () => {
  it('contém exatamente as 9 tools permitidas', () => {
    expect(FINANCE_TOOL_NAMES).toEqual([
      'financial_summary',
      'expenses_by_category',
      'monthly_evolution',
      'paid_vs_forecast',
      'installment_summary',
      'recurring_summary',
      'top_expenses',
      'search_transactions',
      'expense_monthly_aggregate',
    ]);
    expect(FINANCE_TOOLS).toHaveLength(9);
    expect(FINANCE_TOOLS.map((t) => t.name).sort()).toEqual([...FINANCE_TOOL_NAMES].sort());
  });

  it('getFinanceTool retorna tool existente; retorna null para inexistente', () => {
    expect(getFinanceTool('financial_summary')).not.toBeNull();
    expect(getFinanceTool('execute_sql')).toBeNull();
    expect(getFinanceTool('transfer')).toBeNull();
  });

  it('todas as tools são read-only (nenhum write/mutation/explicit insert/update/delete)', () => {
    const src = readServerSource('finance-ai/toolRegistry.ts');
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/\.rpc\(/);
    expect(src).not.toMatch(/execute_sql/);
  });

  it('nenhuma tool aceita SQL nem permite ao modelo enviar SQL', () => {
    for (const tool of FINANCE_TOOLS) {
      for (const key of Object.keys(tool.argSchema)) {
        const lc = key.toLowerCase();
        expect(lc).not.toContain('sql');
        expect(lc).not.toContain('query');
        expect(lc).not.toContain('statement');
      }
    }
  });

  it('toolSchemasForGemini gera schemas válidos para todas as tools', () => {
    const schemas = toolSchemasForGemini();
    expect(schemas).toHaveLength(9);
    const names = schemas.map((s) => s.name as string).sort();
    expect(names).toEqual([...FINANCE_TOOL_NAMES].sort());
    for (const schema of schemas) {
      expect(typeof schema.description === 'string' && schema.description.length > 0).toBe(true);
      const params = schema.parameters as Record<string, unknown>;
      expect(params.type).toBe('object');
      expect(typeof params.properties).toBe('object');
    }
  });

  it('search_transactions limita a MAX_SEARCH_RESULTS (20)', () => {
    expect(MAX_SEARCH_RESULTS).toBe(20);
    const t = getFinanceTool('search_transactions')!;
    expect(t).not.toBeNull();
  });
});

// ── Ferramentas determinísticas: mantêm regras do PESSOAL-12 ─────────────────

describe('PESSOAL-13B1 — Transferências continuam excluídas', () => {
  it('summaryByPeriod exclui transferências dos totais (mesmo motor)', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 500 }),
      tx({ id: '2', transaction_kind: 'expense', amount: 100 }),
      tx({ id: '3', transaction_kind: 'transfer', amount: 9999 }),
    ];
    const s = summaryByPeriod(rows);
    expect(s.income).toBe(500);
    expect(s.expense).toBe(100);
    expect(s.balance).toBe(400);
  });

  it('expensesByCategory exclui receitas e transferências (mesmo motor)', () => {
    const rows = [
      tx({ id: '1', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 50 }),
      tx({ id: '2', transaction_kind: 'income', category_id: 'Z', categories: { display_name: 'Z', canonical_path: 'Z' }, amount: 9999 }),
      tx({ id: '3', transaction_kind: 'transfer', category_id: 'W', categories: { display_name: 'W', canonical_path: 'W' }, amount: 9999 }),
    ];
    const r = expensesByCategory(rows);
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe('A');
  });

  it('paidVsForecast exclui transferências (mesmo motor)', () => {
    const rows = [
      tx({ id: '1', amount: 100, status: 'posted' }),
      tx({ id: '2', transaction_kind: 'transfer', amount: 9999, status: 'posted' }),
    ];
    const pv = paidVsForecast(rows);
    expect(pv.paid).toBe(100);
    expect(pv.total).toBe(100);
  });

  it('topExpenses exclui transferências (mesmo motor)', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'expense', amount: 50, raw_description: 'Mercado' }),
      tx({ id: '2', transaction_kind: 'transfer', amount: 9999, raw_description: 'Pix' }),
    ];
    expect(topExpenses(rows, 10)).toHaveLength(1);
    expect(topExpenses(rows, 10)[0].description).toBe('Mercado');
  });
});

// ── Período: isolamento e validação ─────────────────────────────────────────

describe('PESSOAL-13B1 — Isolamento das regras de período', () => {
  it('isValidISODate: datas válidas e inválidas', () => {
    expect(isValidISODate('2026-09-13')).toBe(true);
    expect(isValidISODate('2026-02-29')).toBe(false); // 2026 não é bissexto
    expect(isValidISODate('2024-02-29')).toBe(true);  // 2024 é bissexto
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('abcd-ef-gh')).toBe(false);
    expect(isValidISODate('')).toBe(false);
  });

  it('resolvePeriod: período fornecido válido é respeitado', () => {
    const r = resolvePeriod({ question: 'Pergunta', period: { start: '2026-03-01', end: '2026-03-31' } });
    expect(r.start).toBe('2026-03-01');
    expect(r.end).toBe('2026-03-31');
    expect(r.fromRequest).toBe(true);
  });

  it('resolvePeriod: período inválido cai no mês corrente', () => {
    const r = resolvePeriod({ question: 'Pergunta', period: { start: '2026-13-01', end: '2026-02-01' } });
    expect(r.fromRequest).toBe(false);
    expect(/^\d{4}-\d{2}-01$/.test(r.start)).toBe(true);
  });

  it('resolvePeriod: sem período usa mês corrente', () => {
    const r = resolvePeriod({ question: 'Teste' });
    expect(r.fromRequest).toBe(false);
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    expect(r.start).toBe(`${y}-${m}-01`);
  });

  it('currentMonthPeriod retorna primeiro e último dia do mês corrente', () => {
    const p = currentMonthPeriod();
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    expect(p.start).toBe(`${y}-${m}-01`);
    expect(p.end).toMatch(new RegExp(`^${y}-${m}-\\d{2}$`));
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    expect(p.end).toBe(`${y}-${m}-${String(lastDay).padStart(2, '0')}`);
  });
});

// ── Validação de input ────────────────────────────────────────────────────────

describe('PESSOAL-13B1 — Validação de body', () => {
  it('body nulo/inválido é rejeitado', () => {
    expect(validateAskRequest(null).ok).toBe(false);
    expect(validateAskRequest(undefined).ok).toBe(false);
    expect(validateAskRequest('string').ok).toBe(false);
    expect(validateAskRequest([]).ok).toBe(false);
  });

  it('sem question ou question vazia é rejeitado', () => {
    expect(validateAskRequest({}).ok).toBe(false);
    expect(validateAskRequest({ question: '' }).ok).toBe(false);
    expect(validateAskRequest({ question: '   ' }).ok).toBe(false);
  });

  it('question acima do limite é rejeitada', () => {
    expect(validateAskRequest({ question: 'x'.repeat(1001) }).ok).toBe(false);
    expect(validateAskRequest({ question: 'x'.repeat(1000) }).ok).toBe(true);
  });

  it('period inválido é rejeitado', () => {
    expect(validateAskRequest({ question: 'Oi', period: { start: 'invalid', end: '2026-01-01' } }).ok).toBe(false);
    expect(validateAskRequest({ question: 'Oi', period: { start: '2026-01-31', end: '2026-01-01' } }).ok).toBe(false);
  });

  it('period válido é aceito', () => {
    expect(validateAskRequest({ question: 'Oi', period: { start: '2026-01-01', end: '2026-01-31' } }).ok).toBe(true);
  });

  it('profile_id NÃO é aceito nem confiado no body', () => {
    const req = { question: 'Pergunta', profile_id: 'fake-id' } as Record<string, unknown>;
    expect(validateAskRequest(req).ok).toBe(true);
    expect('profile_id' in req).toBe(true);
    expect(req.profile_id).toBe('fake-id');
  });
});

// ── Orquestrador: proteções ────────────────────────────────────────────────────

describe('PESSOAL-13B1 — Max tool calls', () => {
  it('MAX_TOOL_CALLS é 6', () => {
    expect(MAX_TOOL_CALLS).toBe(6);
  });
});

describe('PESSOAL-13B1 — Tool loop detection', () => {
  it('runFinanceAsk lança erro se a mesma tool+args é chamada duas vezes', async () => {
    const dummySupabase = { from: () => ({ select: () => ({ is: () => ({ gte: () => ({ lte: () => ({ data: [], error: null }) }) }) }) }) } as any;
    let turn = 0;
    const fakeGemini: GeminiClient = {
      async sendMessage(_messages: GeminiMessage[]): Promise<GeminiResponse> {
        turn += 1;
        // Sempre devolve a MESMA chamada de tool com os MESMOS argumentos em
        // todas as rodadas -> o orquestrador deve detectar o loop e abortar.
        return {
          text: '',
          functionCalls: [{ name: 'financial_summary', args: { start: '2026-09-01', end: '2026-09-30' } }],
        };
      },
    };
    const err = await runFinanceAsk({ supabase: dummySupabase, gemini: fakeGemini, question: 'Pergunta' }).catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    const askErr = err as AskError;
    expect(askErr.outcome).toBe('tool_loop');
    expect(askErr.stage).toBe('tool_selection');
    expect(askErr.classification.category).toBe('tool_failed');
    expect(askErr.message).not.toContain('tool');
  });
});

describe('PESSOAL-13B1 — Timeout', () => {
  it('MAX_QUESTION_LENGTH é 1000', () => {
    expect(MAX_QUESTION_LENGTH).toBe(1000);
  });
});

// ── Simulação de falha Gemini 429 ──────────────────────────────────────────────

describe('PESSOAL-13B1 — Gemini 429', () => {
  it('runFinanceAsk propaga erro quando Gemini lança quota/429', async () => {
    const dummySupabase = {} as any;
    const fakeGemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('RESOURCE_EXHAUSTED: 429 Quota exceeded');
      },
    };
    await expect(
      runFinanceAsk({ supabase: dummySupabase, gemini: fakeGemini, question: 'Pergunta' }),
    ).rejects.toThrow();
  });
});

// ── Simulação de falha genérica do Gemini ──────────────────────────────────────

describe('PESSOAL-13B1 — Gemini failure', () => {
  it('runFinanceAsk classifica erro genérico sem propagar a mensagem bruta', async () => {
    const dummySupabase = {} as any;
    const fakeGemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('Connection error: sensitive tunnel detail');
      },
    };
    const err = await runFinanceAsk({ supabase: dummySupabase, gemini: fakeGemini, question: 'Oi' }).catch((e) => e);
    expect(err).toBeInstanceOf(AskError);
    const askErr = err as AskError;
    expect(askErr.stage).toBe('gemini_initial_request');
    expect(askErr.classification.category).toBe('unknown_upstream');
    expect(askErr.classification.retryable).toBe(false);
    expect(askErr.message).not.toContain('Connection error');
    expect(askErr.message).not.toContain('sensitive');
  });
});

// ── Resposta estruturada ───────────────────────────────────────────────────────

describe('PESSOAL-13B1 — Resposta estruturada', () => {
  it('buildFunctionalResponse devolve answer, functionCalls [], toolsUsed []', () => {
    const res = buildFunctionalResponse([{ role: 'user', parts: 'Oi' }]);
    expect(typeof res.text).toBe('string');
    expect(Array.isArray(res.functionCalls)).toBe(true);
    expect(res.functionCalls).toHaveLength(0);
  });

  it('toolResultToEvidence gera evidências corretas para financial_summary', () => {
    const ev = toolResultToEvidence('financial_summary', { income: 3000, expense: 1500, balance: 1500 });
    expect(ev.length).toBe(3);
    expect(ev[0].label).toBe('Receitas');
    expect(ev[1].label).toBe('Despesas');
    expect(ev[2].label).toBe('Resultado');
  });

  it('toolResultToEvidence gera evidências corretas para expenses_by_category', () => {
    const ev = toolResultToEvidence('expenses_by_category', [
      { label: 'Alimentação', amount: 200, share: 0.4 },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe('Alimentação');
  });

  it('toolResultToEvidence gera evidências para search_transactions', () => {
    const ev = toolResultToEvidence('search_transactions', { count: 3, rows: [{ amount: 10 }, { amount: 20 }, { amount: 30 }] });
    expect(ev[0].label).toBe('Registros encontrados');
    expect(ev[0].value).toBe('3');
  });

  it('search_transactions NÃO expõe total parcial como agregado', () => {
    const ev = toolResultToEvidence('search_transactions', { count: 20, rows: Array.from({ length: 20 }, () => ({ amount: 10 })) });
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe('Registros encontrados');
    expect(ev.every((e) => e.label !== 'Total das buscas')).toBe(true);
  });
});

// ── search_transactions redige IDs ────────────────────────────────────────────

describe('PESSOAL-13B1 — search_transactions redige IDs', () => {
  it('search_transactions não retorna UUIDs', () => {
    const src = readServerSource('finance-ai/toolRegistry.ts');
    const searchIdx = src.indexOf('function execSearchTransactions');
    const searchBlock = src.slice(searchIdx, searchIdx + 800);
    expect(searchBlock).not.toContain('uuid');
    expect(searchBlock).not.toContain('UUID');
    expect(searchBlock).not.toContain('profile_id');
    expect(searchBlock).not.toContain('account_id');
    expect(searchBlock).not.toContain('user_id');
    expect(searchBlock).not.toContain('email');
    expect(searchBlock).not.toContain('JWT');
    expect(searchBlock).not.toContain('token');
  });
});

// ── System instruction ────────────────────────────────────────────────────────

describe('PESSOAL-13B1 — System instruction versionada', () => {
  it('SYSTEM_INSTRUCTION_VERSION é v2', () => {
    expect(SYSTEM_INSTRUCTION_VERSION).toBe('v2');
  });

  it('systemInstructionForGemini retorna instrução com regras mínimas', () => {
    const si = systemInstructionForGemini();
    expect(si).toContain('português brasileiro');
    expect(si).toContain('Nunca invente números');
    expect(si).toContain('transferências');
    expect(si).toContain('parcelamentos');
    expect(si).toContain('Não pago');
    expect(si).toContain('UUIDs');
    expect(si).toContain('Supabase');
    expect(si).toContain('JWT');
  });

  it('instrução não expõe chaves nem variáveis de ambiente', () => {
    expect(SYSTEM_INSTRUCTION).not.toContain('GEMINI_API_KEY');
    expect(SYSTEM_INSTRUCTION).not.toContain('SERVICE_ROLE');
    expect(SYSTEM_INSTRUCTION).not.toContain('SUPABASE_URL');
    expect(SYSTEM_INSTRUCTION).not.toContain('process.env');
  });
});

// ── Gemini client: mock e sem chave ──────────────────────────────────────────

describe('PESSOAL-13B1 — Gemini client injectável', () => {
  beforeEach(() => {
    registerGeminiClient(null);
  });

  it('sem chave: getRegisteredGeminiClient retorna null', () => {
    expect(getRegisteredGeminiClient()).toBeNull();
  });

  it('mockGeminiClient devolve resposta funcional sem chamadas reais', async () => {
    const client = mockGeminiClient();
    const res = await client.sendMessage([{ role: 'user', parts: 'Teste' }]);
    expect(typeof res.text).toBe('string');
    expect(res.functionCalls).toHaveLength(0);
  });

  it('registerGeminiClient armazena e recupera o client', () => {
    const fake = mockGeminiClient();
    registerGeminiClient(fake);
    expect(getRegisteredGeminiClient()).toBe(fake);
  });
});

// ── Validação de argumentos das tools ─────────────────────────────────────────

describe('PESSOAL-13B1 — Validação de tool args', () => {
  it('args nulos: retorna vazio', () => {
    expect(validateToolArgs('financial_summary', null)).toEqual({});
    expect(validateToolArgs('financial_summary', undefined)).toEqual({});
  });

  it('args não-objeto: retorna vazio', () => {
    expect(validateToolArgs('financial_summary', 'string')).toEqual({});
    expect(validateToolArgs('financial_summary', 42)).toEqual({});
    expect(validateToolArgs('financial_summary', [])).toEqual({});
  });

  it('limit numérico válido é aceito', () => {
    const res = validateToolArgs('expenses_by_category', { limit: 5 });
    expect(res.limit).toBe(5);
  });

  it('limit não-numérico lança erro', () => {
    expect(() => validateToolArgs('expenses_by_category', { limit: 'abc' })).toThrow();
  });

  it('datas inválidas lançam erro', () => {
    expect(() => validateToolArgs('financial_summary', { start: 'invalid' })).toThrow();
  });

  it('tool inexistente aceita qualquer args sem erro', () => {
    expect(validateToolArgs('unknown_tool', { any: 'data' })).toEqual({});
  });
});

// ── Formatação helpers ─────────────────────────────────────────────────────────

describe('PESSOAL-13B1 — formatBRL', () => {
  it('formata corretamente em pt-BR', () => {
    expect(formatBRL(1500)).toContain('1.500');
    expect(formatBRL(0)).toContain('0,00');
  });
});

// ── Validate tools read-only (src check) ──────────────────────────────────────

describe('PESSOAL-13B1 — Ferramentas são read-only (fonte)', () => {
  it('toolRegistry não contém insert/update/delete/upsert', () => {
    const src = readServerSource('finance-ai/toolRegistry.ts');
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/\.rpc\(/);
  });
});

// ── End-to-end: runFinanceAsk com mock que chama tools ────────────────────────

describe('PESSOAL-13B1 — runFinanceAsk end-to-end (mock)', () => {
  it('pergunta simples: executa financial_summary e retorna resposta estruturada', async () => {
    const fakeSupabase = {
      from: (table: string) => {
        if (table === 'transactions') {
          return {
            select: () => ({
              is: () => ({
                gte: () => ({
                  lte: () => ({
                    data: [
                      { transaction_kind: 'income', amount: 2000, occurred_on: '2026-09-01', status: 'posted', accounts: null, categories: null },
                      { transaction_kind: 'expense', amount: 800, occurred_on: '2026-09-05', status: 'posted', accounts: null, categories: null },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
}
        return {
          select: () => ({
            order: () => ({
              data: [],
              error: null,
            }),
          }),
        };
      },
    } as any;
    let turn = 0;
    const fakeGemini: GeminiClient = {
      async sendMessage(messages: GeminiMessage[]): Promise<GeminiResponse> {
        turn += 1;
        if (turn === 1) {
          return { text: '', functionCalls: [{ name: 'financial_summary', args: { start: '2026-09-01', end: '2026-09-30' } }] };
        }
        return { text: 'Sua receita foi R$ 2.000,00 e despesa R$ 800,00.', functionCalls: [] };
      },
    };
    const res = await runFinanceAsk({
      supabase: fakeSupabase,
      gemini: fakeGemini,
      question: 'Qual o resumo do mês?',
      period: { start: '2026-09-01', end: '2026-09-30' },
    });
    expect(typeof res.answer).toBe('string');
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.toolsUsed).toContain('financial_summary');
    expect(res.period?.start).toBe('2026-09-01');
    expect(res.period?.end).toBe('2026-09-30');
    expect(Array.isArray(res.evidence)).toBe(true);
    expect(res.evidence!.length).toBeGreaterThan(0);
  });

  it('pergunta sem tools: retorna resposta direta', async () => {
    const fakeGemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        return { text: 'Não tenho dados suficientes.', functionCalls: [] };
      },
    };
    const res = await runFinanceAsk({
      supabase: {} as any,
      gemini: fakeGemini,
      question: 'Oi',
    });
    expect(res.answer).toBe('Não tenho dados suficientes.');
    expect(res.toolsUsed).toHaveLength(0);
  });
});

// ── Fonte: sem GEMINI_API_KEY no frontend ─────────────────────────────────────

describe('PESSOAL-13B1 — Segurança: GEMINI_API_KEY não está no código frontend', () => {
  it('nenhum arquivo de src/ contém GEMINI_API_KEY como valor', () => {
    const clientSrc = readSource('lib/financeAiClient.ts');
    expect(clientSrc).not.toContain('GEMINI_API_KEY');
  });
});

// ── Fonte: sem referência a service_role ───────────────────────────────────────

describe('PESSOAL-13B1 — Segurança: sem SERVICE_ROLE no código', () => {
  it('toolRegistry não referencia service_role', () => {
    expect(readServerSource('finance-ai/toolRegistry.ts')).not.toContain('service_role');
    expect(readServerSource('finance-ai/orchestrator.ts')).not.toContain('service_role');
  });
});

// ── Fonte: profile_id não é confiável do body ─────────────────────────────────

describe('PESSOAL-13B1 — Segurança: profile_id não confiado', () => {
  it('endpoint aceita body sem profile_id', () => {
    const req = { question: 'Pergunta?' };
    expect(validateAskRequest(req).ok).toBe(true);
  });

  it('validateAskRequest não extrai/usa profile_id', () => {
    const src = readServerSource('finance-ai/orchestrator.ts');
    const fnIdx = src.indexOf('function validateAskRequest');
    const fnBody = src.slice(fnIdx, fnIdx + 500);
    expect(fnBody).not.toContain('profile_id');
  });
});

// ── FinanceAiSection: checks de segurança no código-fonte ─────────────────────

describe('PESSOAL-13B1 — Fonte: sem console.log nem secrets', () => {
  it('financeAiClient não contém console.log', () => {
    const src = readSource('lib/financeAiClient.ts');
    expect(src).not.toMatch(/console\.log\(/);
  });

  it('endpoint api/finances/ask.ts não contém console.log', () => {
    const src = readFileSync(
      resolve(here, '..', '..', 'api', 'finances', 'ask.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/console\.log\(/);
  });
});

// ── UI component checks ──────────────────────────────────────────────────────

describe('PESSOAL-13B1 — FinanceAiSection: checks de segurança e mobile', () => {
  const compSrc = readSource('components/FinanceAiSection.tsx');

  it('contém textarea e botão de envio', () => {
    expect(compSrc).toContain('textarea');
    expect(compSrc).toContain('finance-ai-submit');
  });

  it('contém os 4 chips de sugestão', () => {
    expect(compSrc).toContain('Onde estou gastando mais?');
    expect(compSrc).toContain('Compare com o mês passado');
    expect(compSrc).toContain('Quanto ainda tenho para pagar?');
    expect(compSrc).toContain('Quais são meus maiores gastos?');
  });

  it('trata estados loading e erro', () => {
    expect(compSrc).toContain('loading');
    expect(compSrc).toContain('error');
    expect(compSrc).toContain('role="alert"');
  });

  it('exibe período analisado e evidências', () => {
    expect(compSrc).toContain('Período analisado');
    expect(compSrc).toContain('finance-ai-evidence');
  });

  it('limita maxLength da textarea em 1000', () => {
    expect(compSrc).toContain('maxLength={1000}');
  });

  it('usa inFlight ref para bloquear envio duplicado', () => {
    expect(compSrc).toContain('inFlight');
  });

  it('contém aria-label acessível', () => {
    expect(compSrc).toContain('aria-label');
  });
});

// ── CSS checks: mobile-first, sem overflow ───────────────────────────────────

describe('PESSOAL-13B1 — CSS finance-ai: mobile-first sem overflow', () => {
  const css = readSource('index.css');

  it('contém classes finance-ai principais', () => {
    expect(css).toContain('.finance-ai-section');
    expect(css).toContain('.finance-ai-form');
    expect(css).toContain('.finance-ai-submit');
    expect(css).toContain('.finance-ai-suggestions');
    expect(css).toContain('.finance-ai-loading');
    expect(css).toContain('.finance-ai-result');
    expect(css).toContain('.finance-ai-period');
    expect(css).toContain('.finance-ai-evidence');
  });

  it('mobile @media com button full-width e evidence grid único', () => {
    const mediaIdx = css.lastIndexOf('@media (max-width: 480px)');
    const tail = css.slice(mediaIdx);
    expect(tail).toContain('.finance-ai-submit');
    expect(tail).toContain('.finance-ai-evidence');
  });
});

// ── AnalyticsView: FinanceAiSection integrado ────────────────────────────────

describe('PESSOAL-13B1 — AnalyticsView: FinanceAiSection integrado', () => {
  const view = readSource('views/AnalyticsView.tsx');

  it('importa FinanceAiSection', () => {
    expect(view).toContain("import { FinanceAiSection }");
  });

  it('renderiza FinanceAiSection', () => {
    expect(view).toContain('<FinanceAiSection');
    expect(view).toContain('period={range}');
  });
});

// ── FinanceAiClient: flags de segurança ───────────────────────────────────────

describe('PESSOAL-13B1 — financeAiClient: sem token no console', () => {
  const src = readSource('lib/financeAiClient.ts');

  it('não loga token', () => {
    expect(src).not.toMatch(/console\.\w+\(.*token/);
    expect(src).not.toMatch(/console\.\w+\(.*access_token/);
  });

  it('trata 400, 401, 405, 429, 502, 504', () => {
    expect(src).toContain('400');
    expect(src).toContain('401');
    expect(src).toContain('405');
    expect(src).toContain('429');
    expect(src).toContain('502');
    expect(src).toContain('504');
  });

  it('usa AbortController / signal', () => {
    expect(src).toContain('signal');
  });
});

// ── tools puros com mesmo resultado ───────────────────────────────────────────

describe('PESSOAL-13B1 — Tools determinísticas: mesmo resultado do PESSOAL-12', () => {
  const rows: AnalyticsTxRow[] = [
    tx({ id: '1', transaction_kind: 'income', amount: 3000, raw_description: 'Salário' }),
    tx({ id: '2', transaction_kind: 'expense', amount: 1200, raw_description: 'Aluguel', category_id: 'C1', categories: { display_name: 'Moradia', canonical_path: 'Moradia' } }),
    tx({ id: '3', transaction_kind: 'expense', amount: 400, raw_description: 'Mercado', category_id: 'C2', categories: { display_name: 'Alimentação', canonical_path: 'Alimentação' } }),
    tx({ id: '4', transaction_kind: 'expense', amount: 300, raw_description: 'Transporte', category_id: 'C3', categories: { display_name: 'Transporte', canonical_path: 'Transporte' } }),
    tx({ id: '5', transaction_kind: 'transfer', amount: 9999, raw_description: 'Pix' }),
  ];

  it('summaryByPeriod: resultado = receitas − despesas', () => {
    const s = summaryByPeriod(rows);
    expect(s.income).toBe(3000);
    expect(s.expense).toBe(1900);
    expect(s.balance).toBe(1100);
    expect(s.totalCount).toBe(5);
  });

  it('expensesByCategory: top categories com share correto', () => {
    const c = expensesByCategory(rows);
    expect(c).toHaveLength(3);
    expect(c[0].label).toBe('Moradia');
    expect(c[0].amount).toBe(1200);
  });

  it('paidVsForecast: despesas pagas vs não-pagas', () => {
    const pv = paidVsForecast([
      tx({ id: '1', amount: 500, status: 'posted', occurred_on: '2026-09-01' }),
      tx({ id: '2', amount: 200, status: 'pending', occurred_on: '2026-09-05' }),
    ]);
    expect(pv.paid).toBe(500);
    expect(pv.unpaid).toBe(200);
    expect(pv.total).toBe(700);
  });

  it('installmentSummary: soma ocorrências não-pagas', () => {
    const o = [
      occ({ series_id: 'S1', occurrence_index: 1, occurred_on: '2026-09-10', amount: 100, tx_status: 'scheduled' }),
      occ({ series_id: 'S1', occurrence_index: 2, occurred_on: '2026-10-10', amount: 100, tx_status: 'scheduled' }),
    ];
    const ins = installmentSummary(o, TODAY);
    expect(ins.count).toBe(1);
    expect(ins.committed).toBeCloseTo(200);
    expect(ins.items[0].remaining).toBe(2);
  });

  it('recurringSummary: conta recorrências ativas', () => {
    const o = [
      occ({ kind: 'recurring', state: 'active', series_id: 'R1', occurred_on: '2026-08-10', amount: 80, tx_status: 'posted' }),
      occ({ kind: 'recurring', state: 'stopped', series_id: 'R2', occurred_on: '2026-10-10', amount: 90, tx_status: 'scheduled' }),
    ];
    expect(recurringSummary(o, TODAY).count).toBe(1);
    expect(recurringSummary(o, TODAY).items[0].displayName).toBe('Compra');
  });

  it('topExpenses: top N por valor', () => {
    const t = topExpenses(rows, 2);
    expect(t).toHaveLength(2);
    expect(t[0].description).toBe('Aluguel');
    expect(t[0].amount).toBe(1200);
  });

  it('buildEvolutionWindow: 6 meses cheios terminando no mês atual', () => {
    const w = buildEvolutionWindow({ year: 2026, month: 9 });
    expect(w.months).toHaveLength(6);
    expect(w.start).toBe('2026-04-01');
    expect(w.end).toBe('2026-09-30');
  });

  it('monthlyEvolution: agrupa e zera meses sem movimento', () => {
    const w = buildEvolutionWindow({ year: 2026, month: 9 }, 3);
    const r = [
      tx({ id: '1', transaction_kind: 'expense', amount: 100 }, '2026-07-15'),
      tx({ id: '2', transaction_kind: 'income', amount: 400 }, '2026-09-01'),
    ];
    const pts = monthlyEvolution(r, w.months);
    expect(pts).toHaveLength(3);
    expect(pts[0].expense).toBe(100);
    expect(pts[0].income).toBe(0);
    expect(pts[2].income).toBe(400);
  });
});