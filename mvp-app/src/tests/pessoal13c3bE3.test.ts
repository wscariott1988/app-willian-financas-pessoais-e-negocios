// pessoal13c3bE3.test.ts — PESSOAL-13C3B-E3: contexto analítico persistente e
// follow-ups elípticos de tendências/oportunidades.
//
// Prova que:
//   1. turnos analíticos (growth_categories/savings_opportunities) persistem um
//      ChatAnalysisContext serializável — só intent, estilo de janela, datas,
//      percentual e path canônico; JAMAIS valores monetários, cards, UUIDs ou
//      descrições;
//   2. o contexto sobrevive a um round-trip JSON (F5/remount) e os follow-ups
//      re-derivam a janela da âncora persistida (estável entre turnos);
//   3. follow-ups elípticos: "E 5%?", "E com 12,5%?", "E se fosse 20%?" (só em
//      savings), "E só em supermercado?", "E em padaria?" (lente canônica),
//      "E com combustível?" (desconhecida → esclarecimento preservando a
//      análise), "E incluindo este mês?", "E sem incluir este mês?" e
//      "E considerando seis meses completos mais este mês?";
//   4. TODO follow-up reconhecido dispara novas consultas — nunca "recalcula
//      sem consulta" a partir do contexto;
//   5. precedência intacta: perguntas analíticas explícitas respondem antes do
//      contexto, "E em maio?" continua herdando a lente tradicional do C2,
//      contextos legados (sem analysis) seguem 100% iguais ao C2 e "E 5%?"
//      APÓS crescimento não é capturado (Gemini);
//   6. turnos não analíticos e falhas NUNCA contaminam nem sobrescrevem o
//      contexto analítico (puro e via chatStore); idempotência do chat intacta;
//   7. endpoint: profile_id no body é ignorado (identidade vem só do JWT), o
//      contexto analítico persiste via completeChatTurn e o cache (clique
//      duplo) NÃO re-consulta dados.
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
import type { DeterministicAnswer } from '../../server/finance-ai/deterministicRouter';
import { validateAskRequest } from '../../server/finance-ai/orchestrator';
import type { GeminiClient, GeminiResponse } from '../../server/finance-ai/types';
import { contextFromTurn, geminiContextBlock } from '../../server/chat/chatContext';
import type {
  ChatAnalysisContext,
  ChatAnalysisIntent,
  ChatAnalysisWindowStyle,
  ChatContextState,
} from '../../server/chat/chatTypes';
import { beginChatTurn, completeChatTurn, failChatTurn } from '../../server/chat/chatStore';
import type { FailTurnInput } from '../../server/chat/chatStore';
import { handler } from '../../api/finances/ask';
import { createUserSupabaseClient } from '../../server/supabaseServer';

const JSON_HEADERS = { 'content-type': 'application/json' };

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

type CatFakeRow = { display_name: string; canonical_path: string | null; direction?: string };

const SUP_CAT = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const PAD_CAT = { display_name: 'Padaria', canonical_path: 'Alimentação > Padaria' };
const EXPENSE_CATS: CatFakeRow[] = [
  { display_name: 'Alimentação', canonical_path: 'Alimentação', direction: 'expense' },
  { ...SUP_CAT, direction: 'expense' },
  { ...PAD_CAT, direction: 'expense' },
];

function mkClient(
  rows: FakeRow[],
  cats: CatFakeRow[] = [],
): { fake: unknown; calls: string[]; selects: string[] } {
  const calls: string[] = [];
  const selects: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (table: string): Record<string, any> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c3: Record<string, any> = {};
    type F = { op: string; key: string; value: unknown };
    const filters: F[] = [];
    let cols = '*';
    for (const m of ['is', 'gte', 'lte', 'order', 'ilike', 'limit', 'eq', 'in'] as const) {
      c3[m] = (k: string, v?: unknown) => {
        if ((m === 'is' || m === 'gte' || m === 'lte' || m === 'eq') && typeof k === 'string') {
          filters.push({ op: m, key: k, value: v as string | null });
        }
        return c3;
      };
    }
    c3.select = (sel?: string, opts?: { count?: 'exact' }) => {
      cols = sel ?? '*';
      if (cols !== '*') selects.push(cols);
      return { ...c3, _count: opts?.count === 'exact' };
    };
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
      const rowsIn = filtered();
      const page = rowsIn.slice(from, to + 1);
      return {
        ...c3,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: page, count: table === 'transactions' ? page.length : undefined, error: null }),
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
    selects,
  };
}

