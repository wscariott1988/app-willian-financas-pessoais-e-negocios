// pessoal13c4aE3ProjectionRouting.test.ts — PESSOAL-13C4A-E3 (Fase 7): follow-ups
// CONTEXTUAIS das projeções — lente de categoria, novo mês de referência,
// troca de visão, esclarecimentos determinísticos e rota direct|follow_up.
//
// Nível: roteador determinístico (runDeterministicAsk) com contexto de projeção
// pré-persistido (como se um turno anterior tivesse gravado via contextFromTurn).
//
// Regras provadas por seção:
//   10.1  explicit não elíptico → direct, sem vazar lente do contexto;
//   10.2  ambientação dos valores da fixture (base full sem lente);
//   10.3-10.4 E2 preservado: sem contexto, "Projeção" ambígua e categoria isolada
//        continuam esclarecimentos determinísticos, sem consulta financeira;
//   10.5-10.9 clarificação contextual: ambiguous rerun, clear-lens, lente
//        de categoria resolvida, lente desconhecida → unknown_lens;
//   10.10-10.12 follow-up explícito elíptico ("E o fechamento?", "E a projeção
//        por categorias?"): preserva lente/ref e reaplica as regras de mês;
//   10.13-10.19 lentes elípticas ("E só supermercado?", "E com transporte?",
//        "E sem categoria?", "E sem filtro?", "E supermercado?") e rejeição
//        por valores financeiros/termo desconhecido;
//   10.20-10.24 mudança de mês elíptica + esclarecimentos futuro/reference_month;
//   10.25 mês+lente combinado → a lente prevalece;
//   10.26 falha de infraestrutura no follow-up → erro controlado (AskError,
//        intent do contexto preservado), nunca clarification;
//   10.27 outro turno não-projeção (total_expenses) NUNCA passa pelo follow-up
//        de projeção (regressão de precedência);
//   10.28 topa o payload: lens só com rótulo de exibição, ausente sem lente.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import {
  setSanitizedSuccessSink,
  setSanitizedEventSink,
} from '../../server/finance-ai/observability';
import { addMonths } from '../../src/lib/period';
import type { ChatContextState } from '../../server/chat/chatTypes';

const NOW = '2026-08-10';

// ── Fixture: 12 meses cobertos (ago/2025..jul/2026) + mês atual ────────
// Mercado = 'Alimentação > Supermercado'; Transporte = 'Transporte';
// há também despesa sem categoria no mês atual.

interface ProjRow {
  transaction_kind?: string | null;
  amount?: number | string | null;
  account_id?: string | null;
  category_id?: string | null;
  occurred_on?: string | null;
  status?: string | null;
  deleted_at?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
}

interface CatFakeRow {
  display_name: string;
  canonical_path: string | null;
  direction?: string;
}

const PAD2 = (v: number) => String(v).padStart(2, '0');

const EXPENSE_CATS: CatFakeRow[] = [
  { display_name: 'Alimentação', canonical_path: 'Alimentação', direction: 'expense' },
  { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado', direction: 'expense' },
  { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria', direction: 'expense' },
  { display_name: 'Transporte', canonical_path: 'Transporte', direction: 'expense' },
];

function catRow(label: string, path: string) {
  return [{ display_name: label, canonical_path: path }];
}

function supRow(occurredOn: string, amount: number): ProjRow {
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: 'c-supermercado',
    occurred_on: occurredOn,
    status: 'paid',
    categories: catRow('Mercado', 'Alimentação > Supermercado'),
  };
}

function traRow(occurredOn: string, amount: number): ProjRow {
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: 'c-transporte',
    occurred_on: occurredOn,
    status: 'paid',
    categories: catRow('Transporte', 'Transporte'),
  };
}

function uncRow(occurredOn: string, amount: number): ProjRow {
  return {
    transaction_kind: 'expense',
    amount,
    account_id: 'acc-a',
    category_id: null,
    occurred_on: occurredOn,
    status: 'paid',
    categories: null,
  };
}

