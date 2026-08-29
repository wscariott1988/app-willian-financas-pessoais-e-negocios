import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapTxEntry,
  mapCatEntry,
  mapSettingsEntry,
  compareEntries,
  mergeSortedUnique,
  computeFeed,
  formatCurrency,
  formatDateTime,
  ACTION_LABELS,
  type CatAuditRow,
  type SettingsAuditRow,
  type TxAuditRow,
} from '../lib/auditFeed';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}
function readSection(): string {
  return readSource('settings/HistorySection.tsx');
}

function tx(partial: Partial<TxAuditRow> & { id: string; created_at: string }): TxAuditRow {
  return { action: 'create', before_state: null, after_state: null, ...partial };
}
function cat(partial: Partial<CatAuditRow> & { id: string; created_at: string }): CatAuditRow {
  return { from_category_id: null, to_category_id: 'C', reason: 'x', ...partial };
}
function set(partial: Partial<SettingsAuditRow> & { id: string; created_at: string; entity_type: 'account' | 'category' }): SettingsAuditRow {
  return { entity_id: 'E', action: 'create', before_state: null, after_state: null, ...partial };
}

describe('CFG-P4A — eventos de transação (feed)', () => {
  it('6. transação criada: título e detalhe amigáveis com valor', () => {
    const e = mapTxEntry(tx({ id: '1', created_at: '2026-08-28T20:00:00Z', action: 'create', after_state: { raw_description: 'Mercado', amount: 120 } }));
    expect(e.title).toBe('Transação criada');
    expect(e.detail).toContain('Mercado');
    expect(e.detail).toContain('R$ 120,00');
  });

  it('7. transação editada: diffs de valor/descrição/data/status', () => {
    const e = mapTxEntry(tx({
      id: '2', created_at: '2026-08-28T20:00:00Z', action: 'update',
      before_state: { raw_description: 'Mercado', amount: 100, occurred_on: '2026-08-01', status: 'posted' },
      after_state: { raw_description: 'Mercado', amount: 120, occurred_on: '2026-08-02', status: 'pending' },
    }));
    expect(e.title).toBe('Transação editada');
    expect(e.detail).toContain('Valor alterado de R$ 100,00 para R$ 120,00');
    expect(e.detail).toContain('Data alterado');
    expect(e.detail).toContain('Status alterado');
  });

  it('transação editada sem mudança funcional: detalhe genérico', () => {
    const e = mapTxEntry(tx({
      id: '3', created_at: '2026-08-28T20:00:00Z', action: 'update',
      before_state: { raw_description: 'X', amount: 10 },
      after_state: { raw_description: 'X', amount: 10 },
    }));
    expect(e.detail).toBe('Detalhes alterados');
  });

  it('transação excluída: usa estado anterior', () => {
    const e = mapTxEntry(tx({ id: '4', created_at: '2026-08-28T20:00:00Z', action: 'delete', before_state: { raw_description: 'Mercado', amount: 50 } }));
    expect(e.title).toBe('Transação excluída');
    expect(e.detail).toContain('Mercado');
  });

  it('8. mudança de categoria no update usa nomes quando disponíveis', () => {
    const e = mapTxEntry(tx({
      id: '5', created_at: '2026-08-28T20:00:00Z', action: 'update',
      before_state: { raw_description: 'X', amount: 10, category_id: 'CAT_A' },
      after_state: { raw_description: 'X', amount: 10, category_id: 'CAT_B' },
    }), { CAT_A: 'Mercado', CAT_B: 'Alimentação' });
    expect(e.detail).toContain('Categoria alterada de Mercado para Alimentação');
  });

  it('ACTION_LABELS cobre somente create/update/delete (transações)', () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(['create', 'delete', 'update']);
  });

  it('atribuição de categoria: origem → destino amigáveis', () => {
    const e = mapCatEntry(cat({ id: '6', created_at: '2026-08-28T20:00:00Z', from_category_id: 'A', to_category_id: 'B' }), { A: 'Antiga', B: 'Nova' });
    expect(e.title).toBe('Categoria alterada');
    expect(e.detail).toBe('Antiga → Nova');
  });
});

