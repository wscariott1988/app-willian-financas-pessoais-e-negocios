// pessoal13c3b10Policy.test.ts — PESSOAL-13C3B.10: política conservadora de
// economia. Prova que:
//   1. o classificador puro (classifySavingsCategory) separa compromissos
//      fixos, dívidas e despesas protegidas das categorias de percentual;
//   2. savingsOpportunities NÃO cria card/valor de economia para as excluídas
//      e as segrega em excluded (sem consumir o limite de 3 cards);
//   3. o roteador responde determinístico com aviso curto das exclusões, sem
//      valores inventados e sem sugerir corte em débito/saúde;
//   4. somente categorias excluídas → sem cards + mensagem de despesas
//      adequadas (insufficientData explícito, nunca R$ 0,00 fictício);
//   5. percentuais 5/10/12,5 continuam corretos com a política aplicada;
//   6. follow-ups (percentual e lente de categoria) preservam a política;
//   7. normalização de acentos/caixa/plural e segmentos aninhados do path;
//   8. ausência de casamento indevido por substring;
//   9. zero chamadas ao Gemini nas perguntas determinísticas;
//  10. cache completed e F5 (listMessages) preservam cards e notice com exclusões.
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
        throw new Error('supabaseClient mock não configurado (chatSupabaseRef.current).');
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
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';
import { listMessages } from '../lib/chatApi';

// ═══════════════ 1. Classificador puro ═══════════════

describe('PESSOAL-13C3B.10 — classifySavingsCategory (puro)', () => {
  it('compromissos fixos: aluguel (raiz e aninhado), condomínio, seguros, plano de saúde, mensalidade escolar', () => {
    for (const label of [
      'Aluguel',
      'Moradia > Aluguel',
      'ALUGUEL',
      'Moradia > Aluguéis',
      'Moradia > Condomínio',
      'Condomínio',
      'Seguro',
      'Veículos > Seguros',
      'Plano de Saúde',
      'Plano de saude empresarial',
      'Mensalidade escolar',
      'Moradia > Mensalidades escolares',
    ]) {
      expect(classifySavingsCategory(label)).toBe('fixed_contract');
    }
  });

  it('dívidas: empréstimo, financiamento, dívida, parcelamento (singular/plural)', () => {
    for (const label of [
      'Empréstimo',
      'Dívidas > Empréstimo',
      'Empréstimos',
      'Casa > Financiamento',
      'Financiamentos',
      'Dívida',
      'Dívidas',
      'Parcelamento',
      'Compras > Parcelamentos',
    ]) {
      expect(classifySavingsCategory(label)).toBe('debt_commitment');
    }
  });

  it('despesas protegidas de saúde: farmácia, medicamento, consulta, hospital, tratamento médico', () => {
    for (const label of [
      'Farmácia',
      'Saúde > Farmácias',
      'Medicamento',
      'Saúde > Medicamentos',
      'Saúde > Consulta',
      'Consultas',
      'Hospital',
      'Hospitais',
      'Saúde > Tratamento médico',
      'Saúde > Tratamento Medico',
    ]) {
      expect(classifySavingsCategory(label)).toBe('protected_essential');
    }
  });

  it('categorias variáveis permanecem elegíveis (sem quebrar o catálogo atual)', () => {
    for (const label of [
      'Alimentação > Supermercado',
      'Supermercado',
      'Alimentação > Padaria',
      'Transporte > Combustível',
      'Educação > English School',
      'Lazer > Streaming',
      'Saúde',
    ]) {
      expect(classifySavingsCategory(label)).toBe('percentage_candidate');
    }
  });

  it('segmentos aninhados do canonical_path normalizam acento/caixa/espaço', () => {
    expect(classifySavingsCategory('  MORADIA   >   ALUGUEL  ')).toBe('fixed_contract');
    expect(classifySavingsCategory('moradia > aluguel')).toBe('fixed_contract');
    expect(classifySavingsCategory('SAÚDE > TRATAMENTO MÉDICO')).toBe('protected_essential');
    expect(classifySavingsCategory('DÍVIDAS > EMPRÉSTIMOS')).toBe('debt_commitment');
  });

  it('nenhum casamento indevido por substring', () => {
    // "seguro" não casa com "segurança"; "aluguel" não casa com "aluguel de notas".
    expect(classifySavingsCategory('Moradia > Segurança')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Educação > Manutenção Saúde')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Moradia > Vigilância')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Alimentação > Plano Alimentar')).toBe('percentage_candidate');
    // Prefixo de frase é deliberado e conservador: "Seguro do carro" é seguro.
    expect(classifySavingsCategory('Veículos > Seguro do carro')).toBe('fixed_contract');
  });

  it('sem categoria/desconhecido permanece conservative percentage_candidate', () => {
    expect(classifySavingsCategory('')).toBe('percentage_candidate');
    expect(classifySavingsCategory('Outros Gastos')).toBe('percentage_candidate');
  });
});

