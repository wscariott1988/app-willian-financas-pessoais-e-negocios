import { describe, it, expect } from 'vitest';
import {
  filterHistoryEntries,
  hasFilteredHistoryMore,
  type AuditEntry,
} from '../lib/auditFeed';

function entry(partial: Partial<AuditEntry> & { source: AuditEntry['source']; id: string }): AuditEntry {
  return {
    created_at: '2026-08-01T00:00:00.000Z',
    title: 'Evento',
    detail: null,
    ...partial,
  };
}

describe('U-02 — hasMore do histórico respeita o filtro (não vaza)', () => {
  const feed: AuditEntry[] = [
    // 2 eventos de conta (settings)
    entry({ source: 'settings', id: 'a1', title: 'Conta criada' }),
    entry({ source: 'settings', id: 'a2', title: 'Conta desativada' }),
    // muitos eventos de categoria (settings) que devem ficar FORA do filtro Contas
    entry({ source: 'settings', id: 'c1', title: 'Categoria criada' }),
    entry({ source: 'settings', id: 'c2', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c3', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c4', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c5', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c6', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c7', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c8', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c9', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c10', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c11', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c12', title: 'Categoria arquivada' }),
    entry({ source: 'settings', id: 'c13', title: 'Categoria arquivada' }),
    // 1 evento de transação
    entry({ source: 'transaction', id: 't1', title: 'Transação criada' }),
  ];

  it('filtro Contas mantém só eventos de conta (exclui categorias/transações)', () => {
    const filtered = filterHistoryEntries(feed, 'accounts');
    expect(filtered.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
  });

  it('com total de contas <= page size, NÃO aparece "Carregar mais"', () => {
    const filtered = filterHistoryEntries(feed, 'accounts');
    // page size 10: apenas 2 contas <= 10 => sem mais
    expect(hasFilteredHistoryMore(filtered, 10)).toBe(false);
  });

  it('com total de contas > page size, "Carregar mais" aparece', () => {
    const manyAccounts = [
      ...feed,
      ...Array.from({ length: 11 }, (_, i) =>
        entry({ source: 'settings', id: `extra-${i}`, title: 'Conta criada' }),
      ),
    ];
    const filtered = filterHistoryEntries(manyAccounts, 'accounts');
    expect(filtered.length).toBe(13); // 2 + 11
    expect(hasFilteredHistoryMore(filtered, 10)).toBe(true);
    expect(hasFilteredHistoryMore(filtered, 15)).toBe(false);
  });

  it('trocar o filtro recomputa hasMore sem vazar o estado anterior', () => {
    // mesmo conjunto, filtros diferentes => hasMore independente
    const accounts = filterHistoryEntries(feed, 'accounts');
    const categories = filterHistoryEntries(feed, 'categories');
    // Contas: só 2 => sem mais; Categorias: muitas => com mais
    expect(hasFilteredHistoryMore(accounts, 10)).toBe(false);
    expect(hasFilteredHistoryMore(categories, 10)).toBe(true);
  });

  it('bases de dados cruas (categorias/transações) não inflam hasMore de Contas', () => {
    // Antes do fix, hasMore usava settingsRows.length >= loaded (contava
    // categorias também). Aqui há muitas categorias, mas poucas contas.
    const filtered = filterHistoryEntries(feed, 'accounts');
    const rawSettingsCount = 11; // a1,a2,c1..c9
    expect(rawSettingsCount).toBeGreaterThanOrEqual(10); // cenário que disparava o bug
    expect(hasFilteredHistoryMore(filtered, 10)).toBe(false); // agora NÃO dispara
  });

  it('com total de contas EXATAMENTE == page size, NÃO aparece "Carregar mais"', () => {
    // sonda de 1 linha: short page (== loaded) => não há próxima página
    const exactlyOnePage = filterHistoryEntries(
      [
        ...feed.filter((e) => e.source !== 'settings' || e.title.includes('Conta')),
        ...Array.from({ length: 8 }, (_, i) =>
          entry({ source: 'settings', id: `exact-${i}`, title: 'Conta criada' }),
        ),
      ],
      'accounts',
    );
    expect(exactlyOnePage.length).toBe(10);
    expect(hasFilteredHistoryMore(exactlyOnePage, 10)).toBe(false);
  });

  it('filtro sem resultados => nenhuma entrada e sem "Carregar mais"', () => {
    const txOnly: AuditEntry[] = [entry({ source: 'transaction', id: 't1', title: 'Transação criada' })];
    const filtered = filterHistoryEntries(txOnly, 'accounts');
    expect(filtered).toEqual([]);
    expect(hasFilteredHistoryMore(filtered, 10)).toBe(false);
  });
});