describe('CFG-P4B — eventos de contas (settings_audit)', () => {
  it('conta criada: título e nome da conta', () => {
    const e = mapSettingsEntry(set({ id: 'a1', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: 'ACC1', action: 'create', after_state: { display_name: 'Nubank' } }));
    expect(e.title).toBe('Conta criada');
    expect(e.detail).toBe('Nubank');
  });

  it('conta renomeada: antes → depois', () => {
    const e = mapSettingsEntry(set({
      id: 'a2', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: 'ACC1', action: 'rename',
      before_state: { display_name: 'Nubank' }, after_state: { display_name: 'Nubank Principal' },
    }));
    expect(e.title).toBe('Conta renomeada');
    expect(e.detail).toBe('Nubank → Nubank Principal');
  });

  it('conta vinculada ao perfil: nome da conta', () => {
    const e = mapSettingsEntry(set({ id: 'a3', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: 'ACC2', action: 'link', after_state: { display_name: 'Inter' } }));
    expect(e.title).toBe('Conta vinculada ao perfil');
    expect(e.detail).toBe('Inter');
  });

  it('conta desativada: nome da conta', () => {
    const e = mapSettingsEntry(set({ id: 'a4', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: 'ACC1', action: 'deactivate', after_state: { display_name: 'Nubank' } }));
    expect(e.title).toBe('Conta desativada');
    expect(e.detail).toBe('Nubank');
  });

  it('conta reativada: nome da conta', () => {
    const e = mapSettingsEntry(set({ id: 'a5', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: 'ACC1', action: 'reactivate', after_state: { display_name: 'Nubank' } }));
    expect(e.title).toBe('Conta reativada');
    expect(e.detail).toBe('Nubank');
  });

  it('evento desconhecido de conta não é inventado (fallback neutro)', () => {
    const e = mapSettingsEntry(set({ id: 'a6', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: 'X', action: 'move' as SettingsAuditRow['action'], after_state: null }));
    expect(e.title).toBe('Alteração registrada');
  });
});

describe('CFG-P4B — eventos de categorias (settings_audit)', () => {
  it('categoria criada: título e nome', () => {
    const e = mapSettingsEntry(set({
      id: 'c1', created_at: '2026-08-28T20:00:00Z', entity_type: 'category', entity_id: 'CAT1', action: 'create',
      after_state: { display_name: 'Restaurante', direction: 'expense', parent_id: null },
    }));
    expect(e.title).toBe('Categoria criada');
    expect(e.detail).toBe('Restaurante');
  });

  it('categoria renomeada: antes → depois (derivado do before/after)', () => {
    const e = mapSettingsEntry(set({
      id: 'c2', created_at: '2026-08-28T20:00:00Z', entity_type: 'category', entity_id: 'CAT1', action: 'update',
      before_state: { display_name: 'Restaurante', parent_id: null },
      after_state: { display_name: 'Alimentação fora', parent_id: null },
    }));
    expect(e.title).toBe('Categoria renomeada');
    expect(e.detail).toBe('Restaurante → Alimentação fora');
  });

  it('categoria movida: caminho pai antes → depois (derivado do before/after)', () => {
    const e = mapSettingsEntry(set({
      id: 'c3', created_at: '2026-08-28T20:00:00Z', entity_type: 'category', entity_id: 'CAT1', action: 'update',
      before_state: { display_name: 'Restaurante', parent_id: 'ALIM' },
      after_state: { display_name: 'Restaurante', parent_id: 'LAZER' },
    }), { ALIM: 'Alimentação', LAZER: 'Lazer' });
    expect(e.title).toBe('Categoria movida');
    expect(e.detail).toContain('Restaurante: Alimentação → Lazer');
  });

  it('categoria renomeada E movida: um único evento com ambas as mudanças', () => {
    const e = mapSettingsEntry(set({
      id: 'c4', created_at: '2026-08-28T20:00:00Z', entity_type: 'category', entity_id: 'CAT1', action: 'update',
      before_state: { display_name: 'Restaurante', parent_id: 'ALIM' },
      after_state: { display_name: 'Alimentação fora', parent_id: 'LAZER' },
    }), { ALIM: 'Alimentação', LAZER: 'Lazer' });
    expect(e.title).toBe('Categoria renomeada e movida');
    expect(e.detail).toContain('Restaurante → Alimentação fora');
    expect(e.detail).toContain('Alimentação fora: Alimentação → Lazer');
  });

  it('categoria arquivada: nome', () => {
    const e = mapSettingsEntry(set({
      id: 'c5', created_at: '2026-08-28T20:00:00Z', entity_type: 'category', entity_id: 'CAT1', action: 'archive',
      after_state: { display_name: 'Restaurante', status: 'archived' },
    }));
    expect(e.title).toBe('Categoria arquivada');
    expect(e.detail).toBe('Restaurante');
  });

  it('categoria reativada: nome', () => {
    const e = mapSettingsEntry(set({
      id: 'c6', created_at: '2026-08-28T20:00:00Z', entity_type: 'category', entity_id: 'CAT1', action: 'reactivate',
      after_state: { display_name: 'Restaurante', status: 'active' },
    }));
    expect(e.title).toBe('Categoria reativada');
    expect(e.detail).toBe('Restaurante');
  });
});