// ═══════════════ 2. savingsOpportunities (política pura) ═══════════════

const W10 = buildTrendWindow('2026-09-16'); // base mar-mai, recent jun-ago

const SUPER = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PADARIA = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };
const COMBUSTIVEL = {
  display_name: 'Combustível',
  canonical_path: 'Transporte > Combustível',
};
const ALUGUEL = { display_name: 'Aluguel', canonical_path: 'Moradia > Aluguel' };
const EMPRESTIMO = { display_name: 'Empréstimo', canonical_path: 'Dívidas > Empréstimo' };
const FINANCIAMENTO = {
  display_name: 'Financiamento',
  canonical_path: 'Financiamento',
};
const FARMACIA = { display_name: 'Farmácia', canonical_path: 'Saúde > Farmácia' };
const MEDICAMENTO = { display_name: 'Medicamento', canonical_path: 'Saúde > Medicamento' };

type Cat = { display_name: string; canonical_path: string | null };

let seq = 0;

function tx(
  date: string,
  amount: number,
  cats: Cat = SUPER,
  kind: 'expense' | 'income' | 'transfer' = 'expense',
): AnalyticsTxRow {
  seq += 1;
  return {
    id: `tx-${seq}`,
    transaction_kind: kind,
    amount,
    account_id: 'ACCT-1',
    category_id: cats ? 'cat-' + cats.canonical_path : null,
    occurred_on: date,
    status: 'posted',
    raw_description: `desc-${seq}`,
    accounts: { display_name: 'Conta' },
    categories: cats,
  };
}

