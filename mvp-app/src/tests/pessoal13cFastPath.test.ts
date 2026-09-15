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

/**
 * Client Supabase determinístico com paginação (range + count exact). Quando
 * `withRange` é false, simula a interface sem paginação (busca única).
 */
function detClient(rows: FakeLeanRow[], withRange = true): { from: (t: string) => unknown; calls: string[][] } {
  const calls: string[][] = [];
  const base = (): Record<string, unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    for (const m of ['select', 'is', 'gte', 'lte', 'order', 'ilike', 'limit'] as const) {
      c[m] = () => c;
    }
    if (withRange) {
      c.range = (from: number, to: number) => {
        const page = rows.slice(from, to + 1);
        return {
          ...c,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: page, count: rows.length, error: null }),
        };
      };
    } else {
      c.range = undefined;
    }
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    return c;
  };
  return {
    from: (t: string) => {
      calls.push([t]);
      return base();
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
  });
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function cat(name: string, path: string | null = null): Array<{ display_name: string; canonical_path: string | null }> {
  return [{ display_name: name, canonical_path: path }];
}

function expenseRow(amount: number, occurredOn: string, categories?: FakeLeanRow['categories']): FakeLeanRow {
  return { transaction_kind: 'expense', amount, occurred_on: occurredOn, categories };
}

const APRIL_SUPERMERCADO = cat('Supermercado', 'Alimentação > Supermercado');
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
    const client = detClient([
      expenseRow(2908.39, '2026-04-03', APRIL_SUPERMERCADO),
      expenseRow(123, '2026-04-04', APRIL_SUPERMERCADO),
      expenseRow(500, '2026-04-05', cat('Padaria')),
    ]);
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
        (e) => e.label === 'Alimentação > Supermercado' && e.value === brl(2908.39 + 123),
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
    const client = detClient([
      // Supermercado em abril: vence o mês
      expenseRow(2908.39, '2026-04-03', APRIL_SUPERMERCADO),
      expenseRow(600, '2026-04-28', APRIL_SUPERMERCADO),
      // Outras categorias em abril (total geral abril)
      expenseRow(14772.12 - 2908.39 - 600, '2026-04-10', cat('Aluguel')),
      // Março com menos em supermercado
      expenseRow(1200, '2026-03-05', APRIL_SUPERMERCADO),
    ]);
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
    const client = detClient([
      expenseRow(500, '2026-03-05', APRIL_SUPERMERCADO),
      expenseRow(500, '2026-04-05', APRIL_SUPERMERCADO),
    ]);
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
    const client = detClient([expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)]);
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
    const client = detClient([expenseRow(2908.39, '2026-04-03', APRIL_SUPERMERCADO)]);
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
    const client = detClient([expenseRow(100, '2026-04-01', APRIL_SUPERMERCADO)]);
    authOk(client);
    const res = await handler(
      postRequest({ question: 'Quanto gastei em supermercado em abril de 2026?', period: APRIL2026 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string };
    expect(body.answer).not.toMatch(/[*_#>`]/);
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