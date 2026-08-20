import { describe, it, expect } from 'vitest';
import {
  ACTION_LABELS,
  CATEGORY_LABEL,
  mapTxEntry,
  mapCatEntry,
  mergeSortedUnique,
  computeFeed,
  compareEntries,
  formatAuditAmount,
  formatAuditDate,
  type RawTxAudit,
  type RawCatAudit,
  type AuditEntry,
} from '../lib/auditFeed';

const T = (created_at: string, over: Partial<RawTxAudit> = {}): RawTxAudit => ({
  id: `tx-${created_at}`,
  action: 'create',
  before_state: null,
  after_state: null,
  created_at,
  ...over,
});

const C = (created_at: string, over: Partial<RawCatAudit> = {}): RawCatAudit => ({
  id: `cat-${created_at}`,
  from_category_id: null,
  to_category_id: 'c2',
  reason: null,
  created_at,
  ...over,
});

describe('mapTxEntry — rótulos amigáveis e descrição via estado', () => {
  it('create -> "Transação criada" com descrição do after_state', () => {
    const e = mapTxEntry(T('2026-08-10T12:00:00Z', {
      action: 'create',
      after_state: { raw_description: 'Compra mercado', amount: '12.34', transaction_kind: 'expense' },
    }));
    expect(e.label).toBe('Transação criada');
    expect(e.description).toBe('Compra mercado');
    expect(e.amountText).toBe('- R$ 12,34');
    expect(e.kind).toBe('expense');
  });

  it('update -> "Transação editada"', () => {
    const e = mapTxEntry(T('2026-08-10T12:01:00Z', {
      action: 'update',
      before_state: { raw_description: 'Antiga' },
      after_state: { raw_description: 'Nova', amount: '5', transaction_kind: 'income' },
    }));
    expect(e.label).toBe('Transação editada');
    expect(e.description).toBe('Nova');
    expect(e.amountText).toBe('+ R$ 5,00');
  });

  it('delete -> "Transação excluída" usando before_state SEM join em transactions', () => {
    const e = mapTxEntry(T('2026-08-10T12:02:00Z', {
      action: 'delete',
      before_state: { raw_description: 'TESTE EXCLUSÃO CLOUD 013 — PODE APAGAR', amount: '42.42', transaction_kind: 'expense' },
      after_state: { deleted_at: '2026-08-10T12:02:00Z' },
    }));
    expect(e.label).toBe('Transação excluída');
    expect(e.description).toBe('TESTE EXCLUSÃO CLOUD 013 — PODE APAGAR');
    expect(e.amountText).toBe('- R$ 42,42');
  });

  it('delete sem before_state -> fallback "Transação"', () => {
    const e = mapTxEntry(T('2026-08-10T12:03:00Z', { action: 'delete', before_state: null, after_state: null }));
    expect(e.label).toBe('Transação excluída');
    expect(e.description).toBe('Transação');
    expect(e.amountText).toBe('');
  });

  it('não expõe UUID/JSON bruto no rótulo', () => {
    const e = mapTxEntry(T('2026-08-10T12:04:00Z', { after_state: { raw_description: 'x' } }));
    expect(e.label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(e.description).not.toContain('{');
  });
});

describe('mapCatEntry — alterações de categoria', () => {
  it('label "Categoria alterada" preserva from/to/reason', () => {
    const e = mapCatEntry(C('2026-08-10T13:00:00Z', {
      from_category_id: 'c1',
      to_category_id: 'c2',
      reason: 'manual',
    }));
    expect(e.label).toBe(CATEGORY_LABEL);
    expect(e.fromCat).toBe('c1');
    expect(e.toCat).toBe('c2');
    expect(e.reason).toBe('manual');
    expect(e.description).toBe('');
  });
});

describe('mergeSortedUnique — ordenação combinada e sem duplicação', () => {
  it('ordena por created_at DESC combinando tx+cat', () => {
    const merged = mergeSortedUnique([
      mapTxEntry(T('2026-08-10T10:00:00Z')),
      mapCatEntry(C('2026-08-10T11:00:00Z')),
      mapTxEntry(T('2026-08-10T12:00:00Z')),
    ]);
    expect(merged.map((e) => e.created_at)).toEqual([
      '2026-08-10T12:00:00Z',
      '2026-08-10T11:00:00Z',
      '2026-08-10T10:00:00Z',
    ]);
  });

  it('deduplica por source:id mesmo com ids iguais entre tabelas', () => {
    const a = mapTxEntry(T('2026-08-10T12:00:00Z', { id: 'same' }));
    const b = mapCatEntry(C('2026-08-10T12:00:00Z', { id: 'same' }));
    const dup = mapTxEntry(T('2026-08-10T12:00:00Z', { id: 'same' }));
    const merged = mergeSortedUnique([a, b, dup]);
    expect(merged.length).toBe(2);
    expect(new Set(merged.map((e) => `${e.source}:${e.id}`)).size).toBe(2);
  });

  it('estável em empates de created_at (sem perda)', () => {
    const a = mapTxEntry(T('2026-08-10T12:00:00Z', { id: 'a' }));
    const b = mapTxEntry(T('2026-08-10T12:00:00Z', { id: 'b' }));
    const merged = mergeSortedUnique([a, b]);
    expect(merged.length).toBe(2);
  });
});

describe('computeFeed — paginação cumulativa com timestamps idênticos', () => {
  const TS = '2026-08-10T12:00:00.000Z';
  const txRows: RawTxAudit[] = [
    { id: 'tx-1', action: 'create', before_state: null, after_state: { raw_description: 'A' }, created_at: TS },
    { id: 'tx-2', action: 'delete', before_state: { raw_description: 'B' }, after_state: null, created_at: TS },
    { id: 'tx-3', action: 'update', before_state: null, after_state: { raw_description: 'C' }, created_at: TS },
  ];
  const catRows: RawCatAudit[] = [
    { id: 'cat-1', from_category_id: 'c1', to_category_id: 'c2', reason: 'r', created_at: TS },
    { id: 'cat-2', from_category_id: 'c2', to_category_id: 'c3', reason: 'r', created_at: TS },
  ];

  it('com pageSize suficiente, nenhum evento some (zero perda) e nenhum duplica', () => {
    const { entries, hasMore } = computeFeed(txRows, catRows, txRows.length, catRows.length, 10);
    expect(entries.length).toBe(5);
    expect(hasMore).toBe(false);
    const keys = entries.map((e) => `${e.source}:${e.id}`);
    expect(new Set(keys).size).toBe(5); // zero duplicação
    expect(keys).toContain('tx:tx-1');
    expect(keys).toContain('tx:tx-2');
    expect(keys).toContain('tx:tx-3');
    expect(keys).toContain('cat:cat-1');
    expect(keys).toContain('cat:cat-2');
  });

  it('ordem estável com created_at idêntico: source (tx antes de cat) e id', () => {
    const { entries } = computeFeed(txRows, catRows, txRows.length, catRows.length, 10);
    const order = entries.map((e) => `${e.source}:${e.id}`);
    expect(order).toEqual(['tx:tx-1', 'tx:tx-2', 'tx:tx-3', 'cat:cat-1', 'cat:cat-2']);
  });

  it('compareEntries é total e determinístico (comparação explícita)', () => {
    const a: AuditEntry = { source: 'tx', id: 'x', label: '', description: '', amountText: '', kind: 'other', fromCat: null, toCat: null, reason: null, created_at: TS };
    const b: AuditEntry = { ...a, source: 'cat' };
    const c: AuditEntry = { ...a, id: 'y' };
    expect(compareEntries(a, b)).toBeLessThan(0); // tx antes de cat
    expect(compareEntries(a, c)).toBeLessThan(0); // id 'x' antes de 'y'
    expect(compareEntries(a, a)).toBe(0);
  });

  it('hasMore correto: linhas ocultas pelo slice OU fontes com mais registros', () => {
    // todas as 5 cabem na página 10
    expect(computeFeed(txRows, catRows, 3, 2, 10).hasMore).toBe(false);
    // fonte tx tem 100 (mais antigas não buscadas) => há mais
    expect(computeFeed(txRows, catRows, 100, 2, 10).hasMore).toBe(true);
    // 5 mescladas mas página 4 => cat:2 fica oculta pelo slice => há mais
    const p4 = computeFeed(txRows, catRows, 3, 2, 4);
    expect(p4.entries.length).toBe(4);
    expect(p4.hasMore).toBe(true);
  });

  it('recorte cumulativo: cresce de página em página sem perder nem duplicar', () => {
    const p2 = computeFeed(txRows, catRows, 3, 2, 2);
    expect(p2.entries.length).toBe(2);
    expect(p2.hasMore).toBe(true);

    const p4 = computeFeed(txRows, catRows, 3, 2, 4);
    expect(p4.entries.length).toBe(4);
    expect(p4.hasMore).toBe(true);

    const p10 = computeFeed(txRows, catRows, 3, 2, 10);
    expect(p10.entries.length).toBe(5);
    expect(p10.hasMore).toBe(false);

    // todas as linhas de p10 estão contidas na união das recargas (zero perda)
    const allKeys = new Set([...p2.entries, ...p4.entries, ...p10.entries].map((e) => `${e.source}:${e.id}`));
    expect(allKeys.size).toBe(5);
  });
});

describe('formatAuditAmount / formatAuditDate', () => {
  it('expense/income/invalid', () => {
    expect(formatAuditAmount('12.34', 'expense')).toBe('- R$ 12,34');
    expect(formatAuditAmount('12.34', 'income')).toBe('+ R$ 12,34');
    expect(formatAuditAmount('', 'expense')).toBe('');
    expect(formatAuditAmount('abc', 'expense')).toBe('');
  });

  it('formatAuditDate válido e inválido', () => {
    expect(formatAuditDate('2026-08-10T12:00:00Z')).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(formatAuditDate('nao-é-data')).toBe('nao-é-data');
  });
});

describe('ACTION_LABELS', () => {
  it('contém os 4 textos amigáveis exigidos', () => {
    expect(ACTION_LABELS.create).toBe('Transação criada');
    expect(ACTION_LABELS.update).toBe('Transação editada');
    expect(ACTION_LABELS.delete).toBe('Transação excluída');
    expect(CATEGORY_LABEL).toBe('Categoria alterada');
  });
});
