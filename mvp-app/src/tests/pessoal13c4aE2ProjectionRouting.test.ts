// pessoal13c4aE2ProjectionRouting.test.ts — PESSOAL-13C4A-E2 (Fase 3): despacho
// dos intents de projeção *diretos* ao adapter, SEM iniciar o roteador de Gemini.
//
// Prova que:
//   1. uma pergunta representativa para cada um dos 4 intents (base, mês atual,
//      comparação mensal, categorias) chama fetchProjection e responde
//      determinístico (engine='deterministic', geminiCallCount=0);
//   2. pergunta ambígua ("Projeção", "Quero uma previsão", "E a projeção?")
//      → esclarecimento determinístico com quatro opções, ZERO consulta ao banco
//      e ZERO Gemini;
//   3. "Como ficará o fechamento do ano?" → esclarecimento (ano-calendário ×
//      próximos 12 meses), sem consulta;
//   4. mês futuro ("próximo mês", "dezembro de 2027") → explicação determinística,
//      sem inventar cálculo, sem consulta;
//   5. "projeção de supermercado" (categoria isolada) → esclarecimento nesta fase;
//   6. regressão: "Quanto gastei este mês?" continua total_expenses; growth e
//      savings continuam nos intents anteriores;
//   7. falha do adapter (ProjectionDataError) → erro controlado propagado pelo
//      contrato do endpoint (AskError → HTTP ≠ 200, sanitizado, sem Gemini, sem
//      persistir/cachear resposta), NUNCA projection_clarification; o intent
//      detectado é preservado no diagnóstico sanitizado;
//   8. full / preliminary / insufficient produzem texto determinístico;
//   9. prova no nível do endpoint (fronteira do runFinanceAsk): a resposta de
//      projeção sai com geminiCallCount=0 e o client Gemini injetado NUNCA é
//      chamado.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Congela o relógio de São Paulo para o teste de fronteira do endpoint, que não
// injeta nowISO (produção também não injeta). O resto das funções do adapter é
// preservado (fetchProjection real).
vi.mock('../../server/finance-ai/projectionAdapter', async () => {
  const actual = await import('../../server/finance-ai/projectionAdapter');
  return {
    ...actual,
    saoPauloTodayISO: () => '2026-08-10',
  };
});

import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import {
  setSanitizedSuccessSink,
  setSanitizedEventSink,
  OBSERVABILITY_FIELDS,
} from '../../server/finance-ai/observability';
import { addMonths } from '../../src/lib/period';

const NOW = '2026-08-10';

interface ProjRow {
  transaction_kind?: string | null;
  amount?: number | string | null;
  account_id?: string | null;
  category_id?: string | null;
  occurred_on?: string | null;
  status?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
}

const PAD2 = (v: number) => String(v).padStart(2, '0');

function cat(label: string): Array<{ display_name: string; canonical_path: string | null }> {
  return [{ display_name: label, canonical_path: null }];
}

function expRow(
  occurred_on: string,
  amount: number,
  category: 'mercado' | 'transporte' | 'anchor',
): ProjRow {
  const alias = category === 'mercado' ? 'c-mercado' : category === 'transporte' ? 'c-transporte' : 'c-anchor';
  const label =
    category === 'mercado' ? 'Mercado' : category === 'transporte' ? 'Transporte' : 'Anchor';
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: alias,
    occurred_on,
    status: 'paid',
    categories: cat(label),
  };
}

/** 12 meses cheios na janela (ago/2025..jul/2026) + âncora antiga + agosto atual. */
function fullRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2025-01-10', 1000, 'anchor')];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 8 }, i);
    const catName = i % 2 === 0 ? 'mercado' : 'transporte';
    rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1000, catName));
  }
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

/** Cobertura só de jan/2026..jul/2026 (7 meses) → preliminary. */
function preliminaryRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2026-01-10', 1000, 'anchor')];
  for (let i = 0; i < 7; i++) {
    const ym = addMonths({ year: 2026, month: 1 }, i);
    rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1000, 'mercado'));
  }
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

/** Cobertura só de jun/2026 e jul/2026 (2 meses) → insufficient. */
function insufficientRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2026-06-10', 1000, 'anchor')];
  rows.push(expRow('2026-06-15', 1000, 'mercado'));
  rows.push(expRow('2026-07-15', 1000, 'transporte'));
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

/**
 * Client Supabase determinístico com `range`/`count`, roteando por tabela.
 * Aplica os ordens registrados (só o id importa para estabilidade) antes do
 * slice, como o postgREST real.
 */