function days(month: number, day: number): string {
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function recentSpend(cat: Cat, amount: number): AnalyticsTxRow[] {
  return [days(6, 5), days(7, 5), days(8, 5)].map((d) => tx(d, amount, cat));
}

function expectOnlyCandidate(s: SavingsResult, expected: string[]): void {
  expect(s.items.map((i) => i.label)).toEqual(expected);
  expect(s.top.map((i) => i.label)).toEqual(expected.slice(0, 3));
  const itemLabels = s.items.map((i) => i.label);
  for (const e of s.excluded) {
    expect(itemLabels).not.toContain(e.label);
  }
}

describe('PESSOAL-13C3B.10 — savingsOpportunities exclui sem inventar valores', () => {
  it('Aluguel com MAIOR valor não gera card nem valor de economia; supermercado continua elegível', () => {
    const rows = [
      ...recentSpend(ALUGUEL, 2000.0),
      ...recentSpend(SUPER, 400.0),
      ...recentSpend(EMPRESTIMO, 1500.0),
    ];
    const s = savingsOpportunities(rows, W10);
    expect(s.items.map((i) => i.label)).toEqual(['Alimentação > Supermercado']);
    expect(s.top[0].economyMonthlyCents).toBe(4000);
    expect(s.top[0].economyAnnualCents).toBe(48000);
    expect(s.excluded.map((e) => e.label)).toEqual([
      'Moradia > Aluguel',
      'Dívidas > Empréstimo',
    ]);
    expect(s.excluded.map((e) => e.classification)).toEqual([
      'fixed_contract',
      'debt_commitment',
    ]);
    expect(s.excluded.every((e) => e.meanRCents > 0)).toBe(true);
  });

  it('Empréstimo/Financiamento não geram gestão de saldo; farmácia não recebe sugestão de corte', () => {
    const rows = [
      ...recentSpend(EMPRESTIMO, 1500.0),
      ...recentSpend(FINANCIAMENTO, 1200.0),
      ...recentSpend(FARMACIA, 300.0),
      ...recentSpend(MEDICAMENTO, 200.0),
      ...recentSpend(SUPER, 400.0),
    ];
    const s = savingsOpportunities(rows, W10);
    expect(s.items.map((i) => i.label)).toEqual(['Alimentação > Supermercado']);
    expect(s.excluded.map((e) => e.label).sort()).toEqual([
      'Dívidas > Empréstimo',
      'Financiamento',
      'Saúde > Farmácia',
      'Saúde > Medicamento',
    ]);
    const raw = JSON.stringify(s);
    expect(raw).not.toContain('50,00'); // nenhuma economia simulada p/ excluídas
  });

  it('categorias excluídas NÃO consomem o limite de 3 cards', () => {
    const rows = [
      ...recentSpend(SUPER, 400.0),
      ...recentSpend(PADARIA, 300.0),
      ...recentSpend(COMBUSTIVEL, 200.0),
      ...recentSpend(ALUGUEL, 2000.0),
      ...recentSpend(EMPRESTIMO, 1500.0),
      ...recentSpend(FINANCIAMENTO, 1200.0),
      ...recentSpend(FARMACIA, 500.0),
      ...recentSpend(MEDICAMENTO, 300.0),
    ];
    const s = savingsOpportunities(rows, W10);
    expect(s.top).toHaveLength(3);
    expect(s.items.map((i) => i.label)).toEqual([
      'Alimentação > Supermercado',
      'Alimentação > Padaria',
      'Transporte > Combustível',
    ]);
    expect(s.excluded).toHaveLength(5);
    expect(s.insufficientData).toBe(false);
  });

  it('somente categorias excluídas → insufficientData=true, sem cards nem R$ 0,00', () => {
    const rows = [
      ...recentSpend(ALUGUEL, 2000.0),
      ...recentSpend(EMPRESTIMO, 1500.0),
      ...recentSpend(FARMACIA, 300.0),
    ];
    const s = savingsOpportunities(rows, W10);
    expect(s.items).toEqual([]);
    expect(s.top).toEqual([]);
    expect(s.insufficientData).toBe(true);
    expect(s.excluded.map((e) => e.label).sort()).toEqual([
      'Dívidas > Empréstimo',
      'Moradia > Aluguel',
      'Saúde > Farmácia',
    ]);
    expect(JSON.stringify(s)).not.toContain('R$ 0,00');
  });

  it('percentuais 5/10/12,5 continuam corretos; excluídos nunca entram mesmo em cenários altos', () => {
    const rows = [
      ...recentSpend(SUPER, 400.0),
      ...recentSpend(ALUGUEL, 2000.0),
    ];
    for (const [pct, monthly, annual] of [
      [5, 2000, 24000],
      [10, 4000, 48000],
      [12.5, 5000, 60000],
    ]) {
      const s = savingsOpportunities(rows, W10, pct);
      expect(s.items).toHaveLength(1);
      expect(s.items[0].economyMonthlyCents).toBe(monthly);
      expect(s.items[0].economyAnnualCents).toBe(annual);
      expect(s.excluded.map((e) => e.label)).toEqual(['Moradia > Aluguel']);
    }
  });

  it('acento/caixa/plural no canonical_path da transação são normalizados pelo classificador', () => {
    const fancyAluguel = { display_name: 'ALUGUEL', canonical_path: '  MORADIA >  ALUGUÉIS ' };
    const rows = [
      ...recentSpend(SUPER, 400.0),
      ...recentSpend(fancyAluguel as unknown as Cat, 2000.0),
    ];
    const s = savingsOpportunities(rows, W10);
    expect(s.items.map((i) => i.label)).toEqual(['Alimentação > Supermercado']);
    expect(s.excluded).toHaveLength(1);
    expect(s.excluded[0].classification).toBe('fixed_contract');
  });
});

// ═══════════════ 3. Roteador (resp. determinística com aviso) ═══════════════

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
const FAR_CAT = { display_name: 'Farmácia', canonical_path: 'Saúde > Farmácia' };

const EXPENSE_CATS: CatFakeRow[] = [
  { display_name: 'Alimentação', canonical_path: 'Alimentação', direction: 'expense' },
  { ...SUP_CAT, direction: 'expense' },
  { ...ALUG_CAT, direction: 'expense' },
  { ...EMP_CAT, direction: 'expense' },
  { ...FAR_CAT, direction: 'expense' },
];

function mkClient(
  rows: FakeRow[],
  cats: CatFakeRow[] = [],
): { fake: unknown; calls: string[] } {
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

const JAN = '2026-01-15';
const FEV = '2026-02-15';
const MAR = '2026-03-15';
const ABR = '2026-04-15';
const MAI = '2026-05-15';
const JUN = '2026-06-15';
const NOW = '2026-07-25';

function rowFor(cat: { display_name: string; canonical_path: string | null }, amount: number, d: string): FakeRow {
  return {
    transaction_kind: 'expense' as const,
    amount,
    occurred_on: d,
    category_id:
      cat === SUP_CAT ? 'c-sup' : cat === ALUG_CAT ? 'c-alug' : cat === EMP_CAT ? 'c-emp' : 'c-x',
    categories: cat,
  };
}

/** Supermercado 400, Aluguel 2000, Empréstimo 1500 em todos os 6 meses. */
function mixedRows(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [JAN, FEV, MAR, ABR, MAI, JUN]) {
    out.push(rowFor(SUP_CAT, 400, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
    out.push(rowFor(EMP_CAT, 1500, d));
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
  cats: CatFakeRow[] = EXPENSE_CATS,
): Promise<{ ans: DeterministicAnswer; fake: unknown; context: ChatContextState }> {
  const { fake } = mkClient(rows, cats);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, context: contextOf(ans) };
}

function cardRows(ans: DeterministicAnswer | null | undefined): Record<string, string>[] {
  return (ans?.response.cards ?? []).map((c) =>
    Object.fromEntries((c.rows ?? []).map((r) => [r.label, r.value])),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
});

describe('PESSOAL-13C3B.10 — roteador: aviso de exclusão e cards só de elegíveis', () => {
  it('"Onde tenho oportunidades de economia de 10%?" só retorna Supermercado (Aluguel/Empréstimo fora) e zero Gemini', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    expect(ans.intent).toBe('savings_opportunities');
    expect(ans.response.engine).toBe('deterministic');
    expect(ans.response.geminiCallCount).toBe(0);
    const cards = ans.response.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('savings');
    expect(cards[0]?.title).toBe('Alimentação > Supermercado');
    const rows = cardRows(ans)[0];
    expect(rows['Economia mensal (cenário 10%)']).toContain('40,00');
    expect(rows['Economia anualizada (simulação)']).toContain('480,00');
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Moradia > Aluguel');
    expect(notice).toContain('Dívidas > Empréstimo');
    expect(notice).toContain('não entraram na simulação percentual');
    expect(notice).toContain('Compromissos fixos e dívidas exigem análise');
    expect(notice).not.toContain('R$ 2.000,00');
    expect(notice).not.toContain('R$ 1.500,00');
  });

  it('Farmácia junto com elegíveis não recebe sugestão de corte e entra no aviso', async () => {
    const rows = [...mixedRows(), ...([ABR, MAI, JUN] as const).map((d) => rowFor(FAR_CAT, 300, d))];
    const { ans } = await firstTurn('Onde posso economizar mais?', rows);
    expect(ans.response.cards).toHaveLength(1);
    expect(ans.response.cards?.[0]?.title).toBe('Alimentação > Supermercado');
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Saúde > Farmácia');
    expect(notice).toContain('Despesas médicas e de saúde ficaram fora');
    const raw = JSON.stringify(ans.response.cards);
    expect(raw).not.toContain('Farmácia');
  });

  it('dívida em lente própria responde sobre a política (saldo/prazo/taxa/CET), sem cards', async () => {
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?');
    const fu = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS).fake as never,
      question: 'E só no empréstimo?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.response.cards).toEqual([]);
    expect(fu?.analysis?.categoryPath).toBe('Dívidas > Empréstimo');
    expect(fu?.response.answer).toContain('representa uma dívida e não entra na simulação percentual');
    expect(fu?.response.answer).toContain('saldo, prazo, taxa e CET');
    expect(fu?.response.geminiCallCount).toBe(0);
  });

  it('lente de aluguel: resposta de compromisso fixo, sem cards e sem valor inventado', async () => {
    const { ans, fake } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E só em aluguel?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.analysis?.categoryPath).toBe('Moradia > Aluguel');
    expect(fu?.response.cards).toEqual([]);
    expect(fu?.response.answer).toContain('representa um compromisso fixo e não entra na simulação percentual');
    expect(fu?.response.answer).toContain('avaliar o contrato');
    expect(fu?.response.notice).toBeUndefined();
    expect(fu?.response.evidence ?? []).toEqual([]);
  });

  it('follow-up percentual "E 5%?" preserva a política e mantém o aviso de exclusão', async () => {
    const { ans } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({
      supabase: mkClient(mixedRows(), EXPENSE_CATS).fake as never,
      question: 'E 5%?',
      context: contextOf(ans),
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.simulationPct).toBe(5);
    expect(fu?.response.cards).toHaveLength(1);
    expect(fu?.response.cards?.[0]?.title).toBe('Alimentação > Supermercado');
    const rows = cardRows(fu)[0];
    expect(rows['Economia mensal (cenário 5%)']).toContain('20,00');
    expect(rows['Economia anualizada (simulação)']).toContain('240,00');
    expect(fu?.response.notice).toContain('Moradia > Aluguel');
    expect(fu?.response.notice).toContain('não entraram na simulação percentual');
    expect(fu?.response.geminiCallCount).toBe(0);
  });

  it('somente categorias excluídas → cards vazios, insufficientData com mensagem de despesas adequadas', async () => {
    const rows = [JAN, FEV, MAR, ABR, MAI, JUN].flatMap((d) => [
      rowFor(ALUG_CAT, 2000, d),
      rowFor(EMP_CAT, 1500, d),
      rowFor(FAR_CAT, 300, d),
    ]);
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', rows);
    expect(ans.response.cards).toEqual([]);
    expect(ans.response.answer).toContain('Não encontrei despesas adequadas para uma simulação percentual');
    const notice = ans.response.notice ?? '';
    expect(notice).toContain('Moradia > Aluguel');
    expect(notice).toContain('Dívidas > Empréstimo');
    expect(notice).toContain('Saúde > Farmácia');
    expect(JSON.stringify(ans.response)).not.toContain('R$ 0,00');
    expect(ans.response.geminiCallCount).toBe(0);
  });
});

// ═══════════════ 4. Endpoint: cache completed e F5 preservam política ═══════════════

const JSON_HEADERS = { 'content-type': 'application/json' };

const NOW8 = '2026-09-18';
const MAR8 = '2026-03-12';
const ABR8 = '2026-04-12';
const MAI8 = '2026-05-12';
const JUN8 = '2026-06-12';
const JUL8 = '2026-07-12';
const AGO8 = '2026-08-12';

function mixedRows8(): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [MAR8, ABR8, MAI8, JUN8, JUL8, AGO8]) {
    out.push(rowFor(SUP_CAT, 400, d));
    out.push(rowFor(ALUG_CAT, 2000, d));
    out.push(rowFor(EMP_CAT, 1500, d));
  }
  return out;
}