describe('CFG-P4B — merge das três fontes, ordenação e tie-breaker', () => {
  it('merge unifica transaction + settings + category sem duplicação', () => {
    const e1 = { source: 'transaction' as const, id: '1', created_at: '2026-08-28T10:00:00Z', title: 'T', detail: null };
    const e2 = { source: 'settings' as const, id: '2', created_at: '2026-08-28T10:00:00Z', title: 'S', detail: null };
    const e3 = { source: 'category' as const, id: '3', created_at: '2026-08-28T10:00:00Z', title: 'C', detail: null };
    const dup = { source: 'settings' as const, id: '2', created_at: '2026-08-28T10:00:00Z', title: 'S', detail: null };
    const out = mergeSortedUnique(mergeSortedUnique([e1], [e2]), [e3, dup]);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((x) => `${x.source}:${x.id}`)).size).toBe(3);
  });

  it('ordenação global determinística: created_at DESC; empate transaction < settings < category; id DESC', () => {
    const a = { source: 'transaction' as const, id: 'A', created_at: '2026-08-28T10:00:00Z', title: 'T', detail: null };
    const b = { source: 'settings' as const, id: 'B', created_at: '2026-08-28T10:00:00Z', title: 'S', detail: null };
    const c = { source: 'category' as const, id: 'C', created_at: '2026-08-28T10:00:00Z', title: 'C', detail: null };
    const d = { source: 'transaction' as const, id: 'D', created_at: '2026-08-28T12:00:00Z', title: 'T2', detail: null };
    expect(compareEntries(a, b)).toBeLessThan(0);
    expect(compareEntries(b, c)).toBeLessThan(0);
    expect(compareEntries(d, a)).toBeLessThan(0);
  });

  it('tie-breaker estável para o mesmo created_at e mesma fonte (id DESC)', () => {
    const x = { source: 'category' as const, id: 'AAA', created_at: '2026-08-28T10:00:00Z', title: 'X', detail: null };
    const y = { source: 'category' as const, id: 'BBB', created_at: '2026-08-28T10:00:00Z', title: 'Y', detail: null };
    expect(compareEntries(x, y)).toBeGreaterThan(0);
    expect(compareEntries(y, x)).toBeLessThan(0);
  });

  it('computeFeed mescla as três fontes e recorta por pageSize', () => {
    const txRows: TxAuditRow[] = Array.from({ length: 12 }, (_, i) =>
      tx({ id: `t${i}`, created_at: `2026-08-28T2${String(i).padStart(2, '0')}:00:00Z`, action: 'create', after_state: { raw_description: `T${i}`, amount: i } }));
    const catRows: CatAuditRow[] = [cat({ id: 'c0', created_at: '2026-08-28T15:00:00Z', from_category_id: 'A', to_category_id: 'B' })];
    const setRows: SettingsAuditRow[] = [
      set({ id: 's0', created_at: '2026-08-28T18:00:00Z', entity_type: 'account', action: 'create', after_state: { display_name: 'Nubank' } }),
    ];
    const f = computeFeed({ tx: txRows, cat: catRows, settings: setRows }, { A: 'Antiga', B: 'Nova' }, 10);
    expect(f.entries.length).toBeLessThanOrEqual(10);
    expect(f.hasMore).toBe(true);
    expect(f.entries[0].title).toBe('Transação criada');
    const f2 = computeFeed({ tx: txRows, cat: catRows, settings: setRows }, {}, 20);
    expect(f2.hasMore).toBe(false);
    const titles = f2.entries.map((e) => e.title);
    expect(titles).toContain('Categoria alterada');
    expect(titles).toContain('Conta criada');
  });

  it('recorte sem perda: pageSize total retorna tudo ordenado', () => {
    const txRows: TxAuditRow[] = Array.from({ length: 5 }, (_, i) =>
      tx({ id: `t${i}`, created_at: `2026-08-28T2${i}:00:00Z`, action: 'create', after_state: { raw_description: `T${i}`, amount: i } }));
    const setRows: SettingsAuditRow[] = [set({ id: 's0', created_at: '2026-08-28T18:00:00Z', entity_type: 'account', action: 'create', after_state: { display_name: 'Nubank' } })];
    const f = computeFeed({ tx: txRows, cat: [], settings: setRows }, {}, 100);
    expect(f.entries.length).toBe(6);
    expect(f.hasMore).toBe(false);
    const dates = f.entries.map((e) => e.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('CFG-P4B — filtros finais (Todos / Transações / Contas / Categorias)', () => {
  const src = readSection();

  it('quatro opções de filtro presentes', () => {
    expect(src).toContain('Todos');
    expect(src).toContain('Transações');
    expect(src).toContain('Contas');
    expect(src).toContain('Categorias');
  });

  it('Transações filtra somente fonte transaction', () => {
    expect(src).toContain("e.source === 'transaction'");
  });

  it('Contas filtra somente eventos de conta (settings)', () => {
    expect(src).toContain("'Conta'");
  });

  it('Categorias inclui atribuição de categoria E CRUD de categorias (sem filtro técnico separado)', () => {
    expect(src).toContain("e.source === 'category'");
    expect(src).toMatch(/settings.*'Categoria'/);
    expect(src).not.toMatch(/<option[^>]*>.*Atribui/);
    expect(src).not.toContain("filter === 'category_assignment'");
  });
});

describe('CFG-P4B — segredos e termos técnicos fora da UI', () => {
  const src = readSection();
  const jsx = src.slice(src.lastIndexOf('return ('));

  it('nenhum segredo/payload técnico renderizado', () => {
    expect(jsx).not.toContain('before_state');
    expect(jsx).not.toContain('after_state');
    expect(jsx).not.toContain('jsonb');
    expect(jsx).not.toContain('payload');
    expect(jsx).not.toContain('token');
    expect(jsx).not.toContain('jwt');
  });

  it('UI não mostra UUID/RPC/tabelas de auditoria no JSX', () => {
    expect(jsx).not.toContain('transaction_audit');
    expect(jsx).not.toContain('category_assignment_audit');
    expect(jsx).not.toContain('settings_audit');
    expect(jsx).not.toContain('RPC');
    expect(jsx).not.toContain('profile_id');
  });

  it('isolamento: a query filtra pelo perfil ativo (Pessoal/Negócio por prop)', () => {
    expect(src).toContain(".eq('profile_id', profileId)");
    expect(src).toContain('.order(\'created_at\', { ascending: false })');
    expect(src).toContain('HistorySection');
  });

  it('nenhum profile_id arbitrário aceito (filtro fixo pela prop do perfil ativo)', () => {
    expect(src).toMatch(/.eq\('profile_id', profileId\)/);
    expect(src).not.toContain('.eq(\'profile_id\', form.');
    expect(src).not.toContain('.eq(\'profile_id\', user.');
  });

  it('carregamento da tela é read-only (zero mutação)', () => {
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/\.rpc\(/);
  });

  it('feed gera mensagens amigáveis sem UUID/JSON cru (saída de título/detalhe)', () => {
    const rows: SettingsAuditRow[] = [
      set({ id: '11111111-1111-4111-8111-111111111111', created_at: '2026-08-28T20:00:00Z', entity_type: 'account', entity_id: '22222222-2222-4222-8222-222222222222', action: 'create', after_state: { display_name: 'Nubank' } }),
      set({ id: '33333333-3333-4333-8333-333333333333', created_at: '2026-08-28T21:00:00Z', entity_type: 'category', entity_id: '44444444-4444-4444-8444-444444444444', action: 'update', before_state: { display_name: 'Restaurante', parent_id: null }, after_state: { display_name: 'Alimentação fora', parent_id: null } }),
    ];
    for (const r of rows) {
      const e = mapSettingsEntry(r, {});
      expect(e.title).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(e.detail ?? '').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(e.detail ?? '').not.toContain('{');
      expect(e.detail ?? '').not.toContain('"');
    }
    expect(rows[0].id).toMatch(/[0-9a-f]{8}-/i); // fonte realmente contém UUID (interno, nunca exibido)
  });
});

describe('CFG-P4A/P4B — formatação amigável', () => {
  it('moeda em formato brasileiro', () => {
    expect(formatCurrency(120)).toBe('R$ 120,00');
    expect(formatCurrency('50.5')).toBe('R$ 50,50');
    expect(formatCurrency(null)).toBe('R$ —');
  });

  it('data/hora local', () => {
    const out = formatDateTime('2026-08-28T21:35:00Z');
    expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });
});