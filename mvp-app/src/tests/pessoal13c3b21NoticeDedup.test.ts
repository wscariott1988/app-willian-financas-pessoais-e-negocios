// pessoal13c3b21NoticeDedup.test.ts — PESSOAL-13C3B.21:
// deduplicação de exibição + concordância estável do notice.
//
// Prova que:
//   1. "Seguro do Carro" ♢ "seguro carro" aparecem UMA única vez no notice,
//      com a forma legível preservada ("Seguro do Carro");
//   2. variações de caixa, acento, pontuação e preposição são deduplicadas de
//      forma determinística (mesmo resultado em qualquer ordem de entrada);
//   3. "Seguro do Carro" e "Seguro Residencial" permanecem DISTINTAS;
//   4. a chave de equivalência usa palavras integrais (nunca substring solta);
//   5. a concordância é estável: "A categoria X ficou fora" / "As categorias
//      ... ficaram fora", independente do plural interno do rótulo;
//   6. valores, cards, ranking e classificação financeira permanecem intactos
//      (zero Gemini, cards elegíveis inalterados).
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

const chatSupabaseRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../supabaseClient', () => ({
  supabase: {
    from(table: string): never {
      const cur = chatSupabaseRef.current as { from(table: string): unknown } | null;
      if (cur && typeof cur.from === 'function') {
        return cur.from(table) as never;
      }
      throw new Error('supabaseClient mock não configurado (chatSupabaseRef.current).');
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  },
}));

import { registerGeminiClient } from '../../server/finance-ai/geminiClient';
import { runDeterministicAsk } from '../../server/finance-ai/deterministicRouter';
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { contextFromTurn } from '../../server/chat/chatContext';
import type { ChatContextState } from '../../server/chat/chatTypes';
import {
  equivalenceKeyOf,
  betterDisplayName,
  dedupeDisplayNames,
} from '../../server/finance-ai/noticeDedup';

// ═══════════════ Função pura de deduplicação (exibição) ═══════════════

describe('noticeDedup — chave de equivalência (palavras integrais)', () => {
  it('"Seguro do Carro" e "seguro carro" compartilham a chave; "Seguro Residencial" não', () => {
    expect(equivalenceKeyOf('Seguro do Carro')).toBe('seguro carro');
    expect(equivalenceKeyOf('seguro carro')).toBe('seguro carro');
    expect(equivalenceKeyOf('Seguro Residencial')).toBe('seguro residencial');
    expect(equivalenceKeyOf('Seguro do Carro')).not.toBe(equivalenceKeyOf('Seguro Residencial'));
  });

  it('normaliza caixa, acentos, espaços, pontuação e preposições isoladas', () => {
    expect(equivalenceKeyOf('SEGURO carro')).toBe('seguro carro');
    expect(equivalenceKeyOf('Seguro  carro')).toBe('seguro carro');
    expect(equivalenceKeyOf('seguro, carro!')).toBe('seguro carro');
    expect(equivalenceKeyOf('seguro, do, carro')).toBe('seguro carro');
    expect(equivalenceKeyOf('seguro da casa')).toBe('seguro casa');
    expect(equivalenceKeyOf('Saúde')).toBe('saude');
    expect(equivalenceKeyOf('Plano de Saúde')).toBe('plano saude');
    expect(equivalenceKeyOf('O Aluguel')).toBe('aluguel');
    expect(equivalenceKeyOf('Aluguel')).toBe('aluguel');
  });

  it('NUNCA usa substring solta: ordem e palavra extra mantêm categorias distintas', () => {
    expect(equivalenceKeyOf('Seguro do Carro')).not.toBe(equivalenceKeyOf('Carro Seguro'));
    expect(equivalenceKeyOf('Seguro')).toBe('seguro');
    expect(equivalenceKeyOf('Seguro do Carro')).not.toBe('seguro');
    expect(equivalenceKeyOf('Seguro do Carro')).not.toBe(equivalenceKeyOf('Seguro Residencial'));
    expect(equivalenceKeyOf('Investimentos')).not.toBe(equivalenceKeyOf('Investimento'));
  });
});