function projClient(
  rows: ProjRow[],
  opts: { periods?: ProjRow[]; failTransactions?: boolean } = {},
): { fake: unknown; tables: string[] } {
  const tables: string[] = [];
  const sourceOf = (table: string) =>
    table === 'transactions' ? rows : opts.periods ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    for (const m of ['is', 'neq', 'gte', 'lte', 'eq', 'in', 'order', 'limit', 'ilike'] as const) {
      c[m] = () => c;
    }
    c.select = (sel?: string, _opts?: { count?: 'exact' }) => {
      void sel;
      return c;
    };
    c.range = (from: number, to: number) => {
      const ordered = [...sourceOf(table)].sort((a, b) =>
        (a.occurred_on ?? '').localeCompare(b.occurred_on ?? ''),
      );
      const page = ordered.slice(from, to + 1);
      const failed = table === 'transactions' && opts.failTransactions === true;
      return {
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: failed ? null : page,
            error: failed ? { message: 'erro simulado do postgrest' } : null,
            count: failed ? null : ordered.length,
          }),
      };
    };
    c.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: sourceOf(table), error: null });
    return c;
  };
  return {
    fake: {
      from: (t: string) => {
        tables.push(t);
        return base(t);
      },
    },
    tables,
  };
}

function brlReais(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** 12 meses cheios jul/2025..jun/2026 + mês passado (jul/2026) com valor configurável + agosto atual. */
function pastRows(julyAmount: number): ProjRow[] {
  const rows: ProjRow[] = [expRow('2025-01-10', 1000, 'anchor')];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 7 }, i);
    const catName = i % 2 === 0 ? 'mercado' : 'transporte';
    rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1000, catName));
  }
  rows.push(expRow('2026-07-15', julyAmount, 'transporte'));
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

/** Média mensal com decimais (1234,56/mês) para validar a forma pt-BR (milhar+vírgula). */
function formatRows(): ProjRow[] {
  const rows: ProjRow[] = [expRow('2025-01-10', 1234.56, 'anchor')];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 8 }, i);
    rows.push(expRow(`${ym.year}-${PAD2(ym.month)}-15`, 1234.56, 'mercado'));
  }
  rows.push(expRow('2026-08-05', 500, 'mercado'));
  return rows;
}

function moneyTokens(text: string): string[] {
  return text.match(/R\$\s?\d[\d.]*,\d{2}/g) ?? [];
}

