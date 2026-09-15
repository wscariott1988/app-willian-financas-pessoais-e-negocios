// pessoal13b3dMonthlyAggregate.test.ts — PESSOAL-13B3.12: agregação mensal
// determinística de despesas (expense_monthly_aggregate) + coerência de resposta.
//
// Fixtures 100% fictícias. Nenhuma chamada real a Gemini/Supabase; nenhum JWT
// real; nenhum dado financeiro verdadeiro. Cobre:
//  1. despesas de supermercado em vários meses; 2. mês vencedor correto;
//  3. valor e quantidade corretos; 4. categoria/subcategoria com path canônico;
//  5. variações de maiúsculas e acentos; 6. receitas/transferências excluídas;
//  7. sem dados; 8. empate entre meses; 9. >20 despesas (sem truncamento);
// 10. consulta mensal; 11. período exibido = período consultado;
// 12. cards e texto coerentes; 13. nenhuma marcação Markdown literal;
// 14. uma única ferramenta para comparação anual; 15. functionResponse contínuo;
// 16. nenhuma informação sensível em logs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expenseMonthlyAggregate,
  normalizeCategoryTerm,
  matchesCategoryTerm,
  type ExpenseMonthlyAggregateResult,
} from '../lib/analyticsInsights';
import type { AnalyticsTxRow } from '../lib/analytics';
import { stripMarkdownMarkers } from '../lib/financeAiClient';
import {
  FINANCE_TOOL_NAMES,
  getFinanceTool,
  toolResultToEvidence,
} from '../../server/finance-ai/toolRegistry';
import {
  runFinanceAsk,
  toolSchemasForGemini,
} from '../../server/finance-ai/orchestrator';
import { OBSERVABILITY_FIELDS } from '../../server/finance-ai/observability';
import type { GeminiClient, GeminiMessage, GeminiResponse } from '../../server/finance-ai/types';

const here = dirname(fileURLToPath(import.meta.url));

const SUPER = { display_name: 'Supermercado', canonical_path: 'Alimentação > Supermercado' };
const ALIMENTACAO = { display_name: 'Alimentação', canonical_path: 'Alimentação' };
const TRANSPORTE = { display_name: 'Transporte', canonical_path: 'Transporte' };

type Cat = { display_name: string; canonical_path: string | null };

function tx(
  id: string,
  occurredOn: string,
  amount: number,
  cats: Cat | null = SUPER,
  kind: 'expense' | 'income' | 'transfer' = 'expense',
): AnalyticsTxRow {
  return {
    id,
    transaction_kind: kind,
    amount,
    account_id: 'ACCT-1',
    category_id: cats ? 'cat-' + id : null,
    occurred_on: occurredOn,
    status: 'posted',
    raw_description: 'Despesa fictícia',
    accounts: { display_name: 'Conta Teste' },
    categories: cats,
  };
}

/** Mês de referência da análise (ano corrente fictício de teste). */
const REF = '2026-09-13';

// ── Fixtures de supermercado (vários meses, vencedor = março) ───────────────

function superRows(): AnalyticsTxRow[] {
  return [
    tx('s-jan-1', '2026-01-05', 100),
    tx('s-jan-2', '2026-01-12', 150),
    tx('s-jan-3', '2026-01-28', 50),
    tx('s-mar-1', '2026-03-03', 200),
    tx('s-mar-2', '2026-03-17', 200),
    tx('s-jul-1', '2026-07-09', 50),
    tx('t-fev-1', '2026-02-10', 9999, TRANSPORTE),
    tx('r-fev-1', '2026-02-11', 9999, ALIMENTACAO, 'income'),
    tx('x-fev-1', '2026-02-12', 9999, ALIMENTACAO, 'transfer'),
  ];
}

