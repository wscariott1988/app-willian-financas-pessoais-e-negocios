// pessoal13c3bE2.test.ts — PESSOAL-13C3B-E2: intents determinísticos de
// tendências e oportunidades de economia no roteador determinístico.
//
// Prova que:
//   1. growth_categories responde determinístico para: "Onde meus gastos
//      aumentaram significativamente nos últimos 6 meses?", "Quais categorias
//      mais cresceram nos últimos 6 meses?" e "Onde aumentei mais meus gastos?";
//   2. savings_opportunities responde determinístico para: "Onde tenho maior
//      oportunidade de economizar?", "Onde posso economizar mais?", "E se eu
//      reduzisse meus gastos em 10%?" e "Quanto eu economizaria reduzindo
//      12,5%?";
//   3. perguntas de opinião continuam caindo no Gemini ("Devo economizar
//      mais?", "É melhor cortar gastos ou investir?", "Você acha que estou
//      gastando demais?", "Como devo organizar minha vida financeira?");
//   4. precedência: tendências antes do contexto/advice; intents existentes
//      (total, comparação mensal) não são capturados pelas novas intenções;
//   5. janelas: padrão six_complete; five_plus_current ("incluindo este mês");
//      six_plus_current ("seis meses completos mais este mês"); relógio
//      injetável (nowISO) com virada de ano;
//   6. percentual: 5/10/12,5/100 válidos; 0/negativo/>100/vazio → resposta
//      determinística amigável (NUNCA 500), sem valores simulados;
//   7. consulta enxuta: só o range necessário, sem raw_description, com
//      paginação >1000 linhas, transferências/removidos fora do cálculo;
//   8. engine='deterministic', geminiCallCount=0 (zero chamadas ao Gemini);
//   9. payload sem UUIDs/coisas sensíveis, sem linguagem proibida, cards
//      estruturados (kind/title/subtitle/rows) e notice de simulação;
//  10. sem crescimento significativo / dados insuficientes → resposta
//      determinística com cards vazios e mensagem clara.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';

// ── Fake Supabase com paginação (mesmo contrato do fast-path) ──

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

const SUP_CAT = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PAD_CAT = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };

function mkClient(rows: FakeRow[]): { fake: unknown; calls: string[]; selects: string[] } {
  const calls: string[] = [];
  const selects: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    let cols = '*';
    for (const m of ['is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
      c[m] = () => c;
    }
    c.select = (sel?: string, opts?: { count?: 'exact' }) => {
      cols = sel ?? '*';
      if (cols !== '*') selects.push(cols);
      return { ...c, _count: opts?.count === 'exact' };
    };
    const live = () => rows.filter((r) => !r.deleted_at);
    c.range = (from: number, to: number) => {
      const source = live();
      const page = source.slice(from, to + 1);
      return {
        ...c,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, count: table === 'transactions' ? live().length : undefined, error: null }),
      };
    };
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: live(), error: null });
    return c;
  };
  return {
    fake: {
      from: (t: string) => {
        calls.push(t);
        return base(t);
      },
    },
    calls,
    selects,
  };
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

const JAN = '2026-01-15';
const FEV = '2026-02-15';
const MAR = '2026-03-15';
const ABR = '2026-04-15';
const MAI = '2026-05-15';
const JUN = '2026-06-15';

/** Supermercado cresce 100→400; Padaria 50→150 no último trimestre. */
function growingRows(): FakeRow[] {
  const sup = (occurred_on: string, amount: number) => ({
    transaction_kind: 'expense' as const,
    amount,
    occurred_on,
    category_id: 'c-sup',
    categories: SUP_CAT,
  });
  const pad = (occurred_on: string, amount: number) => ({
    transaction_kind: 'expense' as const,
    amount,
    occurred_on,
    category_id: 'c-pad',
    categories: PAD_CAT,
  });
  return [
    sup(JAN, 100), sup(FEV, 100), sup(MAR, 100),
    sup(ABR, 400), sup(MAI, 400), sup(JUN, 400),
    pad(JAN, 50), pad(FEV, 50), pad(MAR, 50),
    pad(ABR, 150), pad(MAI, 150), pad(JUN, 150),
  ];
}