/** Conjunto de valores monetários (pt-BR) que aparecem no ProjectionPayloadV1. */
function payloadMoneyValues(proj: unknown): string[] {
  const out: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (v: unknown) => {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) out.push(brlReais(v / 100));
  };
  if (!proj || typeof proj !== 'object') return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = proj as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = p.summary as any;
  if (summary) {
    add(summary.monthlyMeanCents);
    add(summary.annualScenarioCents);
    add(summary.totalBaseCents);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comparison = p.comparison as any;
  if (comparison) {
    add(comparison.referenceCents);
    add(comparison.realizedCents);
    add(comparison.expectedToDateCents);
    add(comparison.futureRegisteredCents);
    add(comparison.committedCents);
    if (comparison.closingProjectionCents !== null) add(comparison.closingProjectionCents);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const categories = Array.isArray(p.categories) ? (p.categories as any[]) : [];
  for (const c of categories) {
    add(c.monthlyMeanCents);
    add(c.annualScenarioCents);
    add(c.realizedCents);
    add(c.referenceCents);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remaining = p.remaining as any;
  if (remaining) {
    add(remaining.monthlyMeanCents);
    add(remaining.annualScenarioCents);
  }
  // PESSOAL-13C4A-E6: todos os valores monetários do forecast (resumo + os 12
  // meses) entram na allowlist que o texto pode citar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forecast = p.forecast as any;
  if (forecast) {
    if (forecast.summary) {
      add(forecast.summary.historicalReferenceCents);
      add(forecast.summary.registeredCents);
      add(forecast.summary.estimatedRemainingCents);
      add(forecast.summary.projectedCents);
    }
    const months = Array.isArray(forecast.months) ? (forecast.months as any[]) : [];
    for (const m of months) {
      add(m.registeredCents);
      add(m.estimatedRemainingCents);
      add(m.projectedCents);
      add(m.historicalReferenceCents);
    }
  }
  return out;
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

function countingGemini(): { client: GeminiClient; calls: number } {
  const state = { calls: 0 };
  const client: GeminiClient = {
    async sendMessage(): Promise<GeminiResponse> {
      state.calls += 1;
      throw new Error('Gemini NÃO pode ser chamado para projeção');
    },
  };
  return { client, calls: state.calls };
}

function postRequest(body: unknown): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-valido' },
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

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  setSanitizedSuccessSink(null);
});

afterEach(() => {
  setSanitizedSuccessSink(null);
  setSanitizedEventSink(null);
  registerGeminiClient(null);
});

describe('PESSOAL-13C4A-E2 — intents de projeção (determinístico, despacho ao adapter)', () => {
  it('base: "Qual a previsão de gastos para os próximos 12 meses?"', async () => {
    const { fake, tables } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a previsão de gastos para os próximos 12 meses?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_base');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.answer).toContain('sem garantia nem recomendação');
    expect(ans?.response.answer).toContain(brlReais(1000));
    expect(ans?.response.answer).toContain(brlReais(12000));
    expect(ans?.response.answer).toContain(brlReais(0));
    expect(ans?.response.answer).toContain('12 meses cobertos');
    expect(ans?.response.answer).toContain('cenário projetado');
    expect(ans?.response.answer).not.toContain('cenário anualizado');
    expect(ans?.response.answer).not.toContain('melhor');
    expect(ans?.response.answer).not.toContain('pior');
    expect(tables).toContain('transactions');
    expect(tables).toContain('account_profile_periods');
  });

  it('mês atual: "Quanto vou fechar o mês?" → o mês inteiro contra a média mensal (sem ritmo)', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Quanto vou fechar o mês?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_current_month');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.answer).toContain(brlReais(500));
    expect(ans?.response.answer).toContain('contra a média mensal de ' + brlReais(1000) + ' dos 12 meses anteriores');
    expect(ans?.response.answer).toContain('abaixo da média mensal');
    expect(ans?.response.answer).toContain('Novos lançamentos ainda podem alterar o total do mês.');
    expect(ans?.response.answer).not.toContain('esperado proporcional');
    expect(ans?.response.answer).not.toContain('fechamento estimado do mês é de');
    expect(ans?.response.answer).not.toContain('ritmo');
    expect(ans?.response.answer).not.toContain('comprometido');
  });

  it('comparação: "Qual a previsão para o mês passado comparada à média dos 12 anteriores?"', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Qual a previsão para o mês passado comparada à média dos 12 meses anteriores?',
      nowISO: NOW,
    });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_month_comparison');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.answer).toContain('julho de 2026');
    expect(ans?.response.answer).toContain('média mensal');
    expect(ans?.response.answer).toContain('acima da referência');
  });

  it('categorias: "Qual a projeção por categorias?" → projeção geral por categorias', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a projeção por categorias?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_categories');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.answer).toContain('Categorias de maior peso');
    expect(ans?.response.answer).toContain('Mercado');
    expect(ans?.response.answer).toContain('Transporte');
  });
});

describe('PESSOAL-13C4A-E2 — esclarecimento/regras da Fase 3 (zero consulta)', () => {
  it.each(['Projeção.', 'Quero uma previsão.', 'E a projeção?'])(
    'ambiguidade "%s" → esclarecimento com quatro opções, zero banco e zero Gemini',
    async (q) => {
      const { fake, tables } = projClient(fullRows());
      const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
      expect(ans).not.toBeNull();
      expect(ans?.intent).toBe('projection_clarification');
      expect(ans?.response.engine).toBe('deterministic');
      expect(ans?.response.geminiCallCount).toBe(0);
      expect(ans?.response.answer).toContain('quatro cenários');
      expect(tables).toHaveLength(0);
    },
  );

  it('"Como ficará o fechamento do ano?" → esclarece ano-calendário × próximos 12 meses', async () => {
    const { fake, tables } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Como ficará o fechamento do ano?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_clarification');
    expect(ans?.response.answer).toContain('ano-calendário');
    expect(ans?.response.answer).toContain('próximos 12 meses');
    expect(tables).toHaveLength(0);
  });

  it.each(['Qual a previsão para o próximo mês?', 'Qual a projeção para dezembro de 2027?'])(
    'mês futuro "%s" → explicação determinística, sem cálculo e sem banco',
    async (q) => {
      const { fake, tables } = projClient(fullRows());
      const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
      expect(ans).not.toBeNull();
      expect(ans?.intent).toBe('projection_clarification');
      expect(ans?.response.engine).toBe('deterministic');
      expect(ans?.response.geminiCallCount).toBe(0);
      expect(ans?.response.answer).toContain('meses futuros');
      expect(tables).toHaveLength(0);
    },
  );

  it('"Projeção do supermercado?" (categoria isolada) → esclarecimento nesta fase', async () => {
    const { fake, tables } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Projeção do supermercado?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_clarification');
    expect(ans?.response.answer).toContain('categoria isolada');
    expect(tables).toHaveLength(0);
  });
});