describe('betterDisplayName — preserva o nome mais informativo/legível', () => {
  it('"Seguro do Carro" vence "seguro carro" (capitalização adequada)', () => {
    expect(betterDisplayName('Seguro do Carro', 'seguro carro')).toBe('Seguro do Carro');
    expect(betterDisplayName('seguro carro', 'Seguro do Carro')).toBe('Seguro do Carro');
  });

  it('acentuação correta vence variante sem acento', () => {
    expect(betterDisplayName('Saúde', 'saude')).toBe('Saúde');
    expect(betterDisplayName('saude', 'Saúde')).toBe('Saúde');
  });

  it('desempate por ordem de code units é determinístico', () => {
    expect(betterDisplayName('Seguro de Carro', 'Seguro do Carro')).toBe('Seguro de Carro');
    expect(betterDisplayName('Seguro do Carro', 'Seguro de Carro')).toBe('Seguro de Carro');
  });
});

describe('dedupeDisplayNames — exibição única e determinística', () => {
  it('deduplica "Seguro do Carro" ♢ "seguro carro" preservando a forma legível', () => {
    expect(dedupeDisplayNames(['Seguro do Carro', 'seguro carro'])).toEqual(['Seguro do Carro']);
  });

  it('variações de caixa/espaço/preposição deduplicadas de modo determinístico', () => {
    const variants = [
      'Seguro do Carro',
      'seguro carro',
      'Seguro de Carro',
      'seguro do carro',
    ];
    expect(dedupeDisplayNames(variants)).toEqual(['Seguro de Carro']);
    expect(dedupeDisplayNames([...variants].reverse())).toEqual(['Seguro de Carro']);
    expect(dedupeDisplayNames([...variants].sort())).toEqual(['Seguro de Carro']);
  });

  it('categorias realmente diferentes permanecem distintas e na ordem', () => {
    expect(dedupeDisplayNames(['Seguro do Carro', 'Seguro Residencial'])).toEqual([
      'Seguro do Carro',
      'Seguro Residencial',
    ]);
    expect(dedupeDisplayNames(['Seguro Residencial', 'seguro carro'])).toEqual([
      'Seguro Residencial',
      'seguro carro',
    ]);
  });

  it('não agrupa por substring solta (palavra em outra ordem segue distinta)', () => {
    expect(dedupeDisplayNames(['Seguro do Carro', 'Carro Seguro'])).toEqual([
      'Seguro do Carro',
      'Carro Seguro',
    ]);
  });
});

// ═══════════════ Roteador: notice real (fixtures) ═══════════════

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

const SUP = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const SEG_DO_CARRO = { display_name: 'Seguro do Carro', canonical_path: 'Moradia > Seguro do Carro' };
const SEG_CARRO_LC = { display_name: 'seguro carro', canonical_path: 'Seguro > seguro carro' };
const SEG_RESID = { display_name: 'Seguro Residencial', canonical_path: 'Moradia > Seguro Residencial' };

const EXPENSE_CATS: CatFakeRow[] = [
  { ...SUP, direction: 'expense' },
  { ...SEG_DO_CARRO, direction: 'expense' },
  { ...SEG_CARRO_LC, direction: 'expense' },
  { ...SEG_RESID, direction: 'expense' },
];

function mkClient(rows: FakeRow[], cats: CatFakeRow[]): { fake: unknown; calls: string[] } {
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

function rowFor(
  cat: { display_name: string; canonical_path: string | null },
  amount: number,
  d: string,
): FakeRow {
  return {
    transaction_kind: 'expense' as const,
    amount,
    occurred_on: d,
    category_id: `c-${cat.canonical_path ?? cat.display_name}`,
    categories: cat,
  };
}

function monthlyRows(pairs: Array<{ cat: typeof SUP; amount: number }>): FakeRow[] {
  const out: FakeRow[] = [];
  for (const d of [JAN, FEV, MAR, ABR, MAI, JUN]) {
    for (const p of pairs) out.push(rowFor(p.cat, p.amount, d));
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
  rows: FakeRow[],
  cats: CatFakeRow[],
): Promise<{ ans: DeterministicAnswer; fake: unknown; context: ChatContextState }> {
  const { fake } = mkClient(rows, cats);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO: NOW });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, context: contextOf(ans) };
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
  chatSupabaseRef.current = null;
});