/** 12 meses cheios na janela (ago/2025..jul/2026): mercado nos pares, transporte nos ímpares. */
function fullRows(): ProjRow[] {
  const rows: ProjRow[] = [supRow('2025-01-10', 1000)];
  for (let i = 0; i < 12; i++) {
    const ym = addMonths({ year: 2025, month: 8 }, i);
    rows.push((i % 2 === 0 ? supRow : traRow)(`${ym.year}-${PAD2(ym.month)}-15`, 1000));
  }
  rows.push(supRow('2026-08-05', 500));
  rows.push(uncRow('2026-08-08', 100));
  return rows;
}

const FULL_PERIOD = [{ account_id: 'acc-a', starts_on: '2025-08-01', ends_on: null }];

function mkClient(
  rows: ProjRow[],
  opts: { periods?: ProjRow[]; cats?: CatFakeRow[] } = {},
): { fake: unknown; tables: string[] } {
  const tables: string[] = [];
  const cats = opts.cats ?? EXPENSE_CATS;
  const periods = opts.periods ?? FULL_PERIOD;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    const filters: Array<{ op: string; key: string; value: unknown }> = [];
    for (const m of ['is', 'neq', 'gte', 'lte', 'eq', 'in', 'order', 'limit', 'ilike'] as const) {
      c[m] = (k?: string, v?: unknown) => {
        if ((m === 'is' || m === 'neq' || m === 'gte' || m === 'lte' || m === 'eq') && typeof k === 'string') {
          filters.push({ op: m, key: k, value: v as string | null });
        } else if (m === 'in' && typeof k === 'string') {
          filters.push({ op: m, key: k, value: v });
        }
        return c;
      };
    }
    c.select = (sel?: string, opts2?: { count?: 'exact' }) => {
      void sel;
      void opts2;
      return c;
    };
    const store = table === 'categories' ? cats : table === 'transactions' ? rows : periods;
    const matches = (r: ProjRow | CatFakeRow): boolean =>
      filters.every((f) => {
        const v = (r as Record<string, unknown>)[f.key];
        if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
        if (f.op === 'neq') return v !== f.value;
        if (f.op === 'eq') return v === f.value;
        if (f.op === 'in') {
          return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
        }
        if (f.op === 'gte') return v !== null && v !== undefined && String(v) >= String(f.value);
        if (f.op === 'lte') return v !== null && v !== undefined && String(v) <= String(f.value);
        return true;
      });
    const filtered = () => store.filter((r) => matches(r));
    c.range = (from: number, to: number) => {
      const page = filtered().slice(from, to + 1);
      return {
        ...c,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, count: filtered().length, error: null }),
      };
    };
    c.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: filtered(), error: null });
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

function projectionContext(opts: {
  intent: 'projection_base' | 'projection_current_month' | 'projection_month_comparison' | 'projection_categories';
  referenceMonth?: string;
  lensKind?: 'category' | 'uncategorized';
  lensPath?: string;
  lensLabel?: string | null;
}): ChatContextState {
  const projection: ChatContextState['projection'] = {
    version: 1,
    intent: opts.intent,
    referenceMonth: opts.referenceMonth ?? '2026-08',
  };
  if (opts.lensKind !== undefined) {
    projection.lensKind = opts.lensKind;
    projection.lensLabel = opts.lensLabel ?? null;
    if (opts.lensPath) projection.lensPath = opts.lensPath;
  }
  return { category: null, intent: null, period: null, summaries: [], projection };
}

async function ask(
  q: string,
  ctx?: ChatContextState,
): Promise<DeterministicAnswer> {
  const { fake } = mkClient(fullRows());
  const ans = await runDeterministicAsk({
    supabase: fake as never,
    question: q,
    context: ctx,
    nowISO: NOW,
  });
  if (!ans) throw new Error(`esperado determinístico para: "${q}"`);
  return ans;
}

// Acessos livres ao payload de projeção da resposta; a forma canônica exata é
// coberta pelo sanitizador (idempotência/allowlist), não pela tipagem aqui.
function projOf(ans: { response: { projection?: unknown } }): Record<string, unknown> {
  return (ans.response.projection ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(null);
  setSanitizedSuccessSink(null);
});

afterEach(() => {
  setSanitizedSuccessSink(null);
  setSanitizedEventSink(null);
  registerGeminiClient(null);
});