// ── Fixtures e helpers ──────────────────────────────────────────

const JAN = '2026-01-15';
const FEV = '2026-02-15';
const MAR = '2026-03-15';
const ABR = '2026-04-15';
const MAI = '2026-05-15';
const JUN = '2026-06-15';
const NOW = '2026-07-25';

/** Supermercado cresce 100→400; Padaria 50→150 no último trimestre. */
function growingRows(): FakeRow[] {
  const mk = (occurred_on: string, amount: number, categories: typeof SUP_CAT) => ({
    transaction_kind: 'expense' as const,
    amount,
    occurred_on,
    category_id: categories === SUP_CAT ? 'c-sup' : 'c-pad',
    categories,
  });
  return [
    mk(JAN, 100, SUP_CAT), mk(FEV, 100, SUP_CAT), mk(MAR, 100, SUP_CAT),
    mk(ABR, 400, SUP_CAT), mk(MAI, 400, SUP_CAT), mk(JUN, 400, SUP_CAT),
    mk(JAN, 50, PAD_CAT), mk(FEV, 50, PAD_CAT), mk(MAR, 50, PAD_CAT),
    mk(ABR, 150, PAD_CAT), mk(MAI, 150, PAD_CAT), mk(JUN, 150, PAD_CAT),
  ];
}

function neverGemini(): GeminiClient {
  return {
    async sendMessage(): Promise<GeminiResponse> {
      throw new Error('Gemini NÃO pode ser chamado');
    },
  };
}

const txCount = (calls: string[]): number => calls.filter((t) => t === 'transactions').length;
const catCount = (calls: string[]): number => calls.filter((t) => t === 'categories').length;

/** O MESMO contrato de ask.ts: contexto derivado do turno concluído. */
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
  rows: FakeRow[] = growingRows(),
  nowISO = NOW,
  cats: CatFakeRow[] = [],
): Promise<{ ans: DeterministicAnswer; fake: unknown; calls: string[]; context: ChatContextState }> {
  const { fake, calls } = mkClient(rows, cats);
  const ans = await runDeterministicAsk({ supabase: fake as never, question: q, nowISO });
  if (!ans) throw new Error(`esperado determinístico: "${q}"`);
  return { ans, fake, calls, context: contextOf(ans) };
}

/** Janela canônica da âncora 2026-07-25 (ver buildTrendWindow). */
function windowOf(style: ChatAnalysisWindowStyle): ChatAnalysisContext['window'] {
  if (style === 'five_plus_current') {
    return { start: '2026-02-01', end: '2026-07-25', baseStart: '2026-02-01', baseEnd: '2026-04-30', recentStart: '2026-05-01', recentEnd: '2026-07-25' };
  }
  if (style === 'six_plus_current') {
    return { start: '2026-01-01', end: '2026-07-25', baseStart: '2026-01-01', baseEnd: '2026-03-31', recentStart: '2026-04-01', recentEnd: '2026-06-30' };
  }
  return { start: '2026-01-01', end: '2026-06-30', baseStart: '2026-01-01', baseEnd: '2026-03-31', recentStart: '2026-04-01', recentEnd: '2026-06-30' };
}