describe('PESSOAL-13C3B.21 — notice não repete "Seguro do Carro"/"seguro carro"', () => {
  it('exibe a categoria uma única vez, na forma legível, sem somar registros', async () => {
    const rows = monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: SEG_DO_CARRO, amount: 200 },
      { cat: SEG_CARRO_LC, amount: 300 },
    ]);
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', rows, EXPENSE_CATS);
    const notice = ans.response.notice ?? '';

    expect(notice).toContain('A categoria Seguro do Carro ficou fora: é compromisso fixo e exige análise de contrato e condições.');
    expect((notice.match(/Seguro do Carro/g) ?? []).length).toBe(1);
    expect(notice.toLowerCase()).not.toContain('seguro carro');

    expect(notice).toContain('Simulação de 10% sobre a média mensal recente');
    expect(notice).toContain('É apenas um cenário, não uma previsão nem recomendação automática');
    expect((ans.response.cards ?? []).map((c) => c.title)).toEqual(['Alimentação > Supermercado']);
    expect(ans.response.geminiCallCount).toBe(0);
  });

  it('variações de caixa/espaço/preposição do mesmo seguro viram UMA ocorrência determinística', async () => {
    const SEO_CARRO_L = { display_name: 'Seguro do Carro', canonical_path: 'Moradia > Seguro do Carro' };
    const SEO_CARRO_M = { display_name: 'seguro carro', canonical_path: 'Seguro > seguro carro' };
    const SEO_CARRO_U = { display_name: 'Seguro de Carro', canonical_path: 'Moradia > Seguro de Carro' };
    const SEO_CARRO_N = { display_name: 'seguro do carro', canonical_path: 'Moradia > seguro do carro' };
    const cats: CatFakeRow[] = [
      { ...SUP, direction: 'expense' },
      { ...SEO_CARRO_L, direction: 'expense' },
      { ...SEO_CARRO_M, direction: 'expense' },
      { ...SEO_CARRO_U, direction: 'expense' },
      { ...SEO_CARRO_N, direction: 'expense' },
    ];
    const rows = monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: SEO_CARRO_L, amount: 200 },
      { cat: SEO_CARRO_M, amount: 190 },
      { cat: SEO_CARRO_U, amount: 210 },
      { cat: SEO_CARRO_N, amount: 205 },
    ]);
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', rows, cats);
    const notice = ans.response.notice ?? '';

    expect(notice).toContain('A categoria Seguro de Carro ficou fora: é compromisso fixo e exige análise de contrato e condições.');
    expect((notice.match(/Seguro/g) ?? []).length).toBe(1);
    expect(notice.toLowerCase()).not.toContain('seguro do carro');
    expect(notice.toLowerCase()).not.toContain('seguro carro');
    expect((ans.response.cards ?? []).map((c) => c.title)).toEqual(['Alimentação > Supermercado']);
    expect(ans.response.geminiCallCount).toBe(0);
  });
});

describe('PESSOAL-13C3B.21 — categorias realmente diferentes permanecem distintas', () => {
  it('"Seguro do Carro" e "Seguro Residencial" aparecem como duas categorias', async () => {
    const rows = monthlyRows([
      { cat: SUP, amount: 400 },
      { cat: SEG_DO_CARRO, amount: 200 },
      { cat: SEG_RESID, amount: 250 },
    ]);
    const { ans } = await firstTurn('Onde tenho oportunidades de economia de 10%?', rows, EXPENSE_CATS);
    const notice = ans.response.notice ?? '';

    expect(notice).toContain(
      'As categorias Seguro Residencial e Seguro do Carro ficaram fora: são compromissos fixos e exigem análise de contrato e condições.',
    );
    expect((notice.match(/Seguro do Carro/g) ?? []).length).toBe(1);
    expect((notice.match(/Seguro Residencial/g) ?? []).length).toBe(1);
    expect((ans.response.cards ?? []).map((c) => c.title)).toEqual(['Alimentação > Supermercado']);
    expect(ans.response.geminiCallCount).toBe(0);
  });
});