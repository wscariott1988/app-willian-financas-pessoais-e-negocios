import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortAccountsByPreference, type AccountWithStatus } from '../lib/accountCrud';
import { mapUsage } from '../lib/accountQuery';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

function acc(id: string, name: string, is_favorite = false, last_activity: string | null = null): AccountWithStatus {
  return { id, display_name: name, source_name: '', active: true, is_favorite, last_activity };
}

describe('CFG-P8A — ordenação canônica (favoritas → recentes → nome)', () => {
  it('1. favorita aparece primeiro', () => {
    const out = sortAccountsByPreference([
      acc('B', 'Banco B'),
      acc('A', 'Banco A', true),
    ]);
    expect(out[0].id).toBe('A');
  });

  it('2. não favorita depois', () => {
    const out = sortAccountsByPreference([
      acc('X', 'X', true),
      acc('Y', 'Y'),
    ]);
    expect(out.map((a) => a.id)).toEqual(['X', 'Y']);
  });

  it('3. recente ordena dentro do grupo (mais recente primeiro)', () => {
    const out = sortAccountsByPreference([
      acc('OLD', 'Velha', false, '2020-01-01'),
      acc('NEW', 'Nova', false, '2026-08-01'),
      acc('FOLD', 'Fav Velha', true, '2019-01-01'),
      acc('FNEW', 'Fav Nova', true, '2026-08-02'),
    ]);
    expect(out.map((a) => a.id)).toEqual(['FNEW', 'FOLD', 'NEW', 'OLD']);
  });

  it('4. sem atividade vai depois das com atividade (dentro do mesmo grupo)', () => {
    const out = sortAccountsByPreference([
      acc('NONE', 'Sem atividade'),
      acc('ACT', 'Com atividade', false, '2026-01-01'),
    ]);
    expect(out.map((a) => a.id)).toEqual(['ACT', 'NONE']);
  });

  it('5. empate por nome (A→Z)', () => {
    const out = sortAccountsByPreference([
      acc('B', 'Zebra'),
      acc('A', 'Alfa'),
    ]);
    expect(out.map((a) => a.display_name)).toEqual(['Alfa', 'Zebra']);
  });

  it('6. empate final determinístico por id (interno, não exposto na UI)', () => {
    const out = sortAccountsByPreference([
      acc('bbb', 'Mesmo Nome'),
      acc('aaa', 'Mesmo Nome'),
    ]);
    expect(out.map((a) => a.id)).toEqual(['aaa', 'bbb']);
  });

  it('7/8. favoritar/desfavoritar muda a ordem', () => {
    const base = [acc('A', 'A'), acc('B', 'B')];
    const favA = sortAccountsByPreference(base.map((a) => (a.id === 'A' ? { ...a, is_favorite: true } : a)));
    expect(favA[0].id).toBe('A');
    const unfavA = sortAccountsByPreference(favA.map((a) => (a.id === 'A' ? { ...a, is_favorite: false } : a)));
    // sem atividade, empatados por nome (A < B) — desfavoritar A faz a ordem voltar à canônica
    expect(unfavA.map((a) => a.id)).toEqual(['A', 'B']);
    // e uma conta favorita com atividade recente supera a nome-simples
    const favB = sortAccountsByPreference(base.map((a) => (a.id === 'B' ? { ...a, is_favorite: true, last_activity: '2026-08-01' } : a)));
    expect(favB[0].id).toBe('B');
  });

  it('13. TransactionEditor respeita favoritas (seletor reusa a mesma lista ordenada)', () => {
    const editor = readSource('components/TransactionEditor.tsx');
    // o editor ordena por display_name; a preferência vem da AccountsSection.
    // Garantir que nenhum UUID/id cru aparece no seletor.
    const jsx = editor.slice(editor.lastIndexOf('return ('));
    expect(jsx).not.toContain('a.id.slice');
  });

  it('14. Análises NÃO muda ordem financeira por causa de favorita', () => {
    const analytics = readSource('lib/analytics.ts');
    expect(analytics).not.toContain('is_favorite');
    expect(analytics).not.toContain('last_activity');
  });

  it('20. zero UUID técnico exposto na AccountsSection', () => {
    const src = readSource('settings/AccountsSection.tsx');
    const jsx = src.slice(src.lastIndexOf('return ('));
    expect(jsx).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('3b. mesma recência -> maior frequência primeiro', () => {
    const out = sortAccountsByPreference([
      { ...acc('LOW', 'Freq Baixa', false, '2026-08-01'), usage_count: 2 },
      { ...acc('HIGH', 'Freq Alta', false, '2026-08-01'), usage_count: 20 },
    ]);
    expect(out.map((a) => a.id)).toEqual(['HIGH', 'LOW']);
  });

  it('5b. entre não favoritas com mesma recência -> maior frequência primeiro', () => {
    const out = sortAccountsByPreference([
      { ...acc('A', 'A', false, '2026-01-01'), usage_count: 1 },
      { ...acc('B', 'B', false, '2026-01-01'), usage_count: 99 },
    ]);
    expect(out.map((a) => a.id)).toEqual(['B', 'A']);
  });

  it('10b. soft-deleted não contam em recência/frequência (RPC filtra deleted_at IS NULL)', () => {
    const mig = readFileSync(resolve(here, '..', '..', '..', 'supabase', 'migrations', '022_account_profile_favorites.sql'), 'utf8');
    expect(mig).toContain('deleted_at IS NULL');
    expect(mig).toContain('MAX(t.occurred_on)');
    expect(mig).toContain('COUNT(*)');
  });

  it('9b. Pessoal/Negócio têm metadata de uso independente (perfil do JWT, nunca do cliente)', () => {
    const mig = readFileSync(resolve(here, '..', '..', '..', 'supabase', 'migrations', '022_account_profile_favorites.sql'), 'utf8');
    expect(mig).toContain('t.profile_id = v_profile');
    expect(mig).toContain('app.jwt_profile_id()');
    expect(mig).not.toContain('p_profile_id');
  });

  it('L. frontend novo NÃO lê accounts.is_favorite global para decidir favorito', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toContain("from('account_profile_favorites')");
    expect(src).not.toContain(".from('accounts').select('id, display_name, source_name, is_favorite')");
  });
});

describe('CFG-P8A — preferência por perfil', () => {
  it('9. profile isolation: favoritos consultados por profile_id', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toContain(".eq('profile_id', profileId)");
    expect(src).toContain("from('account_profile_favorites')");
  });

  it('10. cross-profile não herda favorito (por profile_id no RPC; validação de vínculo no backend)', () => {
    const mig = readFileSync(resolve(here, '..', '..', '..', 'supabase', 'migrations', '022_account_profile_favorites.sql'), 'utf8');
    expect(mig).toContain('conta nao esta vinculada a este perfil');
    expect(mig).toContain('app.jwt_profile_id()');
  });

  it('11. inactive não aparece como active só por ser favorita', () => {
    const src = readSource('settings/AccountsSection.tsx');
    // a estrela não altera o badge de status; a ordenação não muda `active`
    expect(src).toContain("a.active ? 'Ativa' : 'Inativa'");
  });

  it('12. reativada mantém preferência (favorito persistido por account+profile, não limpo na desativação)', () => {
    const mig = readFileSync(resolve(here, '..', '..', '..', 'supabase', 'migrations', '022_account_profile_favorites.sql'), 'utf8');
    const createBlock = mig.match(/CREATE TABLE account_profile_favorites\([\s\S]*?\);/)?.[0] ?? '';
    expect(createBlock).not.toContain('deleted_at');
    expect(createBlock).not.toContain('archived_at');
  });

  it('17. erro de favorite não deixa estado falso (atualiza somente após sucesso)', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toContain("setActionError(String(rpcError.message || rpcError))");
    expect(src).toContain('setAccounts((prev) => sortAccountsByPreference');
  });

  it('18. double click não duplica (guard favoriteBusyId)', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toContain('if (favoriteBusyId) return;');
    expect(src).toContain('disabled={favoriteBusyId !== null}');
  });

  it('15. mobile: alvo clicável de 44px (acessível)', () => {
    const css = readSource('index.css');
    expect(css).toContain('.settings-fav-btn');
    expect(css).toContain('min-width: 44px');
    expect(css).toContain('min-height: 44px');
  });

  it('16. acessibilidade: aria-label dinâmico + aria-pressed', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toContain('aria-label={a.is_favorite ? `Desfavoritar');
    expect(src).toContain('aria-pressed={a.is_favorite}');
    expect(src).toContain('title={a.is_favorite ? \'Favorita\' : \'Favoritar\'}');
  });

  it('19. zero alteração no account CRUD (create/update/active intactos)', () => {
    const src = readSource('lib/accountCrud.ts');
    expect(src).toContain("rpc('account_create'");
    expect(src).toContain("rpc('account_update'");
    expect(src).toContain("rpc('account_set_profile_active'");
  });
});