/** Contexto analítico pré-persistido (como se um turno anterior tivesse gravado). */
function analysisContext(opts: {
  intent: ChatAnalysisIntent;
  windowStyle?: ChatAnalysisWindowStyle;
  simulationPct?: number;
  categoryPath?: string;
}): ChatContextState {
  const style = opts.windowStyle ?? 'six_complete';
  const window = windowOf(style);
  return contextFromTurn(null, {
    intent: opts.intent,
    category: null,
    periodAnalyzed: { start: window.start, end: window.end },
    answer: 'análise anterior',
    analysis: {
      version: 1,
      intent: opts.intent,
      windowStyle: style,
      anchorDate: NOW,
      window,
      includeCurrentMonth: style !== 'six_complete',
      isPartialCurrent: style !== 'six_complete',
      simulationPct: opts.simulationPct,
      categoryPath: opts.categoryPath,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  registerGeminiClient(neverGemini());
});

// ── 1. Contexto analítico persistente (lógica pura) ─────────────

describe('PESSOAL-13C3B-E3 — turnos analíticos persistem contexto serializável', () => {
  it('growth_categories grava intent/estilo/datas/path — nunca valores, cards ou UUIDs', async () => {
    const { ans, context } = await firstTurn('Quais categorias mais cresceram nos últimos 6 meses?');
    const a = ans.analysis as ChatAnalysisContext;
    expect(a.version).toBe(1);
    expect(a.intent).toBe('growth_categories');
    expect(a.windowStyle).toBe('six_complete');
    expect(a.anchorDate).toBe(NOW);
    expect(a.window).toEqual(windowOf('six_complete'));
    expect(a.includeCurrentMonth).toBe(false);
    expect(a.isPartialCurrent).toBe(false);
    expect(context.analysis).toEqual(a);
    const raw = JSON.stringify(a);
    expect(raw).not.toContain('R$');
    expect(raw).not.toContain('400,00');
    expect(raw).not.toContain('300%');
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('savings_opportunities grava também o percentual padrão da simulação', async () => {
    const { context } = await firstTurn('Onde posso economizar mais?');
    expect(context.analysis?.intent).toBe('savings_opportunities');
    expect(context.analysis?.simulationPct).toBe(10);
    expect(context.analysis?.windowStyle).toBe('six_complete');
  });

  it('round-trip JSON (F5/remount) preserva a análise e os follow-ups re-derivam da âncora', async () => {
    const { ans, fake, calls } = await firstTurn(
      'Quanto eu economizaria reduzindo 12,5%?',
      growingRows(),
      NOW,
      EXPENSE_CATS,
    );
    const restored: ChatContextState = JSON.parse(JSON.stringify(contextOf(ans)));
    expect(restored.analysis?.simulationPct).toBe(12.5);

    const txBefore = txCount(calls);
    // nowISO "futuro" é ignorado: a janela vem da âncora persistida (estável entre turnos).
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E 5%?',
      context: restored,
      nowISO: '2060-01-01',
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.simulationPct).toBe(5);
    expect(fu?.response.period).toEqual({ start: '2026-01-01', end: '2026-06-30' });
    expect(txCount(calls)).toBeGreaterThan(txBefore);

    const fu2 = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E só em supermercado?',
      context: JSON.parse(JSON.stringify(restored)) as ChatContextState,
      nowISO: '2060-01-01',
    });
    expect(fu2?.analysis?.categoryPath).toBe('Alimentação > Supermercado');
    expect(fu2?.response.period).toEqual({ start: '2026-01-01', end: '2026-06-30' });
  });

  it('contexto legado (sem analysis) segue 100% igual ao C2: "E em maio?" herda lente e "E 5%?" não é capturado', async () => {
    const legacy: ChatContextState = {
      category: 'Alimentação > Supermercado',
      intent: 'category_total',
      period: { start: '2026-05-01', end: '2026-05-31' },
      summaries: [],
    };
    const { fake } = mkClient(growingRows(), EXPENSE_CATS);
    const may = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E em maio?',
      context: legacy,
      nowISO: NOW,
    });
    expect(may?.intent).toBe('category_total');
    expect(may?.category).toBe('Alimentação > Supermercado');
    expect(may?.response.answer).toContain('400,00');

    const pct = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E 5%?',
      context: legacy,
      nowISO: NOW,
    });
    expect(pct?.intent).not.toBe('savings_opportunities');
    expect(pct?.analysis?.simulationPct).toBeUndefined();
  });

  it('turno não analítico concluído LIMPA o contexto analítico (nunca sobrevive)', () => {
    const prev = analysisContext({ intent: 'growth_categories' });
    const next = contextFromTurn(prev, {
      intent: 'total_expenses',
      category: null,
      periodAnalyzed: { start: '2026-05-01', end: '2026-05-31' },
      answer: 'Suas despesas totalizaram R$ 100,00.',
    });
    expect(next.analysis).toBeNull();
  });

  it('turno tradicional (total_expenses) não grava análise e conversa nova começa sem ela', async () => {
    const { fake } = mkClient([{ transaction_kind: 'expense', amount: 10, occurred_on: '2026-04-05', categories: SUP_CAT }]);
    const ans = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quanto gastei em abril?',
      period: { start: '2026-04-01', end: '2026-04-30' },
      nowISO: NOW,
    });
    expect(ans?.intent).toBe('total_expenses');
    expect(contextOf(ans as DeterministicAnswer).analysis).toBeNull();
  });

  it('bloco compacto do Gemini NUNCA referencia o contexto analítico', () => {
    const ctx = analysisContext({ intent: 'savings_opportunities', simulationPct: 12.5 });
    const block = geminiContextBlock(ctx);
    expect(block).not.toContain('analysis');
    expect(block).not.toContain('simulationPct');
    expect(block).not.toContain('windowStyle');
    expect(block).not.toContain('anchorDate');
    expect(block).not.toContain('isPartialCurrent');
  });

  it('nada sensível vaza no JSON persistido da análise', async () => {
    const { context } = await firstTurn('Onde posso economizar mais?');
    const raw = JSON.stringify(context.analysis);
    expect(raw).not.toContain('R$');
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(raw).not.toContain('cards');
    expect(raw).not.toContain('descricao');
    expect(raw).not.toContain('40,00');
    expect(raw).toContain('simulationPct');
    expect(raw).toContain('six_complete');
  });
});

