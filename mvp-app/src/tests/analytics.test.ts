import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  summarizePeriod,
  breakdownByCategory,
  breakdownByAccount,
  buildAnalytics,
  categoryLabel,
  type AnalyticsTxRow,
} from '../lib/analytics';
import { createLatestRequestGuard } from '../lib/latestRequest';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

function tx(partial: Partial<AnalyticsTxRow> & { id: string }): AnalyticsTxRow {
  return {
    transaction_kind: 'expense',
    amount: 10,
    account_id: 'A1',
    category_id: null,
    accounts: null,
    categories: null,
    ...partial,
  };
}

describe('CFG-P6B — resumo (mesma semântica do Dashboard/summary.ts)', () => {
  it('1. receitas corretas (income)', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 100 }),
      tx({ id: '2', transaction_kind: 'income', amount: 50.5 }),
    ];
    expect(summarizePeriod(rows).income).toBe(150.5);
  });

  it('2. despesas corretas (expense)', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'expense', amount: 30 }),
      tx({ id: '2', transaction_kind: 'expense', amount: 20 }),
    ];
    expect(summarizePeriod(rows).expense).toBe(50);
  });

  it('3. saldo/resultado = receitas − despesas', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 100 }),
      tx({ id: '2', transaction_kind: 'expense', amount: 30 }),
    ];
    expect(summarizePeriod(rows).balance).toBe(70);
  });

  it('16. transferências NÃO entram como receita/despesa nos totais globais', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 100 }),
      tx({ id: '2', transaction_kind: 'expense', amount: 40 }),
      tx({ id: '3', transaction_kind: 'transfer', amount: 500 }),
      tx({ id: '4', transaction_kind: 'transfer', amount: 500 }),
    ];
    const s = summarizePeriod(rows);
    expect(s.income).toBe(100);
    expect(s.expense).toBe(40);
    expect(s.transfer).toBe(1000);
    expect(s.balance).toBe(60);
  });

  it('totalCount = linhas do recorte', () => {
    const rows = [tx({ id: '1' }), tx({ id: '2' }), tx({ id: '3' })];
    expect(summarizePeriod(rows).totalCount).toBe(3);
  });
});

describe('CFG-P6B — breakdown por categoria', () => {
  it('9. despesa por categoria fecha com total (pai+filho não duplicam; só a atribuída conta)', () => {
    const rows = [
      tx({ id: '1', category_id: 'C1', categories: { display_name: 'Casa', canonical_path: 'Casa' }, amount: 40 }),
      tx({ id: '2', category_id: 'C2', categories: { display_name: 'Internet', canonical_path: 'Casa > Internet' }, amount: 60 }),
    ];
    const total = summarizePeriod(rows).expense;
    const b = breakdownByCategory(rows, 'expense', total);
    expect(total).toBe(100);
    expect(b.reduce((a, c) => a + c.amount, 0)).toBe(100);
  });

  it('10. receita por categoria fecha com total', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', category_id: 'S', categories: { display_name: 'Salário', canonical_path: 'Receita > Salário' }, amount: 200 }),
      tx({ id: '2', transaction_kind: 'income', category_id: null, amount: 50 }),
    ];
    const total = summarizePeriod(rows).income;
    const b = breakdownByCategory(rows, 'income', total);
    expect(total).toBe(250);
    expect(b.reduce((a, c) => a + c.amount, 0)).toBe(250);
  });

  it('11. "Sem categoria" aparece amigavelmente (sem UUID)', () => {
    const rows = [
      tx({ id: '1', category_id: null, amount: 15 }),
      tx({ id: '2', category_id: 'C', categories: { display_name: 'X', canonical_path: 'X' }, amount: 5 }),
    ];
    const b = breakdownByCategory(rows, 'expense', 20);
    expect(b[0].label).toBe('Sem categoria');
    expect(b[0].category_id).toBeNull();
    expect(b[0].label).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('12. percentuais corretos (share = parte/total)', () => {
    const rows = [
      tx({ id: '1', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 75 }),
      tx({ id: '2', category_id: 'B', categories: { display_name: 'B', canonical_path: 'B' }, amount: 25 }),
    ];
    const b = breakdownByCategory(rows, 'expense', 100);
    expect(b[0].share).toBeCloseTo(0.75);
    expect(b[1].share).toBeCloseTo(0.25);
  });

  it('13. total zero => share 0 (sem NaN/Infinity)', () => {
    const rows = [tx({ id: '1', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 0 })];
    const b = breakdownByCategory(rows, 'expense', 0);
    expect(b[0].share).toBe(0);
    expect(Number.isFinite(b[0].share)).toBe(true);
  });

  it('ranking ordenado por valor decrescente; receitas separadas de despesas', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'expense', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 10 }),
      tx({ id: '2', transaction_kind: 'expense', category_id: 'B', categories: { display_name: 'B', canonical_path: 'B' }, amount: 90 }),
      tx({ id: '3', transaction_kind: 'income', category_id: 'A', categories: { display_name: 'A', canonical_path: 'A' }, amount: 999 }),
    ];
    const exp = breakdownByCategory(rows, 'expense', 100);
    const inc = breakdownByCategory(rows, 'income', 999);
    expect(exp[0].label).toBe('B');
    expect(inc[0].amount).toBe(999);
    expect(inc[0].label).toBe('A');
  });

  it('categoria label usa path canônico; fallback display_name', () => {
    expect(categoryLabel(tx({ id: '1', category_id: 'C', categories: { display_name: 'Internet', canonical_path: 'Casa > Internet' } }))).toBe('Casa > Internet');
    expect(categoryLabel(tx({ id: '2', category_id: 'C', categories: { display_name: 'X', canonical_path: null } }))).toBe('X');
    expect(categoryLabel(tx({ id: '3', category_id: null }))).toBe('Sem categoria');
  });
});

