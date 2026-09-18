// pessoal13c3b12.test.ts — PESSOAL-13C3B.12: correções de contexto visual e
// de categorias excluídas. Prova que:
//   1. o classificador separa alocação patrimonial (investimentos, aportes,
//      poupança, aplicações, reserva de emergência) sem casamento indevido por
//      prefixo/substring;
//   2. savingsOpportunities NÃO cria card/valor de economia para alocação e a
//      segrega em excluded (sem consumir os 3 cards);
//   3. follow-ups com elipse inicial "Só/Somente/Apenas" voltam a ser
//      determinísticos ("Só em aluguel?", "Só em empréstimo?");
//   4. "E apenas investimentos?" resolve para a lente de alocação patrimonial
//      mesmo SEM a categoria no catálogo (lente virtual) e mesmo com ela;
//   5. "Só 5%?" NÃO é capturado como lente (percentual exige prefixo "e");
//   6. frases isoladas SEM contexto analítico não são follow-up;
//   7. zero chamadas ao Gemini nas perguntas determinísticas.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalyticsTxRow } from '../lib/analytics';
import {
  buildTrendWindow,
  savingsOpportunities,
  classifySavingsCategory,
  type SavingsResult,
} from '../lib/analyticsTrends';

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

const chatSupabaseRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../supabaseClient', () => ({
  supabase: {
    from(table: string): any {
      const cur = chatSupabaseRef.current as { from(table: string): unknown } | null;
      if (!cur || typeof cur.from !== 'function') {
        throw new Error('supabaseClient mock não configurado.');
      }
      return cur.from(table);
    },
    auth: {
      getUser: async (): Promise<{ data: { user: null }; error: null }> => ({
        data: { user: null },
        error: null,
      }),
    },
  },
}));

import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { contextFromTurn } from '../../server/chat/chatContext';
import type { ChatContextState } from '../../server/chat/chatTypes';

// ═══════════════ 1. Classificador puro (alocação patrimonial) ═══════════════

describe('PESSOAL-13C3B.12 — classifySavingsCategory: alocação patrimonial', () => {
  it('investimentos, aportes, poupança, aplicações e reserva de emergência (igualdade de segmento)', () => {
    for (const label of [
      'Investimentos',
      'Investimento',
      'Planejamento > Investimentos',
      'Aporte',
      'APORTES > Investimentos',
      'Poupança',
      'Aplicação',
      'Aplicações',
      'Reserva de emergência',
      'Segurança > Reserva de emergência',
    ]) {
      expect(classifySavingsCategory(label)).toBe('asset_allocation');
    }
  });

  it('sem casamento indevido por prefixo/substring (termos de investimento são ambíguos)', () => {
    expect(classifySavingsCategory('Educação > Investimento em inglês')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Investimento em você')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Poupança para viagem')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Renda Fixa')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Aplicação ESports')).toBe('percentage_candidate');
    // Categorias variáveis continuam elegíveis (regressão).
    expect(classifySavingsCategory('Alimentação > Supermercado')).toBe('percentage_candidate');
  });
});

// ═══════════════ 2. savingsOpportunities (alocação fora do ranking) ═══════════════

const W10 = buildTrendWindow('2026-09-16'); // base mar-mai, recent jun-ago

const SUPER = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PADARIA = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };
const COMBUSTIVEL = { display_name: 'Combustível', canonical_path: 'Transporte > Combustível' };
const INVEST = { display_name: 'Investimentos', canonical_path: 'Investimentos' };

type Cat = { display_name: string; canonical_path: string | null };

let seq = 0;

function tx(date: string, amount: number, cat: Cat): AnalyticsTxRow {
  seq += 1;
  return {
    id: `tx-${seq}`,
    transaction_kind: 'expense',
    amount,
    account_id: 'ACCT-1',
    category_id: `cat-${cat.canonical_path ?? seq}`,
    occurred_on: date,
    status: 'posted',
    raw_description: `desc-${seq}`,
    accounts: { display_name: 'Conta' },
    categories: cat,
  };
}

function recentSpend(cat: Cat, amount: number): AnalyticsTxRow[] {
  return ['2026-06-05', '2026-07-05', '2026-08-05'].map((d) => tx(d, amount, cat));
}