// ── 2. Follow-ups de PERCENTUAL (somente savings) ───────────────

describe('PESSOAL-13C3B-E3 — follow-up elíptico de percentual', () => {
  it.each<[string, number]>([
    ['E 5%?', 5],
    ['E com 12,5%?', 12.5],
    ['E se fosse 20%?', 20],
  ])('"%s" aplica %s sem pergunta completa e com nova consulta', async (q, expected) => {
    const { context, fake, calls } = await firstTurn('Onde posso economizar mais?');
    const before = txCount(calls);
    const fu = await runDeterministicAsk({ supabase: fake as never, question: q, context, nowISO: NOW });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.simulationPct).toBe(expected);
    expect(fu?.response.engine).toBe('deterministic');
    expect(fu?.response.geminiCallCount).toBe(0);
    expect(txCount(calls)).toBeGreaterThan(before);
  });

  it('"E 5%?" re-apresenta a simulação (SUPER média 400 → 20/mês → 240/ano)', async () => {
    const { context, fake } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({ supabase: fake as never, question: 'E 5%?', context, nowISO: NOW });
    const rows = Object.fromEntries((fu?.response.cards?.[0]?.rows ?? []).map((r) => [r.label, r.value]));
    expect(rows['Economia mensal (cenário 5%)']).toContain('20,00');
    expect(rows['Projeção anual (simulação)']).toContain('240,00');
  });

  it('"E com 0%?" responde amigável (nunca 500), cards vazios e análise sem parcela de percentual', async () => {
    const { context, fake } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({ supabase: fake as never, question: 'E com 0%?', context, nowISO: NOW });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.response.engine).toBe('deterministic');
    expect(fu?.response.geminiCallCount).toBe(0);
    expect(fu?.response.cards).toEqual([]);
    expect(fu?.response.answer).toContain('Informe um percentual entre 0 e 100');
    expect(fu?.analysis?.simulationPct).toBeUndefined();
    expect(fu?.analysis?.intent).toBe('savings_opportunities');
  });

  it('"E 5%?" APÓS crescimento NÃO é capturado (ambiguidade → Gemini), mas a pergunta completa explícita continua respondendo', async () => {
    const { context, fake } = await firstTurn('Quais categorias mais cresceram nos últimos 6 meses?');
    const pct = await runDeterministicAsk({ supabase: fake as never, question: 'E 5%?', context, nowISO: NOW });
    expect(pct).toBeNull();

    const explicit = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E se eu reduzisse meus gastos em 5%?',
      context,
      nowISO: NOW,
    });
    expect(explicit?.intent).toBe('savings_opportunities');
    expect(explicit?.analysis?.simulationPct).toBe(5);
  });
});