describe('PESSOAL-13B3.12 — Agregação mensal pura (motor determinístico)', () => {
  it('1) identifica o mês com maior gasto entre vários meses com supermercado', () => {
    const r = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(r.hasData).toBe(true);
    expect(r.months.map((m) => m.key)).toEqual(['2026-01', '2026-03', '2026-07']);
    expect(r.months.find((m) => m.key === '2026-01')?.amount).toBe(300);
    expect(r.months.find((m) => m.key === '2026-03')?.amount).toBe(400);
    expect(r.months.find((m) => m.key === '2026-07')?.amount).toBe(50);
  });

  it('2) mês vencedor é março de 2026', () => {
    const r = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(r.winnerMonths).toEqual([{ key: '2026-03', monthLabel: 'março de 2026' }]);
  });

  it('3) valor e quantidade do vencedor corretos', () => {
    const r = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(r.winnerAmount).toBe(400);
    expect(r.winnerCount).toBe(2);
    expect(r.totalAmount).toBe(750);
    expect(r.totalCount).toBe(6);
  });

  it('4) casa categoria "Supermercado" e subcategoria "Alimentação > Supermercado"', () => {
    const byCat = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    const bySub = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      subcategory: 'Alimentação > Supermercado',
    });
    expect(byCat.totalCount).toBe(6);
    expect(bySub.totalCount).toBe(6);
    expect(bySub.winnerMonths[0].key).toBe('2026-03');
    expect(bySub.matchedCategory).toBe('Alimentação > Supermercado');
  });

  it('5) variações de maiúsculas/acentos/espacos casam o mesmo conjunto', () => {
    const inputs = [
      'SUPERMERCADO',
      'supermercado ',
      'SuperMercado',
      'súpermercado',
      'alimentação',
      'ALIMENTACAO',
    ];
    let expected: string | null = null;
    for (const input of inputs) {
      const r = expenseMonthlyAggregate(superRows(), {
        start: '2026-01-01',
        end: '2026-12-31',
        category: input,
      });
      const sig = JSON.stringify([r.winnerMonths, r.winnerAmount, r.winnerCount, r.totalCount]);
      if (expected === null) expected = sig;
      expect(sig).toBe(expected);
      expect(r.totalCount).toBe(6);
    }
  });

  it('5b) normalização remove acentos e colapsa espacos', () => {
    expect(normalizeCategoryTerm('  Alimentação  >   Supermercado  ')).toBe('alimentacao > supermercado');
    expect(normalizeCategoryTerm('SUPERMERCADO')).toBe('supermercado');
    const row = superRows()[0];
    expect(matchesCategoryTerm(row, 'supermercado')).toBe(true);
    expect(matchesCategoryTerm(row, 'ALIMENTACAO')).toBe(true);
    expect(matchesCategoryTerm(row, 'alimentacao > supermercado')).toBe(true);
    expect(matchesCategoryTerm(row, '')).toBe(true);
    expect(matchesCategoryTerm(row, 'inexistente')).toBe(false);
  });

  it('6) receitas e transferências são excluídas mesmo da mesma categoria', () => {
    const r = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Alimentação',
    });
    // Alimentação agrega as despesas de supermercado; a receita (9999) e o
    // saque/transferência (9999) de alimentação NÃO entram.
    expect(r.totalCount).toBe(6);
    expect(r.totalAmount).toBe(750);
    expect(r.kind).toBe('expense');
  });

  it('7) sem dados → hasData false e resposta clara', () => {
    const empty = expenseMonthlyAggregate([], {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(empty.hasData).toBe(false);
    expect(empty.months).toEqual([]);
    expect(empty.winnerMonths).toEqual([]);
    expect(empty.winnerAmount).toBe(0);
    expect(empty.winnerCount).toBe(0);
    const noMatch = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Categoria inexistente',
    });
    expect(noMatch.hasData).toBe(false);
  });

  it('8) empate entre meses → todos os meses empatados são informados', () => {
    const rows = [
      tx('t1', '2026-02-05', 100),
      tx('t2', '2026-02-09', 200),
      tx('t3', '2026-05-11', 200),
      tx('t4', '2026-05-21', 100),
    ];
    const r = expenseMonthlyAggregate(rows, {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(r.winnerAmount).toBe(300);
    expect(r.winnerMonths.map((w) => w.key).sort()).toEqual(['2026-02', '2026-05']);
    expect(r.winnerCount).toBe(4);
  });

  it('9) mais de 20 despesas: nenhum truncamento (soma e contagem completas)', () => {
    const rows: AnalyticsTxRow[] = [];
    for (let i = 1; i <= 25; i += 1) {
      rows.push(tx(`s-${i}`, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, 10));
    }
    rows.push(tx('s-extra', '2026-01-10', 5));
    const r = expenseMonthlyAggregate(rows, {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(r.totalCount).toBe(26);
    expect(r.totalAmount).toBe(255);
    expect(r.months.find((m) => m.key === '2026-03')?.count).toBe(25);
    expect(r.winnerCount).toBe(25);
    expect(r.winnerMonths).toEqual([{ key: '2026-03', monthLabel: 'março de 2026' }]);
  });

  it('10) consulta mensal: total e quantidade de despesas do mês', () => {
    const r = expenseMonthlyAggregate(superRows(), {
      start: '2026-03-01',
      end: '2026-03-31',
      category: 'Supermercado',
    });
    expect(r.months).toHaveLength(1);
    expect(r.months[0].key).toBe('2026-03');
    expect(r.totalAmount).toBe(400);
    expect(r.totalCount).toBe(2);
    expect(r.winnerAmount).toBe(400);
    expect(r.winnerCount).toBe(2);
  });

  it('11) período exibido é exatamente o período realmente consultado', () => {
    const r = expenseMonthlyAggregate(superRows(), {
      start: '2026-01-01',
      end: '2026-12-31',
      category: 'Supermercado',
    });
    expect(r.periodAnalyzed).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    const monthly = expenseMonthlyAggregate(superRows(), {
      start: '2026-03-01',
      end: '2026-03-31',
    });
    expect(monthly.periodAnalyzed).toEqual({ start: '2026-03-01', end: '2026-03-31' });
  });
});

// ── Ferramenta expense_monthly_aggregate (executor read-only) ──────────────

function okSupabase(rows: AnalyticsTxRow[]): unknown {
  const chain: Record<string, unknown> = {
    select: () => chain,
    is: () => chain,
    gte: () => chain,
    lte: () => chain,
  };
  (chain as { then?: unknown }).then = (
    resolve: (v: unknown) => unknown,
  ) => Promise.resolve(resolve({ data: rows, error: null }));
  return { from: () => chain };
}

describe('PESSOAL-13B3.12 — Ferramenta expense_monthly_aggregate', () => {
  it('está registrada e é read-only (sem limit/ordenação parcial)', () => {
    expect(FINANCE_TOOL_NAMES).toContain('expense_monthly_aggregate');
    const tool = getFinanceTool('expense_monthly_aggregate');
    expect(tool).not.toBeNull();
    const optSchema = tool?.argSchema ?? {};
    for (const key of ['start', 'end', 'kind', 'category', 'subcategory']) {
      expect(optSchema[key]).toBeTruthy();
    }
  });

  it('schema exposto ao Gemini inclui categoria/subcategoria/kind', () => {
    const schemas = toolSchemasForGemini();
    const agg = schemas.find((s) => s.name === 'expense_monthly_aggregate');
    expect(agg).toBeTruthy();
    const parameters = agg?.parameters as Record<string, unknown> | undefined;
    const props = parameters?.properties as Record<string, unknown> | undefined;
    expect(Object.keys(props ?? {}).sort()).toEqual(
      ['category', 'end', 'kind', 'start', 'subcategory'].sort(),
    );
  });

  it('executa somando TODAS as despesas (mais de 20) sem truncamento', async () => {
    const rows: AnalyticsTxRow[] = [];
    for (let i = 1; i <= 25; i += 1) {
      rows.push(tx(`s-${i}`, '2026-03-05', 10));
    }
    rows.push(tx('s-jan', '2026-01-06', 20));
    rows.push(tx('inc', '2026-03-05', 99999, ALIMENTACAO, 'income'));
    rows.push(tx('transf', '2026-03-05', 99999, ALIMENTACAO, 'transfer'));

    const tool = getFinanceTool('expense_monthly_aggregate')!;
    const result = (await tool.execute(
      okSupabase(rows) as never,
      { start: '2026-01-01', end: '2026-12-31', category: 'SUPERMERCADO' },
      REF,
    )) as ExpenseMonthlyAggregateResult;
    expect(result.totalCount).toBe(26);
    expect(result.totalAmount).toBe(270);
    expect(result.winnerCount).toBe(25);
    expect(result.periodAnalyzed).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('sem start/end usa o ano corrente (determinístico) e reporta o período', async () => {
    const tool = getFinanceTool('expense_monthly_aggregate')!;
    const result = (await tool.execute(
      okSupabase([tx('s-1', '2026-05-05', 100)]) as never,
      {},
      REF,
    )) as ExpenseMonthlyAggregateResult;
    expect(result.periodAnalyzed).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(result.months[0].key).toBe('2026-05');
  });

  it('evidências (cards) são coerentes com o texto: valor, quantidade e período', () => {
    const result: ExpenseMonthlyAggregateResult = {
      hasData: true,
      kind: 'expense',
      categoryFiltered: true,
      matchedCategory: 'Supermercado',
      periodAnalyzed: { start: '2026-01-01', end: '2026-12-31' },
      months: [],
      winnerMonths: [{ key: '2026-03', monthLabel: 'março de 2026' }],
      winnerAmount: 400,
      winnerCount: 2,
      totalAmount: 750,
      totalCount: 6,
    };
    const ev = toolResultToEvidence('expense_monthly_aggregate', result);
    const evN = ev.map((e) => [e.label, e.value.replace(/\u00A0/g, ' ')] as const);
    expect(evN).toContainEqual(['março de 2026 com maior gasto', 'R$ 400,00']);
    expect(evN).toContainEqual(['Despesas consideradas', '2']);
    expect(evN).toContainEqual(['Período analisado', '01/01/2026 a 31/12/2026']);
    const allValues = ev.map((e) => `${e.label}|${e.value}`).join('\n');
    expect(allValues).not.toMatch(/\*\*|\*|__|_|#|```/);
  });

  it('evidência de sem-dados informa claramente que não há despesas', () => {
    const result: ExpenseMonthlyAggregateResult = {
      hasData: false,
      kind: 'expense',
      categoryFiltered: true,
      matchedCategory: 'Supermercado',
      periodAnalyzed: { start: '2026-01-01', end: '2026-12-31' },
      months: [],
      winnerMonths: [],
      winnerAmount: 0,
      winnerCount: 0,
      totalAmount: 0,
      totalCount: 0,
    };
    const ev = toolResultToEvidence('expense_monthly_aggregate', result);
    expect(ev).toContainEqual({ label: 'Despesas no período', value: 'Nenhuma encontrada' });
  });
});

// ── Orquestração: UMA única ferramenta + período consultado ────────────────

describe('PESSOAL-13B3.12 — Orquestração da comparação anual', () => {
  it('14) resolve com uma única execução financeira e tool, sem iteração mês a mês', async () => {
    const rows = superRows();
    let turn = 0;
    let followup: GeminiMessage[] = [];
    const gemini: GeminiClient = {
      async sendMessage(messages: GeminiMessage[]): Promise<GeminiResponse> {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            functionCalls: [
              {
                id: 'fc-agg-1',
                name: 'expense_monthly_aggregate',
                args: { start: '2026-01-01', end: '2026-12-31', category: 'Supermercado' },
              },
            ],
          };
        }
        followup = messages;
        return {
          text:
            'Em 2026, março foi o mês com maior gasto em supermercado: R$ 400,00, considerando 2 despesas.',
          functionCalls: [],
        };
      },
    };

    const res = await runFinanceAsk({
      supabase: okSupabase(rows) as never,
      gemini,
      question: 'Qual mês eu mais gastei em supermercado esse ano?',
      // filtro atual da tela = setembro; o consultado é o ano completo.
      period: { start: '2026-09-01', end: '2026-09-30' },
    });

    expect(gemini && turn).toBe(2); // inicial + follow-up (1 execução de ferramenta)
    expect(res.toolsUsed).toEqual(['expense_monthly_aggregate']);
    expect(res.toolsUsed).toHaveLength(1);
    // 11) período exibido = realmente consultado, não o filtro da tela.
    expect(res.period).toEqual({ start: '2026-01-01', end: '2026-12-31' });

    // 12) cards e texto apresentam os mesmos valores (normalizando NBSP).
    const evidence = res.evidence ?? [];
    const evN = evidence.map((e) => [e.label, e.value.replace(/\u00A0/g, ' ')] as const);
    expect(evN).toContainEqual(['março de 2026 com maior gasto', 'R$ 400,00']);
    expect(evN).toContainEqual(['Despesas consideradas', '2']);
    expect(res.answer).toContain('março');
    expect(res.answer).toContain('R$ 400,00');
    expect(res.answer).toContain('2 despesas');

    // 15) functionResponse contínuo do novo tool preserva id/name exatos.
    const functionTurn = followup.find((m) => m.role === 'function' && m.responses && m.responses.length > 0);
    expect(functionTurn).toBeTruthy();
    expect(functionTurn?.responses?.[0]?.id).toBe('fc-agg-1');
    expect(functionTurn?.responses?.[0]?.name).toBe('expense_monthly_aggregate');
    const parts = functionTurn?.responses?.[0]?.parts ?? '';
    expect(JSON.parse(parts)).toMatchObject({ hasData: true, kind: 'expense' });
  });
});

// ── Apresentação: nenhuma marcação Markdown literal ─────────────────────────

describe('PESSOAL-13B3.12 — Resposta sem marcadores Markdown (apresentação)', () => {
  it('13) remove **, _, backtick, headings e bullets preservando valores', () => {
    const raw =
      '**Março** foi o mês com maior gasto em supermercado: `R$ 400,00`, considerando 2 despesas.\n\n' +
      '# Detalhes\n' +
      '- *Alimentação > Supermercado*\n' +
      '1. __R$ 400,00__ no mês vencedor';
    const cleaned = stripMarkdownMarkers(raw);
    expect(cleaned).not.toMatch(/\*\*|[*_]|`|^#/m);
    expect(cleaned).toContain('Março foi o mês com maior gasto em supermercado: R$ 400,00');
    expect(cleaned).toContain('Alimentação > Supermercado');
    expect(cleaned).toContain('R$ 400,00 no mês vencedor');
  });

  it('13b) resposta final começa diretamente pelo resultado (sem introdução)', () => {
    const raw = 'Em 2026, março foi o mês com maior gasto em supermercado: R$ 400,00, considerando 2 despesas.';
    expect(stripMarkdownMarkers(raw)).toBe(raw);
    expect(stripMarkdownMarkers(raw).startsWith('Em 2026')).toBe(true);
  });

  it('13c) o cliente aplica stripMarkdownMarkers na resposta recebida', () => {
    const src = readFileSync(
      resolve(here, '..', 'lib', 'financeAiClient.ts'),
      'utf8',
    );
    const assign = src.slice(src.indexOf('answer:'));
    expect(assign).toContain('stripMarkdownMarkers(');
  });
});

// ── Observabilidade: nenhum dado sensível em logs ──────────────────────────

describe('PESSOAL-13B3.12 — Falha do aggregate não vaza dados sensíveis', () => {
  it('16) evento sanitizado contém apenas campos fechados e nenhum valor financeiro', () => {
    expect(OBSERVABILITY_FIELDS).toContain('event');
    expect(OBSERVABILITY_FIELDS).toContain('requestId');
    expect(OBSERVABILITY_FIELDS).toContain('stage');
    expect(OBSERVABILITY_FIELDS).toContain('category');
    expect(OBSERVABILITY_FIELDS).toContain('httpStatus');
    expect(OBSERVABILITY_FIELDS).toContain('errorName');
    expect(OBSERVABILITY_FIELDS).toContain('retryable');
    expect(OBSERVABILITY_FIELDS).toContain('elapsedMs');

    const event = {
      event: 'ask_failure',
      requestId: 'req-fake',
      stage: 'supabase_query',
      category: 'supabase_query_error',
      errorName: 'PostgrestError',
      httpStatus: 502,
      retryable: false,
      elapsedMs: 1234,
    };
    const raw = JSON.stringify(event);
    expect(raw).not.toContain('400,00');
    expect(raw).not.toContain('Supermercado');
    expect(raw).not.toContain('descricao-ficticia');
    expect(Object.keys(event).every((k) => (OBSERVABILITY_FIELDS as readonly string[]).includes(k))).toBe(true);
  });
});

// ── Reutilização de motores: o servidor não duplica regras ──────────────────

describe('PESSOAL-13B3.12 — Motor único (server reusa src/lib)', () => {
  it('toolRegistry importa expenseMonthlyAggregate de analyticsInsights (.js)', () => {
    const src = readFileSync(
      resolve(here, '..', '..', 'server', 'finance-ai', 'toolRegistry.ts'),
      'utf8',
    );
    expect(src).toContain("from '../../src/lib/analyticsInsights.js'");
    expect(src).toContain('expenseMonthlyAggregate');
  });
});