type Row = Record<string, any>;

function uniqViolation(): Error & { code: string } {
  const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  e.code = '23505';
  return e;
}

function conflictEq(a: unknown, b: unknown): boolean {
  return a !== null && b !== null && a === b;
}

interface SFBuilder {
  table: string;
  filters: Array<{ op: string; key: string; value: unknown }>;
  orders: Array<{ key: string; asc: boolean }>;
  fromRange: number;
  toRange: number;
  maybe: boolean;
  single: boolean;
  countOpt: boolean;
  action: 'select' | 'upsert' | 'insert' | 'update' | 'delete';
  rows: Row[];
  patch: Record<string, unknown>;
  onConflict: string;
  ignoreDuplicates: boolean;
}

class StateFake {
  state: Record<string, Row[]> = {
    transactions: [],
    categories: [],
    chat_conversations: [],
    chat_messages: [],
  };
  calls: Array<{ table: string; action: string }> = [];

  from(table: string): Record<string, any> {
    const self = this;
    const b: SFBuilder = {
      table,
      filters: [],
      orders: [],
      fromRange: 0,
      toRange: Number.POSITIVE_INFINITY,
      maybe: false,
      single: false,
      countOpt: false,
      action: 'select',
      rows: [],
      patch: {},
      onConflict: 'id',
      ignoreDuplicates: false,
    };
    const matches = (row: Row, f: { op: string; key: string; value: unknown }): boolean => {
      const v: unknown = row[f.key];
      if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
      if (f.op === 'eq') return v === f.value;
      if (f.op === 'gte' || f.op === 'lte') {
        const a = (row[f.key] ?? null) as string | number | null;
        const b2 = (f.value ?? null) as string | number | null;
        if (a === null || b2 === null) return false;
        const cmp =
          typeof a === 'string' && typeof b2 === 'string'
            ? a.localeCompare(b2)
            : Number(a) - Number(b2);
        return f.op === 'gte' ? cmp >= 0 : cmp <= 0;
      }
      return false;
    };
    const run = (): { data: unknown; count: number | null; error: unknown } => {
      self.calls.push({ table, action: b.action });
      if (b.action === 'upsert') {
        const keys = b.onConflict.split(',');
        for (const row of b.rows) {
          const dup = self.state[table].some((r) => keys.every((k) => conflictEq(r[k], row[k])));
          if (dup && !b.ignoreDuplicates) return { data: null, count: null, error: uniqViolation() };
          if (!dup) self.state[table].push(row);
        }
        return { data: null, count: null, error: null };
      }
      if (b.action === 'insert') {
        for (const row of b.rows) {
          if (
            table === 'chat_messages' &&
            self.state[table].some((r) =>
              ['conversation_id', 'client_request_id', 'role'].every((k) => conflictEq(r[k], row[k])),
            )
          ) {
            return { data: null, count: null, error: uniqViolation() };
          }
          self.state[table].push(row);
        }
        return { data: null, count: null, error: null };
      }
      let selected = self.state[table].filter((r) => b.filters.every((f) => matches(r, f)));
      for (const o of b.orders) {
        selected = [...selected].sort((a, q) => {
          const av = (a[o.key] ?? null) as string | number | null;
          const qv = (q[o.key] ?? null) as string | number | null;
          if (av === qv) return 0;
          if (av === null) return 1;
          if (qv === null) return -1;
          if (typeof av === 'string' && typeof qv === 'string') {
            return av < qv ? -1 : 1;
          }
          return Number(av) < Number(qv) ? -1 : 1;
        });
        if (!o.asc) selected.reverse();
      }
      if (b.action === 'update') {
        for (const row of selected) Object.assign(row, b.patch);
        return { data: null, count: null, error: null };
      }
      if (b.action === 'delete') {
        self.state[table] = self.state[table].filter((r) => !selected.includes(r));
        return { data: null, count: null, error: null };
      }
      const total = selected.length;
      const page = selected.slice(b.fromRange, b.toRange + 1);
      if (b.maybe || b.single) {
        return { data: page[0] ?? null, count: b.countOpt ? total : null, error: null };
      }
      return { data: page, count: b.countOpt ? total : null, error: null };
    };
    const baseRecord: Record<string, any> = {
      select(_cols = '*', opts?: { count?: 'exact' }) {
        b.countOpt = opts?.count === 'exact';
        return baseRecord;
      },
      is(key: string, value: unknown) {
        b.filters.push({ op: 'is', key, value });
        return baseRecord;
      },
      eq(key: string, value: unknown) {
        b.filters.push({ op: 'eq', key, value });
        return baseRecord;
      },
      gte(key: string, value: unknown) {
        b.filters.push({ op: 'gte', key, value });
        return baseRecord;
      },
      lte(key: string, value: unknown) {
        b.filters.push({ op: 'lte', key, value });
        return baseRecord;
      },
      order(key: string, opts?: { ascending?: boolean }) {
        b.orders.push({ key, asc: opts?.ascending ?? true });
        return baseRecord;
      },
      limit(limit: number) {
        b.toRange = limit - 1;
        return baseRecord;
      },
      range(from: number, to: number) {
        b.fromRange = from;
        b.toRange = to;
        return baseRecord;
      },
      maybeSingle() {
        b.maybe = true;
        return baseRecord;
      },
      single() {
        b.single = true;
        return baseRecord;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        b.action = 'upsert';
        b.rows = Array.isArray(rows) ? rows : [rows];
        b.onConflict = opts?.onConflict ?? 'id';
        b.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        return baseRecord;
      },
      insert(rows: Row) {
        b.action = 'insert';
        b.rows = [rows];
        return baseRecord;
      },
      update(patch: Record<string, unknown>) {
        b.action = 'update';
        b.patch = patch;
        return baseRecord;
      },
      then(resolve: (v: unknown) => unknown) {
        return resolve(run());
      },
    };
    return baseRecord;
  }
}