// ── 3. Follow-ups de CATEGORIA (lente canônica preservada) ──────

describe('PESSOAL-13C3B-E3 — follow-up elíptico de categoria', () => {
  it('"E só em supermercado?" preserva intent/janela/percentual e troca a lente', async () => {
    const { context, fake } = await firstTurn(
      'Quanto eu economizaria reduzindo 12,5%?',
      growingRows(),
      NOW,
      EXPENSE_CATS,
    );
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E só em supermercado?',
      context,
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.analysis?.categoryPath).toBe('Alimentação > Supermercado');
    expect(fu?.analysis?.simulationPct).toBe(12.5);
    expect(fu?.analysis?.windowStyle).toBe('six_complete');
    expect(fu?.response.period).toEqual({ start: '2026-01-01', end: '2026-06-30' });
    const cards = fu?.response.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('Alimentação > Supermercado');
    const rows = Object.fromEntries((cards[0]?.rows ?? []).map((r) => [r.label, r.value]));
    expect(rows['Economia mensal (cenário 12,5%)']).toContain('50,00');
  });

  it('"E em padaria?" após crescimento restringe a lente canônica (Padaria 50→150 = 200%)', async () => {
    const { context, fake } = await firstTurn(
      'Quais categorias mais cresceram nos últimos 6 meses?',
      growingRows(),
      NOW,
      EXPENSE_CATS,
    );
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E em padaria?',
      context,
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('growth_categories');
    expect(fu?.analysis?.categoryPath).toBe('Alimentação > Padaria');
    const cards = fu?.response.cards ?? [];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('Alimentação > Padaria');
    expect(cards[0]?.kind).toBe('growth');
    const rows = Object.fromEntries((cards[0]?.rows ?? []).map((r) => [r.label, r.value]));
    expect(rows['Variação relativa']).toBe('200%');
  });

  it('"E com combustível?" (categoria inexistente) → esclarecimento amigável PRESERVANDO a análise anterior', async () => {
    const { context, fake } = await firstTurn('Onde posso economizar mais?', growingRows(), NOW, EXPENSE_CATS);
    const fu = await runDeterministicAsk({
      supabase: fake as never,
      question: 'E com combustível?',
      context,
      nowISO: NOW,
    });
    expect(fu?.intent).toBe('savings_opportunities');
    expect(fu?.response.answer).toContain('Não consegui identificar a categoria');
    expect(fu?.response.cards).toEqual([]);
    expect(fu?.response.toolsUsed).toContain('trend_savings');
    expect(fu?.analysis).toEqual(context.analysis);
  });
});

// ── 4. Follow-ups de JANELA (ângulo do período analisado) ───────

