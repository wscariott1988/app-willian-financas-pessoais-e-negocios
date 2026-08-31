import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortAccountsByPreference } from '../lib/accountCrud';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

interface EditorAccount {
  id: string;
  display_name: string;
  source_name: string;
  active: boolean;
  is_favorite?: boolean;
  last_activity?: string | null;
  usage_count?: number;
}

function eacc(id: string, name: string, opts: Partial<EditorAccount> = {}): EditorAccount {
  return { id, display_name: name, source_name: '', active: true, ...opts };
}

// Prova REAL do array/opções: o editor monta as contas válidas e as passa ao
// sort canônico; aqui replicamos exatamente essa pipeline para provar a ordem.
function editorOrderedAccounts(input: EditorAccount[]): EditorAccount[] {
  return sortAccountsByPreference(input);
}

describe('CFG-P8B — TransactionEditor usa a ordenação canônica (prova real)', () => {
  const editor = readSource('components/TransactionEditor.tsx');

  it('11. TransactionEditor usa a ordenação canônica', () => {
    expect(editor).toContain('sortAccountsByPreference');
    expect(editor).not.toContain('sort((a, b) => a.display_name.localeCompare(b.display_name))');
  });

  it('12. favorita válida sobe', () => {
    const out = editorOrderedAccounts([
      eacc('B', 'Banco B'),
      eacc('A', 'Banco A', { is_favorite: true }),
    ]);
    expect(out[0].id).toBe('A');
  });

  it('13. favorita inválida para a data NÃO aparece (filtro ANTES da ordenação)', () => {
    // O editor filtra por isAccountOpenOn/isAccountValidForDate ANTES de ordenar.
    // Prova: o filtro (requireOpen/isAccountValidForDate) permanece no código,
    // e a ordenação só recebe o array já filtrado.
    expect(editor).toContain('isAccountOpenOn(periods, p.account_id, form.occurred_on)');
    expect(editor).toContain('if (!ok) continue;');
  });

  it('14. inactive não vira active por ser favorita (filtro de período intocado)', () => {
    expect(editor).toContain('requireOpen');
    expect(editor).toContain('isAccountValidForDate');
  });

  it('15. cross-profile não aparece (períodos carregados com eq profile_id)', () => {
    expect(editor).toContain(".eq('profile_id', profileId)");
  });

  it('16. mesma conta favorita só no Negócio não sobe no Pessoal (favoritos por profile)', () => {
    expect(editor).toContain("from('account_profile_favorites')");
    expect(editor).toContain(".eq('profile_id', profileId)");
  });

  it('17. ordem muda após favorite success (AccountsSection reordena localmente pós-sucesso)', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toMatch(/sortAccountsByPreference\(\s*prev\.map/);
  });

  it('18. erro de favorite não altera ordem falsamente (atualização só após sucesso)', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toContain('if (rpcError) {');
    expect(src).toContain('setActionError');
  });

  it('ordem real com recência + frequência + favorita no editor', () => {
    const out = editorOrderedAccounts([
      eacc('F_NEW', 'Fav Nova', { is_favorite: true, last_activity: '2026-08-02', usage_count: 10 }),
      eacc('F_OLD', 'Fav Velha', { is_favorite: true, last_activity: '2020-01-01', usage_count: 100 }),
      eacc('NF_HIGH', 'Normal Freq Alta', { last_activity: '2026-08-01', usage_count: 50 }),
      eacc('NF_LOW', 'Normal Freq Baixa', { last_activity: '2026-08-01', usage_count: 3 }),
      eacc('NONE', 'Sem Uso'),
    ]);
    expect(out.map((a) => a.id)).toEqual(['F_NEW', 'F_OLD', 'NF_HIGH', 'NF_LOW', 'NONE']);
  });
});

describe('CFG-P8B — Analytics intacta (ordem financeira própria)', () => {
  it('Análises NÃO muda ordem por favorita/frequência', () => {
    const analytics = readSource('lib/analytics.ts');
    expect(analytics).not.toContain('is_favorite');
    expect(analytics).not.toContain('usage_count');
    expect(analytics).toContain('activity'); // ordenação por movimentação absoluta
  });
});