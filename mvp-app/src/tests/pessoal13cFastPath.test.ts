// pessoal13cFastPath.test.ts — PESSOAL-13C1: fast-path determinístico.
//
// Prova que:
//   1. perguntas simples (totais, categoria, mês com maior gasto, comparação)
//      são respondidas direto dos dados, com engine='deterministic',
//      geminiCallCount=0 e período efetivo em periodAnalyzed;
//   2. o contrato de período da tela prevalece (mês/ano explícito acima da tela)
//      e períodos inválidos são rejeitados;
//   3. as respostas reutilizam as regras canônicas (summaryByPeriod /
//      expenseMonthlyAggregate / matchesCategoryTerm): transferências fora,
//      categoria só pelo category_id, sem filtro por status, >20 transações sem
//      truncamento (paginação), empates sem vencedor arbitrário;
//   4. a rota determinística NUNCA instancia nem chama o Gemini (perguntas de
//      conselho/análise continuam caindo no Gemini);
//   5. nenhum marcador Markdown nas respostas e nenhum dado sensível nos logs;
//   6. o profile_id do body é ignorado (isolamento via RLS com o JWT).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// server/supabaseServer é totalmente mockado (mesmo padrão dos outros testes).
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
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import {
  setSanitizedSuccessSink,
  OBSERVABILITY_SUCCESS_FIELDS,
  buildSuccessEvent,
  type SanitizedSuccessEvent,
} from '../../server/finance-ai/observability';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { expenseMonthlyAggregate } from '../../src/lib/analyticsInsights';
import type { AnalyticsTxRow } from '../../src/lib/analytics';

const JSON_HEADERS = { 'content-type': 'application/json' };

interface FakeLeanRow {
  transaction_kind?: 'income' | 'expense' | 'transfer' | null;
  amount?: number | string | null;
  occurred_on?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
}

interface FakeCategoryRow {
  display_name: string;
  canonical_path: string | null;
}

/**
 * Client Supabase determinístico com paginação (range + count exact). Quando
 * `withRange` é false, simula a interface sem paginação (busca única).
 * Roteia por tabela: 'transactions' responde `rows`; 'categories' responde
 * `cats` (utilizada na resolução canônica da categoria — PESSOAL-13C1.1).
 */
function detClient(
  rows: FakeLeanRow[],
  withRange = true,
  cats: FakeCategoryRow[] = [],
): { from: (t: string) => unknown; calls: string[][] } {
  const calls: string[][] = [];
  const base = (table: string): Record<string, unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    for (const m of ['select', 'is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
      c[m] = () => c;
    }
    const tableRows = table === 'categories' ? cats : rows;
    if (withRange) {
      c.range = (from: number, to: number) => {
        const page = tableRows.slice(from, to + 1);
        return {
          ...c,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: page, count: tableRows.length, error: null }),
        };
      };
    } else {
      c.range = undefined;
    }
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: tableRows, error: null });
    return c;
  };
  return {
    from: (t: string) => {
      calls.push([t]);
      return base(t);
    },
    calls,
  };
}

function postRequest(body: unknown, token = 'token-valido'): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function authOk(fakeClient: unknown): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: fakeClient as never,
    userId: 'user-test-0000-0000-0000-000000000000',
    user: null,
  });
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function cat(name: string, path: string | null = null): Array<{ display_name: string; canonical_path: string | null }> {
  return [{ display_name: name, canonical_path: path }];
}

function catLabel(name: string, path: string | null = null): FakeCategoryRow {
  return { display_name: name, canonical_path: path };
}

function expenseRow(amount: number, occurredOn: string, categories?: FakeLeanRow['categories']): FakeLeanRow {
  return { transaction_kind: 'expense', amount, occurred_on: occurredOn, categories };
}

const APRIL_SUPERMERCADO = cat('Supermercado', 'Alimentação > Supermercado');
const SUPERMERCADO_CATS = [catLabel('Supermercado', 'Alimentação > Supermercado')];
const APRIL2026 = { start: '2026-04-01', end: '2026-04-30' };

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  setSanitizedSuccessSink(null);
});

afterEach(() => {
  setSanitizedSuccessSink(null);
});