describe('PESSOAL-13C3B.12 — savingsOpportunities exclui alocação sem inventar valores', () => {
  it('Investimentos com gasto recorrente NÃO entra no ranking nem consome os 3 cards', () => {
    const rows = [
      ...recentSpend(INVEST, 1500),
      ...recentSpend(SUPER, 400),
      ...recentSpend(PADARIA, 300),
      ...recentSpend(COMBUSTIVEL, 200),
    ];
    const s = savingsOpportunities(rows, W10);
    expect(s.top).toHaveLength(3);
    expect(s.top.map((i) => i.label)).toEqual([
      'Alimentação > Supermercado',
      'Alimentação > Padaria',
      'Transporte > Combustível',
    ]);
    expect(s.excluded).toEqual([
      { categoryId: 'cat-Investimentos', label: 'Investimentos', classification: 'asset_allocation', meanRCents: 150000 },
    ]);
    expect(JSON.stringify(s.items)).not.toContain('Investimentos');
  });

  it('somente alocação patrimonial → insufficientData=true, sem cards nem R$ 0,00', () => {
    const s = savingsOpportunities(recentSpend(INVEST, 1500), W10);
    expect(s.items).toEqual([]);
    expect(s.top).toEqual([]);
    expect(s.insufficientData).toBe(true);
    expect(s.excluded.map((e) => e.classification)).toEqual(['asset_allocation']);
    expect(JSON.stringify(s)).not.toContain('R$ 0,00');
  });
});

// ═══════════════ 3. Roteador (follow-ups com elipse + lente virtual) ═══════════════

type FakeRow = {
  transaction_kind?: string | null;
  amount?: number | string | null;
  occurred_on?: string | null;
  deleted_at?: string | null;
  category_id?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
};

type CatFakeRow = { display_name: string; canonical_path: string | null; direction?: string };

const SUP_CAT = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const ALUG_CAT = { display_name: 'Aluguel', canonical_path: 'Moradia > Aluguel' };
const EMP_CAT = { display_name: 'Empréstimo', canonical_path: 'Dívidas > Empréstimo' };
const INVEST_CAT = { display_name: 'Investimentos', canonical_path: 'Investimentos' };

const EXPENSE_CATS_WITH_INVEST: CatFakeRow[] = [
  { ...SUP_CAT, direction: 'expense' },
  { ...ALUG_CAT, direction: 'expense' },
  { ...EMP_CAT, direction: 'expense' },
  { ...INVEST_CAT, direction: 'expense' },
];
const EXPENSE_CATS_WITHOUT_INVEST: CatFakeRow[] = [
  { ...SUP_CAT, direction: 'expense' },
  { ...ALUG_CAT, direction: 'expense' },
  { ...EMP_CAT, direction: 'expense' },
];

function mkClient(rows: FakeRow[], cats: CatFakeRow[] = []): { fake: unknown; calls: string[] } {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c3: Record<string, any> = {};
    type F = { op: string; key: string; value: unknown };
    const filters: F[] = [];
    for (const m of ['is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
      c3[m] = (k: string, v?: unknown) => {
        if ((m === 'is' || m === 'gte' || m === 'lte' || m === 'eq') && typeof k === 'string') {
          filters.push({ op: m, key: k, value: v as string | null });
        }
        return c3;
      };
    }
    c3.select = (_sel?: string, _opts?: { count?: 'exact' }) => c3;
    const store = table === 'categories' ? cats : rows;
    const matches = (r: FakeRow | CatFakeRow): boolean =>
      filters.every((f) => {
        const v = (r as Record<string, unknown>)[f.key];
        if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
        if (f.op === 'eq') return v === f.value;
        if (f.op === 'gte') return v !== null && v !== undefined && String(v) >= String(f.value);
        if (f.op === 'lte') return v !== null && v !== undefined && String(v) <= String(f.value);
        return true;
      });
    const filtered = () => store.filter((r) => matches(r));
    c3.range = (from: number, to: number) => {
      const page = filtered().slice(from, to + 1);
      return {
        ...c3,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, count: table === 'transactions' ? filtered().length : undefined, error: null }),
      };
    };
    c3.then = (resolve: (v: unknown) => unknown) => resolve({ data: filtered(), error: null });
    return c3;
  };
  return {
    fake: {
      from: (t: string) => {
        calls.push(t);
        return base(t);
      },
    },
    calls,
  };
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

const NOW = '2026-07-25';
const MESES = ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'];