describe('CFG-P6B — movimentação por conta', () => {
  it('14. conta agrupa corretamente (receitas+despesas+transferências por conta)', () => {
    const rows = [
      tx({ id: '1', account_id: 'A', transaction_kind: 'income', amount: 100 }),
      tx({ id: '2', account_id: 'A', transaction_kind: 'expense', amount: 30 }),
      tx({ id: '3', account_id: 'B', transaction_kind: 'expense', amount: 20 }),
    ];
    const b = breakdownByAccount(rows);
    const a = b.find((x) => x.account_id === 'A')!;
    const bb = b.find((x) => x.account_id === 'B')!;
    expect(a.income).toBe(100);
    expect(a.expense).toBe(30);
    expect(bb.expense).toBe(20);
  });

  it('15. líquido por conta = receitas − despesas (transferências à parte)', () => {
    const rows = [
      tx({ id: '1', account_id: 'A', transaction_kind: 'income', amount: 100 }),
      tx({ id: '2', account_id: 'A', transaction_kind: 'expense', amount: 40 }),
      tx({ id: '3', account_id: 'A', transaction_kind: 'transfer', amount: 500 }),
    ];
    const a = breakdownByAccount(rows).find((x) => x.account_id === 'A')!;
    expect(a.net).toBe(60);
    expect(a.transfer).toBe(500);
  });

  it('ordenação por maior movimentação absoluta; conta sem movimento é omitida', () => {
    const rows = [
      tx({ id: '1', account_id: 'BIG', transaction_kind: 'expense', amount: 200 }),
      tx({ id: '2', account_id: 'SML', transaction_kind: 'expense', amount: 5 }),
    ];
    const b = breakdownByAccount(rows);
    expect(b[0].account_id).toBe('BIG');
    expect(b.length).toBe(2);
  });

  it('nomenclatura NÃO é "saldo da conta" (sem conciliação inicial)', () => {
    const view = readSource('views/AnalyticsView.tsx');
    expect(view).not.toContain('Saldo da conta');
    expect(view).toContain('Movimentação por conta');
  });
});

describe('CFG-P6B — pipeline completo', () => {
  it('buildAnalytics monta totais + rankings + contas', () => {
    const rows = [
      tx({ id: '1', transaction_kind: 'income', amount: 100, account_id: 'A', category_id: 'S', categories: { display_name: 'Salário', canonical_path: 'Receita > Salário' } }),
      tx({ id: '2', transaction_kind: 'expense', amount: 40, account_id: 'A', category_id: 'C', categories: { display_name: 'Casa', canonical_path: 'Casa' } }),
      tx({ id: '3', transaction_kind: 'transfer', amount: 10, account_id: 'B' }),
    ];
    const r = buildAnalytics(rows);
    expect(r.totals.balance).toBe(60);
    expect(r.expensesByCategory[0].amount).toBe(40);
    expect(r.incomesByCategory[0].amount).toBe(100);
    expect(r.accounts.length).toBe(2);
  });
});