const CONV = { id: 'conv-1', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

function seedConv(c: StateFake): void {
  c.state.chat_conversations = [{ ...CONV }];
}

function authOk(c: StateFake): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: c as never,
    userId: 'user-test-0000-0000-0000-000000000000',
    user: null,
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://local/api/finances/ask', {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: 'Bearer token-valido' },
    body: JSON.stringify(body),
  });
}

function txCount(c: StateFake): number {
  return c.calls.filter((x) => x.table === 'transactions').length;
}

function assistantRowOf(c: StateFake, clientRequestId: string): Row | undefined {
  return c.state.chat_messages.find(
    (m) => m.role === 'assistant' && m.client_request_id === clientRequestId,
  );
}

describe('PESSOAL-13C3B.10 — endpoint: cache completed e F5 preservam cards e notice com exclusões', () => {
  it('10% → cache completed idêntico e listMessages transporta a política (F5)', async () => {
    const c = new StateFake();
    c.state.transactions = mixedRows8();
    seedConv(c);

    authOk(c);
    const r1 = await handler(
      postRequest({ question: 'Onde tenho oportunidades de economia de 10%?', conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { engine: string; cards: Array<{ title: string }>; notice: string };
    expect(b1.engine).toBe('deterministic');
    expect(b1.cards).toHaveLength(1);
    expect(b1.cards[0]?.title).toBe('Alimentação > Supermercado');
    expect(b1.notice).toContain('Moradia > Aluguel');
    expect(b1.notice).toContain('Dívidas > Empréstimo');
    expect(c.state.chat_conversations[0].context?.analysis?.intent).toBe('savings_opportunities');

    const txBefore = txCount(c);
    authOk(c);
    const r1b = await handler(
      postRequest({ question: 'Onde tenho oportunidades de economia de 10%?', conversationId: 'conv-1', clientRequestId: 'r1' }),
    );
    expect(r1b.status).toBe(200);
    const b1b = (await r1b.json()) as { notice: string };
    expect(b1b.notice).toBe(b1.notice);
    expect(txCount(c)).toBe(txBefore);

    chatSupabaseRef.current = c;
    const page = await listMessages('conv-1', 0);
    const completed = page.messages.filter((m) => m.role === 'assistant' && m.status === 'completed');
    const last = completed[completed.length - 1];
    expect(last.cards).toHaveLength(1);
    expect(last.cards?.[0]?.title).toBe('Alimentação > Supermercado');
    expect(last.notice).toContain('não entraram na simulação percentual');

    const persisted = assistantRowOf(c, 'r1')?.payload as
      | { cards?: Array<{ title: string }>; notice?: string }
      | undefined;
    expect(persisted?.notice).toBe(last.notice);
    expect(persisted?.cards?.[0]?.title).toBe(last.cards?.[0]?.title);
  });
});