function rowFor(cat: { display_name: string; canonical_path: string | null }, amount: number, d: string): FakeRow {
  return {
    transaction_kind: 'expense' as const,
    amount,
    occurred_on: d,
    category_id: `c-${cat.canonical_path ?? cat.display_name}`,
    categories: cat,
  };
}

function mixedRows(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of MESES) {
    out.push(rowFor(SUP_CAT, 400, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
    out.push(rowFor(EMP_CAT, 1500, d));
    out.push(rowFor(INVEST_CAT, 1200, d));
  }
  return out;
}

function contextOf(ans: DeterministicAnswer, prev: ChatContextState | null = null): ChatContextState {
  return contextFromTurn(prev, {
    intent: ans.intent,
    category: ans.category ?? null,
    periodAnalyzed: ans.response.periodAnalyzed ?? ans.response.period,
    answer: ans.response.answer,
    analysis: ans.analysis,
  });
}

async function firstTurn(
  q: string,
  rows: FakeRow[] = mixedRows(),
  cats: CatFakeRow[] = EXPENSE_CATS_WITH_INVEST,
): Promise<{ ans: DeterministicAnswer; fake: unknown; context: ChatContextState }> {
  const { fake } = mkClient(rows, cats);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, context: contextOf(ans) };
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
});

describe('PESSOAL-13C3B.12 — roteador: lente de exclusão e aviso de alocação', () => {
  it('primeiro turno com Investimentos: cards só de elegíveis e aviso de alocação patrimonial, zero Gemini', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    expect(ans.intent).toBe('savings_opportunities');
    expect(ans.response.engine).toBe('deterministic');
    expect(ans.response.geminiCallCount).toBe(0);
    const cards = ans.response.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('Alimentação > Supermercado');
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Investimentos');
    expect(notice).toContain('não entraram na simulação percentual');
    expect(notice).toContain('são alocação patrimonial, não consumo a reduzir');
    expect(notice).not.toContain('R$ 1.200,00');
  });

  it('"E apenas investimentos?" SEM a categoria no catálogo vira lente virtual de alocação', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const fu = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS_WITHOUT_INVEST).fake as never,
      question: 'E apenas investimentos?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.categoryPath).toBe('Investimentos');
    expect(fu?.response.cards).toEqual([]);
    expect(fu?.response.answer).toContain('é uma alocação patrimonial, não um consumo a reduzir');
    expect(fu?.response.answer).toContain('não entra na simulação percentual');
    expect(fu?.response.geminiCallCount).toBe(0);
  });

  it('"E apenas investimentos?" COM a categoria no catálogo responde a lente real sem cards', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const fu = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS_WITH_INVEST).fake as never,
      question: 'E apenas investimentos?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.categoryPath).toBe('Investimentos');
    expect(fu?.response.cards).toEqual([]);
    expect(fu?.response.answer).toContain('alocação patrimonial');
    expect(fu?.response.geminiCallCount).toBe(0);
  });

  it('"Só em aluguel?" e "Só em empréstimo?" voltam a ser determinísticos (lentes reais)', async () => {
    const { ans } = await firstTurn('Onde posso economizar mais?');
    const aluguel = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS_WITH_INVEST).fake as never,
      question: 'Só em aluguel?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(aluguel?.analysis?.categoryPath).toBe('Moradia > Aluguel');
    expect(aluguel?.response.answer).toContain('é um compromisso fixo e não entra na simulação percentual');
    expect(aluguel?.response.geminiCallCount).toBe(0);

    const emprestimo = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS_WITH_INVEST).fake as never,
      question: 'Só em empréstimo?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(emprestimo?.analysis?.categoryPath).toBe('Dívidas > Empréstimo');
    expect(emprestimo?.response.answer).toContain('é uma dívida');
    expect(emprestimo?.response.answer).toContain('saldo, prazo, taxa e CET');
    expect(emprestimo?.response.geminiCallCount).toBe(0);
  });

  it('"Só 5%?" NÃO é capturado como lente de categoria (percentual exige prefixo "e")', async () => {
    const { ans } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS_WITH_INVEST).fake as never,
      question: 'Só 5%?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu).toBeNull();
  });

  it('frase isolada SEM contexto analítico não é follow-up (mantém Gemini)', async () => {
    const fu = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS_WITH_INVEST).fake as never,
      question: 'Só em aluguel?',
      nowISO: NOW,
    });
    expect(fu).toBeNull();
  });
});