describe('PESSOAL-13C1 — Contrato de período determinístico', () => {
  it('pergunta sem data → usa exatamente o período selecionado na tela (abril)', async () => {
    const client = detClient([]);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      engine?: string;
      geminiCallCount?: number;
      period: { start: string; end: string };
      periodAnalyzed?: { start: string; end: string };
    };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(body.period.start).toBe('2026-04-01');
    expect(body.period.end).toBe('2026-04-30');
    expect(body.periodAnalyzed).toEqual(APRIL2026);
  });

  it('"em 2026" prevalece sobre a tela → ano inteiro', async () => {
    const client = detClient([]);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { period: { start: string; end: string } };
    expect(body.period.start).toBe('2026-01-01');
    expect(body.period.end).toBe('2026-12-31');
  });

  it('mês explícito prevalece sobre a tela (maio acima de abril)', async () => {
    const client = detClient([]);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em maio?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { period: { start: string; end: string } };
    expect(body.period.start).toBe('2026-05-01');
    expect(body.period.end).toBe('2026-05-31');
  });

  it('período inválido (start > end) → 400', async () => {
    const res = await handler(
      postRequest({ question: 'Quanto gastei?', period: { start: '2026-04-01', end: '2026-03-01' } }),
    );
    expect(res.status).toBe(400);
  });
});

describe('PESSOAL-13C1 — Respostas determinísticas reutilizam as regras canônicas', () => {
  it('total de despesas bate com summaryByPeriod (transferências fora)', async () => {
    const client = detClient([
      expenseRow(100, '2026-04-02', APRIL_SUPERMERCADO),
      expenseRow(250.5, '2026-04-10', cat('Aluguel')),
      expenseRow(400, '2026-04-20'),
      expenseRow(30, '2026-04-25'),
      { transaction_kind: 'transfer', amount: 5000, occurred_on: '2026-04-15' },
      { transaction_kind: 'transfer', amount: 9000, occurred_on: '2026-04-16' },
    ]);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      engine?: string;
      toolsUsed: string[];
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.toolsUsed).toEqual(['financial_summary']);
    expect(body.answer).toContain(brl(780.5));
    const despesas = body.evidence.find((e) => e.label === 'Despesas');
    expect(despesas?.value).toBe(brl(780.5));
  });

  it('categoria com acento/maiúsculas e path canônico (Alimentação > Supermercado)', async () => {
    const client = detClient(
      [
        expenseRow(2908.39, '2026-04-03', APRIL_SUPERMERCADO),
        expenseRow(123, '2026-04-04', APRIL_SUPERMERCADO),
        expenseRow(500, '2026-04-05', cat('Padaria')),
      ],
      true,
      [catLabel('Alimentação'), catLabel('Supermercado', 'Alimentação > Supermercado')],
    );
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em ALIMENTAÇÃO?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      toolsUsed: string[];
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.toolsUsed).toEqual(['expenses_by_category']);
    expect(body.answer).toContain(brl(2908.39 + 123));
    expect(
      body.evidence.some(
        (e) => e.label === 'Alimentação' && e.value === brl(2908.39 + 123),
      ),
    ).toBe(true);
  });

  it('>1000 transações não são truncadas (paginação com count exact)', async () => {
    const rows: FakeLeanRow[] = [];
    for (let i = 0; i < 1050; i += 1) {
      rows.push(expenseRow(1, '2026-04-01', APRIL_SUPERMERCADO));
    }
    const client = detClient(rows);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quantas despesas tive em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.answer).toContain('1.050');
    const quantidade = body.evidence.find((e) => e.label === 'Quantidade de despesas');
    expect(quantidade?.value).toBe('1050');
  });
});