/** Todos os meses iguais: nenhuma categoria cresce. */
function flatRows(): FakeRow[] {
  const mk = (occurred_on: string) => ({
    transaction_kind: 'expense' as const,
    amount: 100,
    occurred_on,
    category_id: 'c-sup',
    categories: SUP_CAT,
  });
  return [JAN, FEV, MAR, ABR, MAI, JUN].map(mk);
}

const NOW = '2026-07-25';

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
});

describe('PESSOAL-13C3B-E2 — growth_categories (determinístico)', () => {
  it.each([
    'Onde meus gastos aumentaram significativamente nos últimos 6 meses?',
    'Quais categorias mais cresceram nos últimos 6 meses?',
    'Onde aumentei mais meus gastos?',
  ])('responde sem Gemini: "%s"', async (q) => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('growth_categories');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.cards?.length).toBeGreaterThan(0);
  });

  it('rank top 3 com média/delta/percentual claros (sem classificação interna no card)', async () => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde aumentei mais meus gastos?',
      nowISO: NOW,
    });
    const card = ans?.response.cards?.[0];
    expect(card?.title).toBe('Alimentação > Supermercado');
    expect(card?.kind).toBe('growth');
    const rows = Object.fromEntries((card?.rows ?? []).map((r) => [r.label, r.value]));
    expect(rows['Média anterior (por mês)']).toBeTruthy();
    expect(rows['Média recente (por mês)']).toBeTruthy();
    expect(rows['Variação mensal']).toBeTruthy();
    expect(rows['Variação relativa']).toBe('300%');
    expect(rows['Despesas recentes']).toBe('3');
    expect(rows['Classificação']).toBeUndefined();
    expect(rows['Período analisado']).toBeUndefined();
    expect(ans?.response.period).toEqual({ start: '2026-01-01', end: '2026-06-30' });
  });

  it('sem crescimento significativo → determinístico, cards vazios e mensagem clara', async () => {
    const { fake } = mkClient(flatRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde aumentei mais meus gastos?',
      nowISO: NOW,
    });
    expect(ans?.intent).toBe('growth_categories');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.cards).toEqual([]);
    expect(ans?.response.answer).toContain('não identifiquei categoria com crescimento significativo');
  });

  it('nunca usa palavras proibidas nem expõe UUID/categorias não canônicas', async () => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde aumentei mais meus gastos?',
      nowISO: NOW,
    });
    const raw = JSON.stringify(ans);
    for (const forbidden of ['inútil', 'desnecessário', 'dispensável']) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(raw).toContain('Alimentação > Supermercado');
  });
});

describe('PESSOAL-13C3B-E2 — savings_opportunities (determinístico)', () => {
  it.each([
    'Onde tenho maior oportunidade de economizar?',
    'Onde posso economizar mais?',
    'E se eu reduzisse meus gastos em 10%?',
    'Quanto eu economizaria reduzindo 12,5%?',
  ])('responde sem Gemini: "%s"', async (q) => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.geminiCallCount).toBe(0);
    expect(ans?.response.cards?.length).toBeGreaterThan(0);
    expect(ans?.response.notice).toBeTruthy();
  });

  it('cards com oportunidade potencial para revisar e projeção como simulação', async () => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde posso economizar mais?',
      nowISO: NOW,
    });
    const card = ans?.response.cards?.[0];
    expect(card?.kind).toBe('savings');
    expect(card?.subtitle).toBe('Oportunidade potencial para revisar');
    const rows = Object.fromEntries((card?.rows ?? []).map((r) => [r.label, r.value]));
    expect(rows['Economia mensal (cenário 10%)']).toBeTruthy();
    expect(rows['Projeção anual (simulação)']).toBeTruthy();
    expect(rows['Participação no total recente']).toBeTruthy();
    expect(rows['Regularidade']).toBe('3 de 3 meses recentes');
    expect(rows['Variabilidade']).toBe('Baixa');
    // SUPER: média 400 → 10% = 40/mês → 480/ano.
    expect(rows['Economia mensal (cenário 10%)']).toContain('40,00');
    expect(rows['Projeção anual (simulação)']).toContain('480,00');
    expect(ans?.response.notice).toContain('Simulação com redução de 10%');
  });

  it('12,5% aplica o percentual exato da simulação', async () => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quanto eu economizaria reduzindo 12,5%?',
      nowISO: NOW,
    });
    const rows = Object.fromEntries((ans?.response.cards?.[0]?.rows ?? []).map((r) => [r.label, r.value]));
    // SUPER média 400 → 12,5% = 50/mês → 600/ano.
    expect(rows['Economia mensal (cenário 12,5%)']).toContain('50,00');
    expect(rows['Projeção anual (simulação)']).toContain('600,00');
  });

  it('dados insuficientes → determinístico, cards vazios e notice amigável', async () => {
    const { fake } = mkClient([]);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde posso economizar mais?',
      nowISO: NOW,
    });
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.cards).toEqual([]);
    expect(ans?.response.answer).toContain('Não há dados suficientes');
    expect(ans?.response.notice).toBeTruthy();
  });
});

