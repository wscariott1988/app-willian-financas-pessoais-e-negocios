import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CategorizerPanel } from '../components/CategorizerPanel';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const tx = {
  id: '11111111-1111-1111-1111-111111111111',
  profile_id: '22222222-2222-2222-2222-222222222222',
  account_id: '33333333-3333-3333-3333-333333333333',
  category_id: null,
  transaction_kind: 'expense' as const,
  amount: '25.90',
  occurred_on: '2026-08-10',
  raw_description: 'Supermercado',
  normalized_description: 'supermercado',
  category_raw: 'mercado',
  status: 'review' as const,
  categories: null,
  accounts: null,
};

describe('CategorizerPanel — ação de fechar acessível', () => {
  it('6) renderiza botão fechar com aria-label quando onClose está presente', () => {
    const html = renderToString(
      <CategorizerPanel transaction={tx as any} onSuccess={() => {}} onClose={() => {}} />,
    );

    expect(html).toContain('aria-label="Fechar painel de recategorização"');
    expect(html).toContain('title="Fechar"');
    expect(html).toContain('categorizer-close');
    expect(html).toContain('type="button"');
  });

  it('6b) sem onClose o painel não expõe o botão', () => {
    const html = renderToString(
      <CategorizerPanel transaction={tx as any} onSuccess={() => {}} />,
    );

    expect(html).not.toContain('Fechar painel de recategorização');
    expect(html).not.toContain('categorizer-close');
  });

  it('6c) painel vazio (sem transação) também oferece fechar quando onClose existe', () => {
    const html = renderToString(
      <CategorizerPanel transaction={null} onSuccess={() => {}} onClose={() => {}} />,
    );

    expect(html).toContain('aria-label="Fechar painel de recategorização"');
  });
});
