import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { parseAmount, isAccountValidForDate, TransactionEditor } from '../components/TransactionEditor';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const NOOP = () => {};

// --- Pure helper functions exported from TransactionEditor ---

describe('parseAmount', () => {
  it('parses integer input', () => {
    expect(parseAmount('1000')).toBe(1000);
  });

  it('parses pt-BR decimal with comma', () => {
    expect(parseAmount('12,34')).toBe(12.34);
  });

  it('parses pt-BR thousands + comma decimal', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
  });

  it('parses en-US thousands + dot decimal', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
  });

  it('ignores R$ prefix and spaces', () => {
    expect(parseAmount('R$ 250,50')).toBe(250.5);
  });

  it('rejects zero and negative values', () => {
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-10')).toBeNull();
    expect(parseAmount('-1.000,00')).toBeNull();
  });

  it('rejects empty and malformed input', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('R$')).toBeNull();
  });
});

describe('isAccountValidForDate', () => {
  const periods = [
    { account_id: 'acc-1', starts_on: '2022-01-01', ends_on: '2022-06-30' },
    { account_id: 'acc-2', starts_on: '2022-01-01', ends_on: null },
    { account_id: 'acc-3', starts_on: '2022-07-01', ends_on: null },
  ];

  it('returns true inside the active window', () => {
    expect(isAccountValidForDate('acc-1', '2022-03-15', periods)).toBe(true);
  });

  it('returns true on boundary dates (inclusive)', () => {
    expect(isAccountValidForDate('acc-1', '2022-01-01', periods)).toBe(true);
    expect(isAccountValidForDate('acc-1', '2022-06-30', periods)).toBe(true);
  });

  it('returns false outside the active window', () => {
    expect(isAccountValidForDate('acc-1', '2022-07-01', periods)).toBe(false);
    expect(isAccountValidForDate('acc-1', '2021-12-31', periods)).toBe(false);
  });

  it('treats null ends_on as open-ended', () => {
    expect(isAccountValidForDate('acc-2', '2030-01-01', periods)).toBe(true);
  });

  it('returns false for unknown account or empty inputs', () => {
    expect(isAccountValidForDate('acc-999', '2022-03-15', periods)).toBe(false);
    expect(isAccountValidForDate('', '2022-03-15', periods)).toBe(false);
    expect(isAccountValidForDate('acc-1', '', periods)).toBe(false);
  });
});

// --- Smoke: editor monta o formulário de criação/edição no SSR ---

describe('TransactionEditor render', () => {
  it('renders the create form (Nova Transação) with required fields', () => {
    const html = renderToString(
      createElement(TransactionEditor, {
        profileId: '11111111-1111-1111-1111-111111111111',
        profileCode: 'personal',
        transaction: null,
        creating: true,
        onSuccess: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Nova Transação');
    expect(html).toContain('id="te-kind"');
    expect(html).toContain('id="te-desc"');
    expect(html).toContain('id="te-amount"');
    expect(html).toContain('id="te-date"');
    expect(html).toContain('id="te-account"');
    expect(html).toContain('id="te-status"');
    expect(html).toContain('id="te-memo"');
    expect(html).toContain('Criar Transação');
  });

  it('renders the edit form (Editar Transação) with save label', () => {
    const html = renderToString(
      createElement(TransactionEditor, {
        profileId: '11111111-1111-1111-1111-111111111111',
        profileCode: 'personal',
        transaction: { id: 'tx-1', profile_id: 'p', account_id: 'a', category_id: null, transaction_kind: 'expense', amount: '10', occurred_on: '2026-08-01', raw_description: 'Teste', normalized_description: 'teste', category_raw: null, status: 'posted', categories: null, accounts: null },
        creating: false,
        onSuccess: NOOP,
        onClose: NOOP,
      }),
    );
    expect(html).toContain('Editar Transação');
    expect(html).toContain('Salvar Alterações');
  });
});