describe('PESSOAL-13C1 — Mês com maior gasto', () => {
  it('devolve mês vencedor, total da categoria e total geral (todas as categorias)', async () => {
    const client = detClient(
      [
        // Supermercado em abril: vence o mês
        expenseRow(2908.39, '2026-04-03', APRIL_SUPERMERCADO),
        expenseRow(600, '2026-04-28', APRIL_SUPERMERCADO),
        // Outras categorias em abril (total geral abril)
        expenseRow(14772.12 - 2908.39 - 600, '2026-04-10', cat('Aluguel')),
        // Março com menos em supermercado
        expenseRow(1200, '2026-03-05', APRIL_SUPERMERCADO),
      ],
      true,
      [catLabel('Supermercado', 'Alimentação > Supermercado')],
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Qual mês eu mais gastei em supermercado em 2026?',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      toolsUsed: string[];
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.toolsUsed).toEqual(['expense_monthly_aggregate']);
    expect(body.answer).toContain('Abril');
    expect(body.answer).toContain(brl(2908.39 + 600));
    expect(body.answer).toContain(brl(14772.12));
    const geral = body.evidence.find((e) => e.label === 'Total geral (todas as categorias)');
    expect(geral?.value).toBe(brl(14772.12));
  });

  it('empate entre meses → resposta cita TODOS os meses empatados (sem vencedor arbitrário)', async () => {
    const client = detClient(
      [
        expenseRow(500, '2026-03-05', APRIL_SUPERMERCADO),
        expenseRow(500, '2026-04-05', APRIL_SUPERMERCADO),
      ],
      true,
      [catLabel('Supermercado', 'Alimentação > Supermercado')],
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Qual mês eu mais gastei em supermercado em 2026?',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string };
    expect(body.answer).toContain('Março');
    expect(body.answer).toContain('Abril');
    expect(body.answer).toContain(brl(500));
  });
});

describe('PESSOAL-13C1 — Observabilidade e motor', () => {
  it('rota determinística NUNCA chama o Gemini (sendMessage nem é instanciado)', async () => {
    const calls: number[] = [];
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        calls.push(1);
        return { text: 'NUNCA deve aparecer', functionCalls: [] };
      },
    };
    registerGeminiClient(gemini);
    const captured: SanitizedSuccessEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e));
    const client = detClient([expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)], true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; geminiCallCount?: number };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(calls).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0].engine).toBe('deterministic');
    expect(captured[0].geminiCallCount).toBe(0);
    expect(captured[0].intent).toBe('category_total');
  });

  it('pergunta de conselho ainda vai para o Gemini', async () => {
    const turns: string[][] = [];
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        turns.push(['advice']);
        return { text: 'Recomendo diversificar.', functionCalls: [] };
      },
    };
    registerGeminiClient(gemini);
    const captured: SanitizedSuccessEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e));
    authOk(detClient([]));
    const res = await handler(
      postRequest({ question: 'Devo investir mais em renda fixa?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; geminiCallCount?: number };
    expect(body.engine).toBe('gemini');
    expect(body.geminiCallCount).toBe(1);
    expect(turns).toHaveLength(1);
    expect(captured[0].engine).toBe('gemini');
  });

  it('periodAnalyzed alimenta o badge da tela (período efetivo)', async () => {
    const client = detClient([]);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em 2025?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: { start: string; end: string };
      periodAnalyzed: { start: string; end: string };
    };
    expect(body.period.start).toBe('2025-01-01');
    expect(body.periodAnalyzed.start).toBe('2025-01-01');
    expect(body.periodAnalyzed.end).toBe('2025-12-31');
  });

  it('evento de sucesso usa apenas campos permitidos e nunca dados financeiros', async () => {
    const captured: SanitizedSuccessEvent[] = [];
    setSanitizedSuccessSink((e) => captured.push(e));
    const client = detClient([expenseRow(2908.39, '2026-04-03', APRIL_SUPERMERCADO)], true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const keys = Object.keys(captured[0]);
    for (const key of keys) {
      expect(OBSERVABILITY_SUCCESS_FIELDS).toContain(key);
    }
    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain('2.908,39');
    expect(serialized).not.toContain('supermercado');
    expect(serialized).not.toContain('2026-04-03');
    expect(serialized).not.toContain('token');
  });

  it('buildSuccessEvent omite intent para engine gemini', () => {
    const e = buildSuccessEvent({
      requestId: 'r1',
      engine: 'gemini',
      intent: 'category_total',
      elapsedMs: 5,
      geminiCallCount: 1,
    });
    expect(e.intent).toBeUndefined();
  });
});