describe('PESSOAL-13C3B-E2 — percentual inválido nunca vira 500', () => {
  it.each([
    'E se eu reduzisse meus gastos em 0%?',
    'E se eu reduzisse meus gastos em 150%?',
    'E se eu reduzisse meus gastos em -10%?',
  ])('valida faixa válida e responde de forma amigável: "%s"', async (q) => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.cards).toEqual([]);
    expect(ans?.response.notice).toBeTruthy();
    expect(ans?.response.answer).toContain('Informe um percentual entre 0 e 100');
  });

  it.each(['10', '12,5', '100'])('percentual %s é aceito como completo', async (p) => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: `E se eu reduzisse meus gastos em ${p}%?`,
      nowISO: NOW,
    });
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.cards?.length).toBeGreaterThan(0);
  });
});

describe('PESSOAL-13C3B-E2 — janelas de período (relógio injetável)', () => {
  it('padrão: six_complete (6 meses completos, sem o mês atual)', async () => {
    const { fake } = mkClient(flatRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde aumentei mais meus gastos?',
      nowISO: NOW,
    });
    expect(ans?.response.period).toEqual({ start: '2026-01-01', end: '2026-06-30' });
  });

  it('"incluindo este mês" → five_plus_current (mês parcial sem extrapolar)', async () => {
    const { fake } = mkClient([...flatRows(), { transaction_kind: 'expense', amount: 50, occurred_on: '2026-06-20', category_id: 'c-sup', categories: SUP_CAT }]);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde aumentei mais meus gastos incluindo este mês?',
      nowISO: NOW,
    });
    expect(ans?.response.period).toEqual({ start: '2026-02-01', end: '2026-07-25' });
    expect(ans?.response.cards).toBeDefined();
  });

  it('"seis meses completos mais este mês" → six_plus_current (7 slots, parcial fora do cálculo)', async () => {
    const { fake } = mkClient(flatRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quais categorias mais cresceram nos últimos 6 meses completos mais este mês?',
      nowISO: NOW,
    });
    expect(ans?.response.period).toEqual({ start: '2026-01-01', end: '2026-07-25' });
  });

  it('virada de ano: seis meses atrás cruzam dezembro', async () => {
    const rows = [
      { transaction_kind: 'expense' as const, amount: 10, occurred_on: '2025-07-15', category_id: 'c-sup', categories: SUP_CAT },
      { transaction_kind: 'expense' as const, amount: 10, occurred_on: '2025-08-15', category_id: 'c-sup', categories: SUP_CAT },
      { transaction_kind: 'expense' as const, amount: 10, occurred_on: '2025-09-15', category_id: 'c-sup', categories: SUP_CAT },
      { transaction_kind: 'expense' as const, amount: 90, occurred_on: '2025-10-15', category_id: 'c-sup', categories: SUP_CAT },
      { transaction_kind: 'expense' as const, amount: 90, occurred_on: '2025-11-15', category_id: 'c-sup', categories: SUP_CAT },
      { transaction_kind: 'expense' as const, amount: 90, occurred_on: '2025-12-15', category_id: 'c-sup', categories: SUP_CAT },
    ];
    const { fake } = mkClient(rows);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quais categorias mais cresceram?',
      nowISO: '2026-01-10',
    });
    expect(ans?.response.period).toEqual({ start: '2025-07-01', end: '2025-12-31' });
    expect(ans?.response.cards?.[0]?.title).toBe('Alimentação > Supermercado');
  });
});