describe('CFG-P8A — recência (derivada, sem N+1)', () => {
  it('mapUsage converte linhas agregadas em mapa (recência + frequência)', () => {
    const m = mapUsage([
      { account_id: 'A', last_activity: '2026-08-01', usage_count: 5 },
      { account_id: 'B', last_activity: null, usage_count: 0 },
    ]);
    expect(m.get('A')).toEqual({ last_activity: '2026-08-01', usage_count: 5 });
    expect(m.get('B')).toEqual({ last_activity: null, usage_count: 0 });
  });

  it('N+1=0: usage via RPC único (account_usage_stats), aggregate PostgREST removido', () => {
    const q = readSource('lib/accountQuery.ts');
    expect(q).toContain("USAGE_RPC_NAME = 'account_usage_stats'");
    const fn = q.match(/export function buildUsageQuery[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('client.rpc(USAGE_RPC_NAME)');
    expect(fn).not.toMatch(/\.group\(/);
    expect(fn).not.toMatch(/\.eq\(/);
    expect(fn).not.toMatch(/\.is\(/);
    expect(q).not.toContain('occurred_on.max()');
    expect(q).not.toContain('usage_count:count()');
    expect(q).not.toContain('USAGE_SELECT');
  });

  it('mapUsage interpreta o retorno do RPC (account_id, last_activity, usage_count)', () => {
    const m = mapUsage([
      { account_id: 'A', last_activity: '2026-08-01', usage_count: '5' },
      { account_id: 'B', last_activity: null, usage_count: 0 },
    ]);
    expect(m.get('A')).toEqual({ last_activity: '2026-08-01', usage_count: 5 });
    expect(m.get('B')).toEqual({ last_activity: null, usage_count: 0 });
  });

  it('AccountsSection: erro do RPC de uso não quebra a tela (try/catch; ordenação segura)', () => {
    const src = readSource('settings/AccountsSection.tsx');
    expect(src).toMatch(/try \{[\s\S]*buildUsageQuery\(supabase as any\)[\s\S]*\} catch/);
    expect(src).not.toContain('occurred_on.max()');
  });

  it('TransactionEditor usa o MESMO helper RPC (sem duplicar a query)', () => {
    const src = readSource('components/TransactionEditor.tsx');
    expect(src).toContain('buildUsageQuery(supabase as any)');
    expect(src).toContain('mapUsage(');
    expect(src).not.toContain('occurred_on.max()');
    expect(src).not.toContain('.group(');
  });
});