describe('PESSOAL-13C3B-E3 — follow-up elíptico de janela', () => {
  it.each<[string, { start: string; end: string }, ChatAnalysisWindowStyle]>([
    ['E incluindo este mês?', { start: '2026-02-01', end: '2026-07-25' }, 'five_plus_current'],
    ['E até hoje?', { start: '2026-02-01', end: '2026-07-25' }, 'five_plus_current'],
    ['E sem incluir este mês?', { start: '2026-01-01', end: '2026-06-30' }, 'six_complete'],
    ['E considerando seis meses completos mais este mês?', { start: '2026-01-01', end: '2026-07-25' }, 'six_plus_current'],
  ])('"%s" → %s (nova consulta) e grava o novo estilo', async (q, expected, style) => {
    const { context, fake, calls } = await firstTurn('Onde aumentei mais meus gastos?');
    const before = txCount(calls);
    const fu = await runDeterministicAsk({ supabase: fake as never, question: q, context, nowISO: NOW });
    expect(fu?.intent).toBe('growth_categories');
    expect(fu?.response.engine).toBe('deterministic');
    expect(fu?.response.period).toEqual(expected);
    expect(fu?.analysis?.windowStyle).toBe(style);
    expect(fu?.analysis?.includeCurrentMonth).toBe(style !== 'six_complete');
    expect(txCount(calls)).toBeGreaterThan(before);
  });

  it('"E 5%?" sobre savings re-deriva a janela da âncora mesmo sem data explícita', async () => {
    const { context, fake } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({ supabase: fake as never, question: 'E 5%?', context, nowISO: NOW });
    expect(fu?.response.period).toEqual({ start: '2026-01-01', end: '2026-06-30' });
    expect(fu?.analysis?.windowStyle).toBe('six_complete');
  });
});

// ── 5. Precedência e não-captura ────────────────────────────────

describe('PESSOAL-13C3B-E3 — precedência e intents existentes preservados', () => {
  it('pergunta analítica EXPLÍCITA sempre responde antes do contexto (nunca é engolida)', async () => {
    const { context, fake } = await firstTurn('Onde posso economizar mais?');
    const growth = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quais categorias mais cresceram?',
      context,
      nowISO: NOW,
    });
    expect(growth?.intent).toBe('growth_categories');

    const total = await runDeterministicAsk({
      supabase: fake as never,
      question: 'Quanto gastei no mês?',
      context,
      nowISO: NOW,
    });
    expect(total?.intent).toBe('total_expenses');
    expect(total?.response.engine).toBe('deterministic');
  });

  it('follow-up sem sinais analíticos nem período → Gemini (roteador devolve null)', async () => {
    const { context, fake } = await firstTurn('Quais categorias mais cresceram nos últimos 6 meses?');
    for (const q of ['E o que você acha disso?', 'E depois disso?', 'E como ficaria?']) {
      const fu = await runDeterministicAsk({ supabase: fake as never, question: q, context, nowISO: NOW });
      expect(fu).toBeNull();
    }
  });

  it('"E em maio?" NÃO vira lente de análise (mês é rejeitado como termo de categoria)', async () => {
    const { context, fake } = await firstTurn('Onde posso economizar mais?');
    const fu = await runDeterministicAsk({ supabase: fake as never, question: 'E em maio?', context, nowISO: NOW });
    expect(fu).toBeNull();
  });

  it('todo follow-up reconhecido dispara NOVAS consultas (nunca "recalcula sem consulta")', async () => {
    const { context, fake, calls } = await firstTurn(
      'Onde posso economizar mais?',
      growingRows(),
      NOW,
      EXPENSE_CATS,
    );
    const t0 = txCount(calls);
    const c0 = catCount(calls);

    await runDeterministicAsk({ supabase: fake as never, question: 'E 5%?', context, nowISO: NOW });
    expect(txCount(calls)).toBeGreaterThan(t0);

    await runDeterministicAsk({ supabase: fake as never, question: 'E só em supermercado?', context, nowISO: NOW });
    expect(catCount(calls)).toBeGreaterThan(c0);
    expect(txCount(calls)).toBeGreaterThan(t0 + 1);

    await runDeterministicAsk({ supabase: fake as never, question: 'E incluindo este mês?', context, nowISO: NOW });
    expect(txCount(calls)).toBeGreaterThan(t0 + 2);
  });
});

// ── 6. chatStore + endpoint: persistência, falha inócua e idempotência ──────