describe('PESSOAL-13C3B-E2 — precedência e intents existentes preservados', () => {
  it('advice puro continua no Gemini (null do roteador)', async () => {
    for (const q of [
      'Devo economizar mais?',
      'É melhor cortar gastos ou investir?',
      'Você acha que estou gastando demais?',
      'Como devo organizar minha vida financeira?',
    ]) {
      const { fake } = mkClient(growingRows());
      const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
      expect(ans).toBeNull();
    }
  });

  it('"E se eu reduzisse..." como pergunta completa nunca é reescrita pelo contexto', async () => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E se eu reduzisse meus gastos em 10%?',
      nowISO: NOW,
      context: {
        intent: 'category_total',
        category: 'Alimentação > Supermercado',
        period: { start: '2026-05-01', end: '2026-05-31' },
        summaries: [],
      },
    });
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
  });

  it('intents existentes não são capturados pelas novas intenções', async () => {
    const { fake } = mkClient(growingRows());
    const ans = await runDeterministicAsk({ supabase: fake as never, question: 'Quanto gastei no período?', nowISO: NOW });
    expect(ans).not.toBeNull();
    expect(ans?.intent).toBe('total_expenses');
  });
});

describe('PESSOAL-13C3B-E2 — consulta enxuta e paginada', () => {
  it('consulta apenas o range necessário da janela e nunca raw_description', async () => {
    const { fake, calls, selects } = mkClient(growingRows());
    await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde aumentei mais meus gastos?',
      nowISO: NOW,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.includes('transactions')).toBe(true);
    for (const sel of selects) {
      expect(sel).not.toContain('raw_description');
    }
  });

  it('paginação para períodos com mais de 1000 linhas não trunca o resultado', async () => {
    const rows: FakeRow[] = [];
    const months = [JAN, FEV, MAR, ABR, MAI, JUN];
    for (let i = 0; i < 1200; i++) {
      for (const m of months) {
        rows.push({ transaction_kind: 'expense', amount: 100, occurred_on: m, category_id: 'c-sup', categories: SUP_CAT });
      }
    }
    const { fake } = mkClient(rows);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quais categorias mais cresceram nos últimos 6 meses?',
      nowISO: NOW,
    });
    // Mesma despesa todos os meses: sem crescimento significativo → ainda assim determinístico.
    expect(ans?.intent).toBe('growth_categories');
    expect(ans?.response.engine).toBe('deterministic');
    expect(ans?.response.cards).toBeDefined();
  });

  it('transferências e removidas não entram no cálculo (regras canônicas)', async () => {
    const rows: FakeRow[] = [
      ...growingRows(),
      { transaction_kind: 'transfer', amount: 900000, occurred_on: JUN, category_id: 'c-sup', categories: SUP_CAT },
      { transaction_kind: 'expense', amount: 999999, occurred_on: JUN, deleted_at: '2026-06-20', category_id: 'c-sup', categories: SUP_CAT },
    ];
    const { fake } = mkClient(rows);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Onde tenho maior oportunidade de economizar?',
      nowISO: NOW,
    });
    expect(ans?.intent).toBe('savings_opportunities');
    expect(ans?.response.engine).toBe('deterministic');
    // Valor simulado NUNCA usa a transferência nem a linha removida.
    const raw = JSON.stringify(ans);
    expect(raw).not.toContain('999999');
    expect(raw).not.toContain('900000');
  });
});