describe('CFG-P6B — view (read-only; rota integrada)', () => {
  const view = readSource('views/AnalyticsView.tsx');
  const shell = readSource('components/AppShell.tsx');

  it('17. séries NÃO são somadas duas vezes (nenhuma referência a transaction_series)', () => {
    expect(view).not.toContain('transaction_series');
    expect(view).not.toContain('amount_total');
  });

  it('18. ocorrência materializada entra normalmente (query em transactions)', () => {
    expect(view).toContain(".from('transactions')");
  });

  it('21. nenhum write/RPC mutável na tela', () => {
    expect(view).not.toMatch(/\.insert\(/);
    expect(view).not.toMatch(/\.update\(/);
    expect(view).not.toMatch(/\.delete\(/);
    expect(view).not.toMatch(/\.rpc\(/);
    expect(view).not.toMatch(/\.upsert\(/);
  });

  it('22. rota Análises não é mais ComingSoon', () => {
    expect(shell).toContain('<AnalyticsView');
    expect(shell).not.toContain("COMING_SOON.analises");
  });

  it('23. rota Análises permanece funcional (Contas agora abre a gestão existente — P7A)', () => {
    expect(shell).toContain('<AnalyticsView');
    expect(shell).toContain("view === 'contas' && <SettingsView profileId={profileId} focusSection=\"accounts\" />");
    expect(shell).not.toContain('ComingSoonView');
  });

  it('sem UUID/category_raw técnico na UI', () => {
    expect(view).not.toContain('category_raw');
    const jsx = view.slice(view.lastIndexOf('return ('));
    expect(jsx).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('read-only: nenhum botão de ação financeira', () => {
    expect(view).not.toContain('Gerar próximas ocorrências');
    expect(view).not.toContain('Salvar');
    expect(view).not.toContain('Excluir');
  });
});

describe('CFG-P6B — estados e acessibilidade', () => {
  const view = readSource('views/AnalyticsView.tsx');

  it('19. empty state amigável', () => {
    expect(view).toContain('Nenhuma transação no período selecionado');
    expect(view).toContain('Nenhuma despesa no período');
    expect(view).toContain('Nenhuma receita no período');
  });

  it('loading e erro', () => {
    expect(view).toContain('Calculando análises');
    expect(view).toContain('Não foi possível carregar as análises');
  });

  it('24. acessibilidade básica: headings + aria-label + th scope', () => {
    expect(view).toContain('aria-label="Despesas por categoria"');
    expect(view).toContain('aria-label="Receitas por categoria"');
    expect(view).toContain('aria-label="Movimentação por conta"');
    expect(view).toContain('scope="col"');
    expect(view).toContain('scope="row"');
  });

  it('formatação BRL com pt-BR (reutiliza toLocaleString)', () => {
    expect(view).toContain("toLocaleString('pt-BR'");
  });
});

describe('CFG-P6B — F-01: não mostrar período antigo ao trocar período', () => {
  const view = readSource('views/AnalyticsView.tsx');

  it('usa o guard de última requisição (isCurrent) no load', () => {
    expect(view).toContain('createLatestRequestGuard');
    expect(view).toContain('latestRef.current.next()');
    expect(view).toContain('latestRef.current.isCurrent(myRequest)');
  });

  it('A) limpa o resultado anterior no início do load (não exibe números velhos como atuais)', () => {
    const loadStart = view.slice(view.indexOf('const load ='), view.indexOf('const load =') + 400);
    expect(loadStart).toContain('setResult(null)');
    // com result null e loading true, o render mostra o estado de loading,
    // nunca o resultado anterior (ver condição {loading && !result})
    expect(view).toContain('{loading && !result ?');
  });

  it('B) response de A chegando depois de B não sobrescreve B (guarda de corrida)', () => {
    const guard = createLatestRequestGuard();
    const seqA = guard.next(); // período A inicia
    const seqB = guard.next(); // usuário troca para o período B antes de A responder
    // A chega atrasado => defasado, NÃO pode gravar
    expect(guard.isCurrent(seqA)).toBe(false);
    // B é a consulta corrente => pode gravar
    expect(guard.isCurrent(seqB)).toBe(true);
  });

  it('B) sem troca de período, a resposta corrente é aceita', () => {
    const guard = createLatestRequestGuard();
    const seq = guard.next();
    expect(guard.isCurrent(seq)).toBe(true);
  });

  it('B) múltiplas trocas: apenas a última requisição permanece corrente', () => {
    const guard = createLatestRequestGuard();
    const a = guard.next();
    const b = guard.next();
    const c = guard.next();
    expect(guard.isCurrent(a)).toBe(false);
    expect(guard.isCurrent(b)).toBe(false);
    expect(guard.isCurrent(c)).toBe(true);
  });
});

describe('CFG-P6B — profile isolation e período', () => {
  const view = readSource('views/AnalyticsView.tsx');

  it('4. key=profileId força recálculo ao trocar perfil (sem cache cruzado)', () => {
    const shell = readSource('components/AppShell.tsx');
    expect(shell).toContain('<AnalyticsView');
    expect(shell).toContain('key={profileId}');
  });

  it('5. filtro de período inclusivo (gte/lte)', () => {
    expect(view).toContain(".gte('occurred_on', range.start)");
    expect(view).toContain(".lte('occurred_on', range.end)");
  });

  it('6. soft-deleted excluído (deleted_at is null)', () => {
    expect(view).toContain(".is('deleted_at', null)");
  });

  it('reutiliza PeriodSelector canônico', () => {
    expect(view).toContain('<PeriodSelector');
  });
});