describe('PESSOAL-13C4A-E2 — qualidade full/preliminary/insufficient e falha do adapter', () => {
  it('cobertura total (full) → sem aviso preliminar', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a previsão de gastos para os próximos 12 meses?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_base');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.answer).not.toContain('preliminar');
  });

  it('7 meses cobertos (preliminary) → resposta determinística com aviso', async () => {
    const { fake } = projClient(preliminaryRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a previsão de gastos para os próximos 12 meses?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.answer).toContain('base preliminar');
    expect(ans?.response.answer).toContain('6 dos 12 meses');
  });

  it('2 meses cobertos (insufficient) → texto determinístico sem projeção', async () => {
    const { fake } = projClient(insufficientRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a previsão de gastos para os próximos 12 meses?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.answer).toContain('não há dados suficientes para projetar');
    expect(ans?.response.answer).toContain('1 de 12 meses');
    expect(ans?.response.answer).toContain('mínimo de 6');
    expect(moneyTokens(ans?.response.answer ?? '')).toHaveLength(0);
    expect(ans?.response.answer).not.toContain('/mês');
  });

  it('falha do adapter (ProjectionDataError) → erro controlado propagado (nunca clarification) com intent preservado', async () => {
    const { fake } = projClient(fullRows(), { failTransactions: true });
    const promise = runDeterministicAsk({
      supabase: fake as never,
      question: 'Qual a previsão de gastos para os próximos 12 meses?',
      nowISO: NOW,
    });
    await expect(promise).rejects.toMatchObject({
      name: 'AskError',
      message: 'ask-failure',
      intent: 'projection_base',
      classification: { category: 'supabase_query_error', retryable: false },
});
});
});

describe('PESSOAL-13C4A-E2 — textos pt-BR por intent derivados exclusivamente do ProjectionPayloadV1', () => {
  it('current: o total não depende do dia do todayISO (06/08 e 10/08 → idêntico), sem aviso de 7º dia', async () => {
    const extra = expRow('2026-08-09', 300, 'transporte');
    const a6 = await runDeterministicAsk({
      supabase: projClient([...fullRows(), extra]).fake as never,
      question: 'Quanto vou fechar o mês?',
      nowISO: '2026-08-06',
    });
    const a10 = await runDeterministicAsk({
      supabase: projClient([...fullRows(), extra]).fake as never,
      question: 'Quanto vou fechar o mês?',
      nowISO: '2026-08-10',
    });
    expect(a6).not.toBeNull();
    expect(a10).not.toBeNull();
    expect(a6?.intent).toBe('projection_current_month');
    // 500 (05/08) + 300 (09/08) = 800 no MÊS INTEIRO, em ambos os dias.
    expect(a6?.response.answer).toContain(brlReais(800));
    expect(a6?.response.answer).toBe(a10?.response.answer);
    expect(a6?.response.answer).not.toContain('Ainda é cedo');
    expect(a6?.response.answer).not.toContain('7º dia');
  });

  it('current: todos os lançamentos do mês entram no total, inclusive os de data posterior a hoje', async () => {
    const { fake } = projClient([...fullRows(), expRow('2026-08-09', 300, 'transporte')]);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quanto vou fechar o mês?',
      nowISO: '2026-08-06',
    });
    expect(ans).not.toBeNull();
    // 500 (05/08) + 300 (09/08, após o todayISO) = 800 no total do mês.
    expect(ans?.response.answer).toContain(brlReais(800));
    expect(ans?.response.answer).not.toContain('futuros');
    expect(ans?.response.answer).not.toContain('comprometido');
    expect(ans?.response.answer).not.toContain('realizado até hoje');
    expect(ans?.response.answer).not.toContain('ritmo');
  });

  it.each([
    { name: 'acima', july: 1500, verb: 'acima da referência' },
    { name: 'abaixo', july: 500, verb: 'abaixo da referência' },
    { name: 'igual', july: 1000, verb: 'igual à referência' },
  ])('mês passado $name: direção neutra ($verb), sem melhor/pior', async ({ july, verb }) => {
    const { fake } = projClient(pastRows(july));
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Qual a previsão para o mês passado comparada à média dos 12 meses anteriores?',
      nowISO: NOW,
    });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('projection_month_comparison');
    expect(ans?.response.answer).toContain(verb);
    expect(ans?.response.answer).toContain(brlReais(july));
  });

  it('categorias: resumo curto das principais categorias, sem repetir a lista completa', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a projeção por categorias?', nowISO: NOW });
    expect(ans).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proj = (ans?.response as any)?.projection;
    const categories = Array.isArray(proj?.categories) ? (proj.categories as Array<{ label: string }>) : [];
    expect(categories.length).toBeGreaterThan(0);
    expect(ans?.response.answer).toContain('Categorias de maior peso');
    const mentioned = categories.filter((c) => (ans?.response.answer ?? '').includes(c.label));
    expect(mentioned.length).toBeLessThanOrEqual(2);
  });

  it('formatação monetária pt-BR: milhar com ponto e decimal com vírgula', async () => {
    const { fake } = projClient(formatRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a previsão de gastos para os próximos 12 meses?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.response.answer).toContain(brlReais(1234.56));
    expect(ans?.response.answer).toContain(brlReais(14814.72));
  });

  it('sem "melhor"/"pior", sem IDs e nenhum valor monetário fora do payload', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Qual a previsão de gastos para os próximos 12 meses?', nowISO: NOW });
    expect(ans).not.toBeNull();
    const answer = ans?.response.answer ?? '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proj = (ans?.response as any)?.projection;
    expect(proj).toBeDefined();
    expect(answer.toLowerCase()).not.toContain('melhor');
    expect(answer.toLowerCase()).not.toContain('pior');
    expect(answer).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    const allowed = payloadMoneyValues(proj);
    const tokens = moneyTokens(answer);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => allowed.includes(t))).toBe(true);
  });
});