describe('PESSOAL-13C1 — Apresentação e isolamento de perfil', () => {
  it('respostas não contêm marcadores Markdown', async () => {
    const client = detClient([expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)], true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string };
    // ">" é separador legítimo do path canônico (Alimentação > Supermercado);
    // marcadores Markdown de ênfase/código nunca aparecem.
    expect(body.answer).not.toMatch(/[*_#`]/);
  });

  it('profile_id do body é ignorado (isolamento via RLS com o JWT)', async () => {
    const client = detClient([expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)]);
    authOk(client);
    const res = await handler(
      postRequest(
        { question: 'Quanto gastei?', period: APRIL2026, profile_id: 'perfil-malicioso' },
        'token-real',
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('perfil-malicioso');
    const queries = JSON.stringify(client.calls);
    expect(queries).not.toContain('perfil-malicioso');
    expect(client.calls.some((c) => c[0] === 'transactions')).toBe(true);
  });

  it('cliente sem paginação (.range ausente) degrada para o Gemini (contrato preservado)', async () => {
    // Interfaces antigas/test doubles sem `.range` NÃO devem gerar total
    // possivelmente truncado: o fast-path devolve null e o fluxo Gemini segue
    // intacto (mesma degradação segura em produção por integrações incompletas).
    const turns: number[] = [];
    const gemini: GeminiClient = {
      async sendMessage(): Promise<GeminiResponse> {
        turns.push(1);
        return { text: 'Resposta da IA.', functionCalls: [] };
      },
    };
    registerGeminiClient(gemini);
    const client = detClient([expenseRow(50, '2026-04-01', APRIL_SUPERMERCADO)], false);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('gemini');
    expect(turns).toHaveLength(1);
  });
});

describe('PESSOAL-13C1.1 — Interpretação da pergunta (separação e precedência)', () => {
  function supermercadoAbril(): FakeLeanRow[] {
    const rows: FakeLeanRow[] = [];
    for (let i = 0; i < 17; i += 1) {
      rows.push(expenseRow(100.5, '2026-04-03', APRIL_SUPERMERCADO));
    }
    rows.push(expenseRow(1199.89, '2026-04-03', APRIL_SUPERMERCADO));
    return rows;
  }

  function neverGemini(): GeminiClient {
    return {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('Gemini NÃO pode ser chamado');
      },
    };
  }

  it('"Pergunta Resultado esperado" não vira saldo — prevalece "quanto gastei" (frase exata 1)', async () => {
    const client = detClient([
      expenseRow(1200, '2026-04-10', cat('Aluguel')),
      expenseRow(800, '2026-04-12', cat('Aluguel')),
      expenseRow(1500, '2026-04-20', cat('Alimentação')),
    ]);
    authOk(client);
    const res = await handler(
      postRequest({
        question:
          'Pergunta Resultado esperado Quanto gastei no mês? Informe o total e quantas despesas foram consideradas.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      geminiCallCount?: number;
      answer: string;
      toolsUsed: string[];
    };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(body.toolsUsed).toEqual(['financial_summary']);
    expect(body.answer).toContain(brl(3500));
    expect(body.answer).toContain('3 despesas');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Informe o total');
    expect(serialized).not.toContain('Resultado esperado');
  });

  it('instrução após "?" não contamina a categoria (frase exata 2 — Supermercado)', async () => {
    registerGeminiClient(neverGemini());
    const client = detClient(
      [...supermercadoAbril(), expenseRow(400, '2026-04-05', cat('Padaria'))],
      true,
      SUPERMERCADO_CATS,
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em supermercado no mês? Informe o total e a quantidade.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      toolsUsed: string[];
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.toolsUsed).toEqual(['expenses_by_category']);
    expect(body.answer).toContain(brl(2908.39));
    expect(body.answer).toContain('18 despesas');
    expect(JSON.stringify(body)).not.toContain('Informe o total');
    expect(JSON.stringify(body)).not.toContain('informe o total e a quantidade');
    const quantidade = body.evidence.find((e) => e.label === 'Quantidade de despesas');
    expect(quantidade?.value).toBe('18');
  });

  it('"Qual mês eu mais gastei em supermercado em 2026" → abril, total, quantidade e total geral (frase exata 3)', async () => {
    const client = detClient(
      [supermercadoAbril(), expenseRow(11863.73, '2026-04-10', cat('Aluguel')), expenseRow(1200, '2026-03-05', APRIL_SUPERMERCADO)].flat(),
      true,
      SUPERMERCADO_CATS,
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question:
          'Qual mês eu mais gastei em supermercado em 2026? Informe o mês, o total, quantas despesas e o total geral de despesas desse mês.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      toolsUsed: string[];
      evidence: Array<{ label: string; value: string }>;
      period: { start: string; end: string };
    };
    expect(body.engine).toBe('deterministic');
    expect(body.toolsUsed).toEqual(['expense_monthly_aggregate']);
    expect(body.period).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(body.answer).toContain('Abril');
    expect(body.answer).toContain(brl(2908.39));
    expect(body.answer).toContain(brl(14772.12));
    expect(JSON.stringify(body)).not.toContain('Informe o mês');
    const consideradas = body.evidence.find((e) => e.label === 'Despesas consideradas');
    expect(consideradas?.value).toBe('18');
    const totalGeral = body.evidence.find((e) => e.label === 'Total geral (todas as categorias)');
    expect(totalGeral?.value).toBe(brl(14772.12));
  });

  it('espaços antes de "?" e maiúsculas com acento têm a mesma interpretação (rótulo em maiúsculas)', async () => {
    registerGeminiClient(neverGemini());
    const client = detClient(supermercadoAbril(), true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({
        question:
          'Pergunta Resultado esperado QUANTO GASTEI EM SUPERMERCADO NO MÊS ? INFORME O TOTAL E A QUANTIDADE.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(2908.39));
  });

  it('quebra de linha separa a instrução complementar', async () => {
    const client = detClient(supermercadoAbril(), true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em supermercado no mês?\nInforme o total e a quantidade.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(2908.39));
    expect(JSON.stringify(body)).not.toContain('Informe o total');
  });

  it('categoria não reconhecida → esclarecimento sem custo (nunca R$ 0,00, nunca Gemini)', async () => {
    const geminiTurns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiTurns.push(1);
        return { text: 'NUNCA', functionCalls: [] };
      },
    });
    const client = detClient(
      [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
      true,
      [catLabel('Aluguel')],
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em canudinhos em abril de 2026?',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(geminiTurns).toEqual([]);
    expect(body.answer).toContain('Não consegui identificar a categoria');
    expect(body.answer).not.toMatch(/R\$\s*0,00/);
    expect(JSON.stringify(body)).not.toContain('canudinhos');
  });

  it('categoria reconhecida com zero real → R$ 0,00 legítimo (nunca esclarecimento)', async () => {
    const client = detClient(
      [expenseRow(100, '2026-04-01', cat('Aluguel'))],
      true,
      SUPERMERCADO_CATS,
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em supermercado em abril de 2026?',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain('Não encontrei despesas');
    expect(body.answer).toContain('Alimentação > Supermercado');
    const catEv = body.evidence.find((e) => e.label === 'Alimentação > Supermercado');
    expect(catEv?.value).toBe(brl(0));
  });

  it('nenhuma das três frases exatas aciona o Gemini (prova de custo zero)', async () => {
    const geminiTurns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiTurns.push(1);
        return { text: 'NUNCA', functionCalls: [] };
      },
    });
    const scenarios: Array<{ rows: FakeLeanRow[]; cats?: FakeCategoryRow[]; question: string }> = [
      {
        rows: [expenseRow(100, '2026-04-01', cat('Aluguel'))],
        question:
          'Pergunta Resultado esperado Quanto gastei no mês? Informe o total e quantas despesas foram consideradas.',
      },
      {
        rows: [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
        cats: SUPERMERCADO_CATS,
        question:
          'Pergunta Resultado esperado Quanto gastei em supermercado no mês? Informe o total e a quantidade.',
      },
      {
        rows: [
          supermercadoAbril(),
          expenseRow(11863.73, '2026-04-10', cat('Aluguel')),
          expenseRow(1200, '2026-03-05', APRIL_SUPERMERCADO),
        ].flat(),
        cats: SUPERMERCADO_CATS,
        question:
          'Pergunta Resultado esperado Qual mês eu mais gastei em supermercado em 2026? Informe o mês, o total, quantas despesas e o total geral de despesas desse mês.',
      },
    ];
    for (const s of scenarios) {
      authOk(detClient(s.rows, true, s.cats ?? []));
      const res = await handler(postRequest({ question: s.question, period: APRIL2026 }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { engine?: string };
      expect(body.engine).toBe('deterministic');
    }
    expect(geminiTurns).toEqual([]);
  });

  it('regressão: "Quanto gastei em abril de 2026?" → R$ 14.772,12, 81 despesas e período abril', async () => {
    const rows: FakeLeanRow[] = [];
    for (let i = 0; i < 80; i += 1) {
      rows.push(expenseRow(100, '2026-04-05', cat('Aluguel')));
    }
    rows.push(expenseRow(6772.12, '2026-04-20', cat('Aluguel')));
    const client = detClient(rows);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      period: { start: string; end: string };
      periodAnalyzed: { start: string; end: string };
    };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(14772.12));
    expect(body.answer).toContain('81 despesas');
    expect(body.period).toEqual({ start: '2026-04-01', end: '2026-04-30' });
    expect(body.periodAnalyzed).toEqual({ start: '2026-04-01', end: '2026-04-30' });
  });
});

describe('PESSOAL-13C1.2 — Tolerância a erros simples e categoria hierárquica', () => {
  const SUPERMERCADO_APRIL_18: FakeLeanRow[] = (() => {
    const rows: FakeLeanRow[] = [];
    for (let i = 0; i < 17; i += 1) {
      rows.push(expenseRow(100.5, '2026-04-03', APRIL_SUPERMERCADO));
    }
    rows.push(expenseRow(1199.89, '2026-04-03', APRIL_SUPERMERCADO));
    return rows;
  })();

  // Leaf "Sem sub-categoria" ANTES do pai Supermercado (sem ORDER BY na tabela,
  // a ordem real é não-determinística — a resolução NÃO pode depender dela).
  const SUPERMERCADO_WITH_LEAF_FIRST: FakeCategoryRow[] = [
    catLabel('Alimentação', 'Alimentação'),
    catLabel('Sem sub-categoria', 'Alimentação > Supermercado > Sem sub-categoria'),
    catLabel('Supermercado', 'Alimentação > Supermercado'),
  ];

  function neverGemini(): GeminiClient {
    return {
      async sendMessage(): Promise<GeminiResponse> {
        throw new Error('Gemini NÃO pode ser chamado');
      },
    };
  }

  it('"uanto gastei no mês?" → engine=deterministic e geminiCallCount=0', async () => {
    const geminiTurns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiTurns.push(1);
        return { text: 'NUNCA', functionCalls: [] };
      },
    });
    const client = detClient(SUPERMERCADO_APRIL_18);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'uanto gastei no mês?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      geminiCallCount?: number;
      answer: string;
      toolsUsed: string[];
    };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(body.toolsUsed).toEqual(['financial_summary']);
    expect(body.answer).toContain(brl(2908.39));
    expect(geminiTurns).toEqual([]);
  });

  it.each([
    'uanto gastei no mês?',
    'qanto gastei no mês?',
    'qunto gastei no mês?',
    'quanto gastei no mês?',
    'quanto eu gastei no mês?',
    'qto gastei no mês?',
    'quanto gastei no mes?',
  ])('variações controladas de erro de uma letra: "%s" → determinística com zero Gemini', async (question) => {
    const geminiTurns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiTurns.push(1);
        return { text: 'NUNCA', functionCalls: [] };
      },
    });
    const client = detClient([expenseRow(120, '2026-04-03', APRIL_SUPERMERCADO)]);
    authOk(client);
    const res = await handler(postRequest({ question, period: APRIL2026 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      geminiCallCount?: number;
      answer: string;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(body.answer).toContain(brl(120));
    expect(geminiTurns).toEqual([]);
  });

  it('frase não financeira parecida NÃO é classificada como despesas ("quanto gastei de tempo")', async () => {
    const turns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        turns.push(1);
        return { text: 'Análise.', functionCalls: [] };
      },
    });
    authOk(detClient([]));
    const res = await handler(
      postRequest({ question: 'Quanto gastei de tempo no projeto hoje?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; geminiCallCount?: number };
    expect(body.engine).toBe('gemini');
    expect(body.geminiCallCount).toBeGreaterThanOrEqual(1);
    expect(turns).toHaveLength(1);
  });

  it('Supermercado com subcategoria nula é incluído (leaf "Sem sub-categoria" vem antes na tabela)', async () => {
    registerGeminiClient(neverGemini());
    const client = detClient(
      [...SUPERMERCADO_APRIL_18, expenseRow(400, '2026-04-05', cat('Padaria'))],
      true,
      SUPERMERCADO_WITH_LEAF_FIRST,
    );
    authOk(client);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em supermercado no mês? Informe o total e a quantidade.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      toolsUsed: string[];
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.toolsUsed).toEqual(['expenses_by_category']);
    expect(body.answer).toContain(brl(2908.39));
    expect(body.answer).toContain('18 despesas');
    expect(JSON.stringify(body)).not.toContain('Sem sub-categoria');
    const quantidade = body.evidence.find((e) => e.label === 'Quantidade de despesas');
    expect(quantidade?.value).toBe('18');
  });

  it('Supermercado com subcategoria descendente é incluído', async () => {
    registerGeminiClient(neverGemini());
    const cats = [
      catLabel('Alimentação', 'Alimentação'),
      catLabel('Hortifruti', 'Alimentação > Supermercado > Hortifruti'),
    ];
    const rows: FakeLeanRow[] = [
      expenseRow(900, '2026-04-05', cat('Hortifruti', 'Alimentação > Supermercado > Hortifruti')),
    ];
    const client = detClient(rows, true, cats);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      toolsUsed: string[];
    };
    expect(body.engine).toBe('deterministic');
    expect(body.toolsUsed).toEqual(['expenses_by_category']);
    expect(body.answer).toContain(brl(900));
    expect(body.answer).toContain('Alimentação > Supermercado');
  });

  it('categoria irmã (Padaria) não é incluída na consulta por supermercado', async () => {
    const rows: FakeLeanRow[] = [
      expenseRow(100, '2026-04-05', cat('Padaria', 'Alimentação > Padaria')),
      expenseRow(200, '2026-04-06', APRIL_SUPERMERCADO),
    ];
    const client = detClient(rows, true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(200));
    expect(body.answer).not.toContain(brl(300));
  });

  it('transferências continuam excluídas do total de supermercado', async () => {
    const rows: FakeLeanRow[] = [
      expenseRow(500, '2026-04-05', APRIL_SUPERMERCADO),
      { transaction_kind: 'transfer', amount: 9000, occurred_on: '2026-04-06', categories: APRIL_SUPERMERCADO },
    ];
    const client = detClient(rows, true, SUPERMERCADO_CATS);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(500));
    expect(body.answer).not.toContain(brl(9500));
  });

  it('agregação determinística e expense_monthly_aggregate retornam o mesmo total e quantidade (mesma fixture)', async () => {
    const fixture = SUPERMERCADO_APRIL_18;
    const client = detClient(
      fixture,
      true,
      [
        catLabel('Supermercado', 'Alimentação > Supermercado'),
        catLabel('Hortifruti', 'Alimentação > Supermercado > Hortifruti'),
      ],
    );
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      evidence: Array<{ label: string; value: string }>;
    };
    const agg = expenseMonthlyAggregate(fixture as unknown as AnalyticsTxRow[], {
      start: '2026-04-01',
      end: '2026-04-30',
      category: 'Alimentação > Supermercado',
    });
    expect(agg.hasData).toBe(true);
    expect(Math.round(agg.totalAmount * 100) / 100).toBe(2908.39);
    expect(agg.totalCount).toBe(18);
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(agg.totalAmount));
    const quantidade = body.evidence.find((e) => e.label === 'Quantidade de despesas');
    expect(quantidade?.value).toBe(String(agg.totalCount));
  });

  it('consulta anual encontra abril como vencedor com total, quantidade e total geral de abril (hierarquia com "Sem sub-categoria")', async () => {
    registerGeminiClient(neverGemini());
    const rows: FakeLeanRow[] = [
      ...SUPERMERCADO_APRIL_18,
      expenseRow(11863.73, '2026-04-10', cat('Aluguel')),
      expenseRow(1200, '2026-03-05', APRIL_SUPERMERCADO),
    ];
    const cats = [
      catLabel('Alimentação', 'Alimentação'),
      catLabel('Sem sub-categoria', 'Alimentação > Supermercado > Sem sub-categoria'),
      catLabel('Supermercado', 'Alimentação > Supermercado'),
      catLabel('Aluguel', 'Aluguel'),
    ];
    const client = detClient(rows, true, cats);
    authOk(client);
    const res = await handler(
      postRequest({
        question:
          'Qual mês eu mais gastei em supermercado em 2026? Informe o mês, o total, quantas despesas e o total geral de despesas desse mês.',
        period: APRIL2026,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      toolsUsed: string[];
      answer: string;
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.toolsUsed).toEqual(['expense_monthly_aggregate']);
    expect(body.answer).toContain('Abril');
    expect(body.answer).toContain(brl(2908.39));
    expect(body.answer).toContain(brl(14772.12));
    expect(JSON.stringify(body)).not.toContain('Sem sub-categoria');
    const consideradas = body.evidence.find((e) => e.label === 'Despesas consideradas');
    expect(consideradas?.value).toBe('18');
    const totalGeral = body.evidence.find((e) => e.label === 'Total geral (todas as categorias)');
    expect(totalGeral?.value).toBe(brl(14772.12));
  });

  it('título/evidência não contém "Sem sub-categoria" (categoria resolvida pelo path base)', async () => {
    const cats = [
      catLabel('Sem sub-categoria', 'Alimentação > Supermercado > Sem sub-categoria'),
    ];
    const rows: FakeLeanRow[] = [expenseRow(200, '2026-04-05', APRIL_SUPERMERCADO)];
    const client = detClient(rows, true, cats);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain('Alimentação > Supermercado');
    expect(body.answer).not.toContain('Sem sub-categoria');
    expect(body.answer).not.toContain('canudinhos');
  });

  it('categoria resolvida mas realmente sem movimento → R$ 0,00 legítimo (sem esclarecimento)', async () => {
    const cats = [
      catLabel('Sem sub-categoria', 'Alimentação > Supermercado > Sem sub-categoria'),
    ];
    const rows: FakeLeanRow[] = [expenseRow(100, '2026-04-01', cat('Aluguel'))];
    const client = detClient(rows, true, cats);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine?: string;
      answer: string;
      evidence: Array<{ label: string; value: string }>;
    };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain('Não encontrei despesas');
    expect(body.answer).toContain('Alimentação > Supermercado');
    expect(JSON.stringify(body)).not.toContain('Sem sub-categoria');
    const catEv = body.evidence.find((e) => e.label === 'Alimentação > Supermercado');
    expect(catEv?.value).toBe(brl(0));
  });

  it('categoria inexistente continua pedindo esclarecimento', async () => {
    const geminiTurns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiTurns.push(1);
        return { text: 'NUNCA', functionCalls: [] };
      },
    });
    const client = detClient(
      [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
      true,
      [catLabel('Aluguel')],
    );
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em canudinhos em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain('Não consegui identificar a categoria');
    expect(geminiTurns).toEqual([]);
  });

  it('nenhum cenário da C1.2 chama o Gemini (prova de custo zero)', async () => {
    const geminiTurns: number[] = [];
    registerGeminiClient({
      async sendMessage(): Promise<GeminiResponse> {
        geminiTurns.push(1);
        return { text: 'NUNCA', functionCalls: [] };
      },
    });
    const scenarios: Array<{ rows: FakeLeanRow[]; cats?: FakeCategoryRow[]; question: string }> = [
      {
        rows: [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
        question: 'uanto gastei no mês?',
      },
      {
        rows: [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
        cats: SUPERMERCADO_CATS,
        question: 'qto gastei em supermercado no mês? Informe o total e a quantidade.',
      },
      {
        rows: [expenseRow(100, '2026-04-01', cat('Alimentação'))],
        question: 'quanto eu gastei no mess?',
      },
      {
        rows: [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
        cats: [catLabel('Sem sub-categoria', 'Alimentação > Supermercado > Sem sub-categoria')],
        question: 'Quanto gastei em supermercado em abril de 2026?',
      },
      {
        rows: [expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)],
        cats: SUPERMERCADO_CATS,
        question: 'Quanto gastei em canudinhos em abril de 2026?',
      },
    ];
    for (const s of scenarios) {
      authOk(detClient(s.rows, true, s.cats ?? []));
      const res = await handler(postRequest({ question: s.question, period: APRIL2026 }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { engine?: string };
      expect(body.engine).toBe('deterministic');
    }
    expect(geminiTurns).toEqual([]);
  });

  it('regressão: período explícito e período da tela continuam corretos com variantes de uma letra', async () => {
    const clientMay = detClient([]);
    authOk(clientMay);
    const res1 = await handler(
      postRequest({ question: 'uanto gastei em maio?', period: APRIL2026 }),
    );
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as { engine?: string; period: { start: string; end: string } };
    expect(b1.engine).toBe('deterministic');
    expect(b1.period).toEqual({ start: '2026-05-01', end: '2026-05-31' });

    const clientScreen = detClient([]);
    authOk(clientScreen);
    const res2 = await handler(
      postRequest({ question: 'qanto gastei?', period: APRIL2026 }),
    );
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { engine?: string; period: { start: string; end: string } };
    expect(b2.engine).toBe('deterministic');
    expect(b2.period).toEqual(APRIL2026);
  });
});