// FailTurnInput NÃO carrega contexto: a falha nunca pode sobrescrever a análise.
// Se alguém adicionar `context` ao FailTurnInput, esta atribuição deixa de
// compilar (falso) — garantia de contrato em tempo de compilação.
type FailTurnKeys = keyof FailTurnInput;
type FailHasNoContext = 'context' extends FailTurnKeys ? true : false;
const failHasNoContext: FailHasNoContext = false;

type Row = Record<string, any>;

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

function uniqViolation(): Error & { code: string } {
  const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  e.code = '23505';
  return e;
}

function conflictEq(a: unknown, b: unknown): boolean {
  return a !== null && b !== null && a === b;
}

/** Client com estado (subset do C2) para chatStore + endpoint. */
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
      const v = row[f.key];
      if (f.op === 'is') return f.value === null ? v === null || v === undefined : v === f.value;
      if (f.op === 'eq') return v === f.value;
      if (f.op === 'gte') return typeof v === 'string' ? v >= (f.value as string) : v >= (f.value as number);
      if (f.op === 'lte') return typeof v === 'string' ? v <= (f.value as string) : v <= (f.value as number);
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
          const av = a[o.key];
          const qv = q[o.key];
          if (av === qv) return 0;
          if (av === undefined) return 1;
          if (qv === undefined) return -1;
          return av < qv ? -1 : 1;
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
      if (b.maybe || b.single) return { data: page[0] ?? null, count: b.countOpt ? total : null, error: null };
      return { data: page, count: b.countOpt ? total : null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: Record<string, any> = {
      select(_cols = '*', opts?: { count?: 'exact' }) {
        b.countOpt = opts?.count === 'exact';
        return base;
      },
      is(key: string, value: unknown) {
        b.filters.push({ op: 'is', key, value });
        return base;
      },
      eq(key: string, value: unknown) {
        b.filters.push({ op: 'eq', key, value });
        return base;
      },
      gte(key: string, value: unknown) {
        b.filters.push({ op: 'gte', key, value });
        return base;
      },
      lte(key: string, value: unknown) {
        b.filters.push({ op: 'lte', key, value });
        return base;
      },
      order(key: string, opts?: { ascending?: boolean }) {
        b.orders.push({ key, asc: opts?.ascending ?? true });
        return base;
      },
      limit(limit: number) {
        b.toRange = limit - 1;
        return base;
      },
      range(from: number, to: number) {
        b.fromRange = from;
        b.toRange = to;
        return base;
      },
      maybeSingle() {
        b.maybe = true;
        return base;
      },
      single() {
        b.single = true;
        return base;
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        b.action = 'upsert';
        b.rows = Array.isArray(rows) ? rows : [rows];
        b.onConflict = opts?.onConflict ?? 'id';
        b.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        return base;
      },
      insert(rows: Row) {
        b.action = 'insert';
        b.rows = [rows];
        return base;
      },
      update(patch: Record<string, unknown>) {
        b.action = 'update';
        b.patch = patch;
        return base;
      },
      then(resolve: (v: unknown) => unknown) {
        return resolve(run());
      },
    };
    return base;
  }
}

const CONV = { id: 'conv-1', title: '', context: null, created_at: '', updated_at: '', last_message_at: '' };