describe('PESSOAL-13C4A-E2 — regressão dos intents existentes', () => {
  it('"Quanto gastei este mês?" continua total_expenses', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Quanto gastei este mês?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('total_expenses');
    expect(ans?.response.engine).toBe('deterministic');
  });

  it('growth continua no intent anterior', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde meus gastos aumentaram significativamente nos últimos 6 meses?',
      nowISO: NOW,
    });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('growth_categories');
    expect(ans?.response.engine).toBe('deterministic');
  });

  it('savings continua no intent anterior', async () => {
    const { fake } = projClient(fullRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E se eu reduzisse meus gastos em 10%?',
      nowISO: NOW,
    });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
  });
});

describe('PESSOAL-13C4A-E2 — fronteira do endpoint (runFinanceAsk nunca é alcançado)', () => {
  it('pergunta de projeção → resposta determinística com geminiCallCount=0 e Gemini não chamado', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const { fake } = projClient(fullRows());
    authOk(fake);

    const res = await handler(
      postRequest({ question: 'Qual a previsão de gastos para os próximos 12 meses?' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      engine?: string;
      geminiCallCount?: number;
      toolsUsed?: string[];
    };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(body.toolsUsed).toContain('projection');
    expect(gem.calls).toBe(0);
  });

  it('pergunta de projeção ambígua também sai determinística sem chamar Gemini', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const { fake } = projClient(fullRows());
    authOk(fake);

    const res = await handler(postRequest({ question: 'E a projeção?' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; geminiCallCount?: number };
    expect(body.engine).toBe('deterministic');
    expect(body.geminiCallCount).toBe(0);
    expect(gem.calls).toBe(0);
  });

  it('falha do adapter → erro controlado (502), sem payload de assistente, sem Gemini, mensagem bruta ausente e intent no diagnóstico sanitizado', async () => {
    const gem = countingGemini();
    registerGeminiClient(gem.client);
    const captured: unknown[] = [];
    setSanitizedEventSink((e) => captured.push(e));
    const { fake } = projClient(fullRows(), { failTransactions: true });
    authOk(fake);

    const res = await handler(
      postRequest({ question: 'Qual a previsão de gastos para os próximos 12 meses?' }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('erro simulado');
    expect(text).not.toContain('postgrest');
    const body = JSON.parse(text) as {
      error?: string;
      message?: string;
      answer?: unknown;
      toolsUsed?: unknown;
      cards?: unknown;
      periodAnalyzed?: unknown;
    };
    expect(body.answer).toBeUndefined();
    expect(body.toolsUsed).toBeUndefined();
    expect(body.cards).toBeUndefined();
    expect(body.periodAnalyzed).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(body.message).toBeDefined();
    expect(gem.calls).toBe(0);

    const failure = captured.filter(
      (e) => (e as { event?: string }).event === 'ask_failure',
    );
    expect(failure).toHaveLength(1);
    expect((failure[0] as { intent?: string }).intent).toBe('projection_base');
    expect((failure[0] as { httpStatus?: number }).httpStatus).toBe(502);
    expect(
      Object.keys(failure[0] as object).every((k) =>
        (OBSERVABILITY_FIELDS as readonly string[]).includes(k),
      ),
    ).toBe(true);
  });
});