describe('PESSOAL-13C4A-E3 — projeções contextuais (Fase 7)', () => {
  describe('10.1-10.4 — precedência: explícito direto e E2 intacto sem contexto', () => {
    it('10.1 explicit não elíptico com contexto de projeção → DIRECT, sem vazar a lente do contexto', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('Qual a previsão de gastos para os próximos 12 meses?', ctx);
      expect(ans.projectionRoute).toBe('direct');
      expect(ans.projection?.lensKind).toBeUndefined();
      expect(typeof ans.response.projection).toBe('object');
      expect(projOf(ans).lens).toBeUndefined();
      expect(ans.response.answer).toContain(brlReais(1000));
    });

    it('10.2 ambientação: base full sem lente → média R$ 1000, categoria Mercado e Transporte', async () => {
      const ans = await ask('Qual a previsão de gastos para os próximos 12 meses?');
      expect(ans.intent).toBe('projection_base');
      expect(ans.response.answer).toContain(brlReais(1000));
      expect(ans.response.answer).toContain('12 meses cobertos');
    });

    it('10.3 sem contexto: "Projeção" → esclarecimento ambíguo determinístico, sem banco', async () => {
      const { fake, tables } = mkClient(fullRows());
      const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Projeção', nowISO: NOW });
      expect(ans).not.toBeNull();
      expect(ans?.intent).toBe('projection_clarification');
      expect(ans?.response.projection).toBeUndefined();
      expect(tables).toHaveLength(0);
    });

    it('10.4 sem contexto: "Projeção do supermercado?" → esclarecimento de categoria (E2 intacto)', async () => {
      const { fake, tables } = mkClient(fullRows());
      const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Projeção do supermercado?', nowISO: NOW });
      expect(ans).not.toBeNull();
      expect(ans?.intent).toBe('projection_clarification');
      expect(ans?.response.answer).toContain('categoria isolada');
      expect(tables).toHaveLength(0);
    });
  });

  describe('10.5-10.9 — clarificação contextual: ambiguous, clear-lens e lente resolvida', () => {
    it('10.5 "E a projeção?" com contexto base → rerun determinístico (follow_up) re-consultando finanças', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E a projeção?', ctx);
      expect(ans.intent).toBe('projection_base');
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.response.answer).toContain(brlReais(1000));
    });

    it('10.6 "E a projeção sem filtro?" com lente ativa → rerun SEM lente (clear-lens)', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('E a projeção sem filtro?', ctx);
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensKind).toBeUndefined();
      expect(ans.response.answer).toContain(brlReais(1000));
    });

    it('10.7 "Projeção do supermercado?" com contexto → lente resolvida, base restrita (follow_up)', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('Projeção do supermercado?', ctx);
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensKind).toBe('category');
      expect(ans.projection?.lensPath).toBe('Alimentação > Supermercado');
      expect(ans.projection?.lensLabel).toBe('Supermercado');
      const proj = projOf(ans);
      expect((proj.lens as { label: string }).label).toBe('Supermercado');
      expect(ans.response.answer).toContain(brlReais(500));
    });

    it('10.8 "E sem categoria?" com contexto → lente uncategorized, re-deriva os agregados', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E sem categoria?', ctx);
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensKind).toBe('uncategorized');
      const proj = projOf(ans);
      expect((proj.lens as { label: string }).label).toBe('Sem categoria');
      // só a despesa sem categoria do mês atual entra no realizado da base.
      const summary = proj.summary as { monthlyMeanCents: number };
      expect(summary.monthlyMeanCents).toBe(0);
    });

    it('10.9 "Projeção do alfafa?" com contexto → esclarecimento unknown_lens, sem projeção', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('Projeção do alfafa?', ctx);
      expect(ans.intent).toBe('projection_clarification');
      expect(ans.response.answer).toContain('supermercado, transporte ou aluguel');
      expect(ans.response.projection).toBeUndefined();
    });
  });

  describe('10.10-10.12 — follow-up explícito elíptico preserva lente e referência', () => {
    it('10.10 "E o fechamento?" com contexto base → current_month, follow_up, lente preservada', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('E o fechamento?', ctx);
      expect(ans.intent).toBe('projection_current_month');
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensKind).toBe('category');
      const proj = projOf(ans);
      expect((proj.lens as { label: string }).label).toBe('Supermercado');
      // realizedo de agosto com lente: 500 (Mercado), sem a sem-categoria (100).
      const comparison = proj.comparison as { realizedCents: number };
      expect(comparison.realizedCents).toBe(50000);
    });

    it('10.11 "E o fechamento?" com contexto current_month + mês passado explícito → esclarecimento reference_month', async () => {
      const ctx = projectionContext({ intent: 'projection_current_month' });
      const ans = await ask('E o fechamento no mês passado?', ctx);
      expect(ans.intent).toBe('projection_clarification');
      expect(ans.response.answer).toContain('fechamento estimado vale para o mês atual');
      expect(ans.response.projection).toBeUndefined();
    });

    it('10.12 "E a projeção por categorias?" com contexto → categories, follow_up, lente preservada', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('E a projeção por categorias?', ctx);
      expect(ans.intent).toBe('projection_categories');
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensLabel).toBe('Supermercado');
      const proj = projOf(ans);
      expect((proj.lens as { label: string }).label).toBe('Supermercado');
    });
  });

  describe('10.13-10.19 — lentes elípticas e rejeições', () => {
    it('10.13 "E só supermercado?" com contexto base → lente resolver via categories (follow_up)', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E só supermercado?', ctx);
      expect(ans.intent).toBe('projection_base');
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensPath).toBe('Alimentação > Supermercado');
      const proj = projOf(ans);
      expect((proj.lens as { label: string }).label).toBe('Supermercado');
      expect(ans.response.answer).toContain(brlReais(500));
    });

    it('10.14 "E com transporte?" → lente diferente troca a lente do contexto', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('E com transporte?', ctx);
      expect(ans.projection?.lensPath).toBe('Transporte');
      expect(ans.projection?.lensLabel).toBe('Transporte');
    });

    it('10.15 "E supermercado?" (sem a palavra "só") também vira lente', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E supermercado?', ctx);
      expect(ans.projection?.lensKind).toBe('category');
      expect(ans.projection?.lensPath).toBe('Alimentação > Supermercado');
    });

    it('10.16 "E sem filtro?" com lente ativa → build sem lente (clear-lens elíptico)', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('E sem filtro?', ctx);
      expect(ans.projection?.lensKind).toBeUndefined();
      const proj = projOf(ans);
      expect(proj.lens).toBeUndefined();
      expect(ans.response.answer).toContain(brlReais(1000));
    });

    it('10.17 lente desconhecida "E alfafa?" → esclarecimento unknown_lens, sem projeção', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E alfafa?', ctx);
      expect(ans.intent).toBe('projection_clarification');
      expect(ans.response.answer).toContain('supermercado, transporte ou aluguel');
      expect(ans.response.projection).toBeUndefined();
    });

    it('10.18 "E quanto gastei?" com contexto → intents tradicionais PREVALECEM (não vira lente/mês)', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E quanto gastei?', ctx);
      expect(ans.intent).toBe('total_expenses');
      expect(ans.projectionRoute).toBeUndefined();
    });

    it('10.19 "E as categorias?" → troca de visão elíptica para categories, follow_up', async () => {
      const ctx = projectionContext({
        intent: 'projection_base',
        lensKind: 'category',
        lensPath: 'Alimentação > Supermercado',
        lensLabel: 'Supermercado',
      });
      const ans = await ask('E as categorias?', ctx);
      expect(ans.intent).toBe('projection_categories');
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.lensLabel).toBe('Supermercado');
    });
  });

  describe('10.20-10.25 — mudança de mês elíptica e esclarecimentos de tempo', () => {
    it('10.20 "E o mês passado?" com contexto de comparação → comparação re-ancorada em julho/2026', async () => {
      const ctx = projectionContext({ intent: 'projection_month_comparison', referenceMonth: '2026-07' });
      const ans = await ask('E o mês passado?', ctx);
      expect(ans.intent).toBe('projection_month_comparison');
      expect(ans.projection?.referenceMonth).toBe('2026-07');
    });

    it('10.21 "E em maio?" com contexto de comparação → comparação de maio/2026 (mês anterior re-ancorado)', async () => {
      const ctx = projectionContext({ intent: 'projection_month_comparison', referenceMonth: '2026-07' });
      const ans = await ask('E em maio?', ctx);
      expect(ans.intent).toBe('projection_month_comparison');
      expect(ans.projection?.referenceMonth).toBe('2026-05');
      const proj = projOf(ans);
      expect(proj.reference).toMatchObject({ month: '2026-05' });
    });

    it('10.22 "E no próximo mês?" com contexto → esclarecimento future_month', async () => {
      const ctx = projectionContext({ intent: 'projection_month_comparison' });
      const ans = await ask('E no próximo mês?', ctx);
      expect(ans.intent).toBe('projection_clarification');
      expect(ans.response.answer).toContain('meses futuros');
    });

    it('10.23 "E em maio?" com contexto current_month → esclarecimento reference_month', async () => {
      const ctx = projectionContext({ intent: 'projection_current_month' });
      const ans = await ask('E em maio?', ctx);
      expect(ans.intent).toBe('projection_clarification');
      expect(ans.response.answer).toContain('fechamento estimado vale para o mês atual');
    });

    it('10.24 "E este mês?" com contexto base → visão current_month (follow_up) ancorada no mês atual', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E este mês?', ctx);
      expect(ans.intent).toBe('projection_current_month');
      expect(ans.projectionRoute).toBe('follow_up');
      expect(ans.projection?.referenceMonth).toBe('2026-08');
    });

    it('10.25 "E em maio só supermercado?" → mês+lente combinado: a LENTE prevalece', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E em maio só supermercado?', ctx);
      expect(ans.intent).toBe('projection_base');
      expect(ans.projection?.lensKind).toBe('category');
      expect(ans.projection?.lensPath).toBe('Alimentação > Supermercado');
      const proj = projOf(ans);
      expect((proj.lens as { label: string }).label).toBe('Supermercado');
    });
  });

  describe('10.26-10.28 — robustez do contrato', () => {
    it('10.26 falha de infraestrutura no follow-up → erro controlado (AskError) com intent do contexto, nunca clarification', async () => {
      const { fake } = mkClient(fullRows());
      const breaking = {
        from: (t: string) => {
          if (t === 'categories') {
            return {
              select: () => ({
                eq: () => ({
                  range: () => ({
                    then: (r: (v: unknown) => unknown) =>
                      r({
                        data: null,
                        count: null,
                        error: { name: 'PostgrestError', message: 'erro simulado do postgrest' },
                      }),
                  }),
                }),
              }),
            };
          }
          return (fake as { from: (t: string) => unknown }).from(t);
        },
      };
      const ctx = projectionContext({ intent: 'projection_base' });
      const promise = runDeterministicAsk({
        supabase: breaking as never,
        question: 'E só supermercado?',
        context: ctx,
        nowISO: NOW,
      });
      await expect(promise).rejects.toMatchObject({
        name: 'AskError',
        message: 'ask-failure',
        intent: 'projection_base',
        classification: { category: 'supabase_query_error', retryable: false },
      });
    });

    it('10.27 regressão de precedência: "E quanto gastei em agosto?" segue total_expenses, mesmo com contexto', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E quanto gastei em agosto?', ctx);
      expect(ans.intent).toBe('total_expenses');
      expect(ans.response.answer).toContain('600,00');
    });

    it('10.28 payload da lente: apenas o rótulo de exibição (nunca path interno, IDs ou valores)', async () => {
      const ctx = projectionContext({ intent: 'projection_base' });
      const ans = await ask('E só supermercado?', ctx);
      const proj = projOf(ans);
      const lens = proj.lens as Record<string, unknown>;
      expect(Object.keys(lens)).toEqual(['label']);
      expect(lens.label).toBe('Supermercado');
      expect(JSON.stringify(lens)).not.toContain('canonical_path');
      expect(JSON.stringify(lens)).not.toContain('c-supermercado');
    });
  });
});