function authOk(client: StateFake): void {
  vi.mocked(createUserSupabaseClient).mockResolvedValueOnce({
    client: client as never,
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

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

describe('PESSOAL-13C3B-E3 — chatStore: análise persiste e falha NUNCA sobrescreve', () => {
  it('FailTurnInput não aceita contexto (tempo de compilação) e a análise persiste após o fail', async () => {
    expect(failHasNoContext).toBe(false);
    const c = new StateFake();
    c.state.chat_conversations = [{ ...CONV }];
    await completeChatTurn(c as never, {
      conversationId: 'conv-1',
      clientRequestId: 'r1',
      answer: 'análise',
      payload: { engine: 'deterministic', geminiCallCount: 0, toolsUsed: ['trend_growth'], evidence: [] },
      intent: 'growth_categories',
      engine: 'deterministic',
      periodAnalyzed: { start: '2026-01-01', end: '2026-06-30' },
      context: analysisContext({ intent: 'growth_categories' }),
      setTitle: false,
      title: '',
    });
    expect(c.state.chat_conversations[0].context?.analysis?.intent).toBe('growth_categories');

    const begun = await beginChatTurn(c as never, {
      conversationId: 'conv-1',
      clientRequestId: 'r2',
      question: 'E só em supermercado?',
    });
    expect(begun.kind).toBe('fresh');

    await failChatTurn(c as never, { conversationId: 'conv-1', clientRequestId: 'r2', message: 'Falhou.' });
    expect(c.state.chat_conversations[0].context?.analysis?.intent).toBe('growth_categories');
    const anchor = c.state.chat_messages.find((m) => m.role === 'assistant' && m.client_request_id === 'r2');
    expect(anchor?.status).toBe('failed');
  });
});

describe('PESSOAL-13C3B-E3 — endpoint: perfil do body ignorado e idempotência intacta', () => {
  it('validateAskRequest ignora campos desconhecidos (profile_id nunca é identidade)', () => {
    expect(
      validateAskRequest({
        question: 'Quanto gastei em abril?',
        period: { start: '2026-04-01', end: '2026-04-30' },
        profile_id: 'p-000',
      }),
    ).toEqual({ ok: true });
  });

  it('profile_id no body → 200 determinístico e a tabela profiles NUNCA é consultada', async () => {
    registerGeminiClient(neverGemini());
    const c = new StateFake();
    c.state.transactions = [
      { transaction_kind: 'expense', amount: 100, occurred_on: '2026-04-05', deleted_at: null, categories: SUP_CAT },
    ];
    c.state.categories = [...EXPENSE_CATS];
    authOk(c);
    const res = await handler(
      postRequest({
        question: 'Quanto gastei em abril?',
        period: { start: '2026-04-01', end: '2026-04-30' },
        profile_id: 'p-000',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engine?: string; answer: string };
    expect(body.engine).toBe('deterministic');
    expect(body.answer).toContain(brl(100));
    const tables = c.calls.map((x) => x.table);
    expect(tables).not.toContain('profiles');
    expect(tables).not.toContain('chat_messages');
  });

  it('"E 5%?" via endpoint persiste a análise completa e o clique duplo NÃO re-consulta', async () => {
    registerGeminiClient(neverGemini());
    const c = new StateFake();
    c.state.transactions = growingRows();
    c.state.categories = [...EXPENSE_CATS];
    c.state.chat_conversations = [{ ...CONV, context: analysisContext({ intent: 'savings_opportunities', simulationPct: 10 }) }];
    c.state.chat_messages = [];
    authOk(c);
    const body1 = {
      question: 'E 5%?',
      period: { start: '2026-01-01', end: '2026-06-30' },
      conversationId: 'conv-1',
      clientRequestId: 'r1',
    };
    const res1 = await handler(postRequest(body1));
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as { engine?: string; answer: string };
    expect(b1.engine).toBe('deterministic');
    expect(b1.answer).toContain('Com uma redução de 5%');
    const conv = c.state.chat_conversations[0];
    expect(conv.context?.analysis?.simulationPct).toBe(5);
    expect(conv.context?.analysis?.intent).toBe('savings_opportunities');
    const msgs = c.state.chat_messages;
    expect(msgs).toHaveLength(2);
    expect(msgs.filter((m) => m.role === 'assistant' && m.status === 'completed')).toHaveLength(1);
    const txAfterFirst = txCount(c.calls.map((x) => x.table));

    authOk(c);
    const res2 = await handler(postRequest(body1));
    expect(res2.status).toBe(200);
    const b2 = (await res2.json()) as { engine?: string; answer: string };
    expect(b2.engine).toBe('deterministic');
    expect(b2.answer).toBe(b1.answer);
    expect(txCount(c.calls.map((x) => x.table))).toBe(txAfterFirst);
    expect(c.state.chat_messages).toHaveLength(2);
  });
});