import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { parseAmount, isAccountValidForDate, buildSavePayload, TransactionEditor, type TxFormState } from '../components/TransactionEditor';
import { isStatusEditable, STATUS_OPTIONS, displayStatusValue } from '../lib/status';

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

// --- STATUS-P0: vocabulário Pago/Não pago + cutoff + preservação de legados ---

describe('STATUS-P0 — isStatusEditable (cutoff)', () => {
  it('2026-07-31 => controle de status oculto', () => {
    expect(isStatusEditable('2026-07-31')).toBe(false);
  });

  it('2026-08-01 => controle visível', () => {
    expect(isStatusEditable('2026-08-01')).toBe(true);
  });

  it('2026-08-02 => controle visível', () => {
    expect(isStatusEditable('2026-08-02')).toBe(true);
  });

  it('data vazia (formulário novo) => controle visível (default preservado)', () => {
    expect(isStatusEditable('')).toBe(true);
  });
});

describe('STATUS-P0 — opções visíveis no editor', () => {
  it('exatamente 2 opções: Pago (posted) e Não pago (pending)', () => {
    expect(STATUS_OPTIONS).toHaveLength(2);
    expect(STATUS_OPTIONS.map((o) => o.label)).toEqual(['Pago', 'Não pago']);
    expect(STATUS_OPTIONS.map((o) => o.value)).toEqual(['posted', 'pending']);
  });

  it('review/scheduled/ignored não existem como opção', () => {
    const values = STATUS_OPTIONS.map((o) => o.value);
    expect(values).not.toContain('review');
    expect(values).not.toContain('scheduled');
    expect(values).not.toContain('ignored');
  });

  it('formulário novo SSR: somente Pago/Não pago, sem códigos nem parênteses', () => {
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
    expect(html).toContain('id="te-status"');
    expect(html).toContain('>Pago</option>');
    expect(html).toContain('>Não pago</option>');
    expect(html).not.toContain('(posted)');
    expect(html).not.toContain('(pending)');
    expect(html).not.toContain('(review)');
    expect(html).not.toContain('(scheduled)');
    expect(html).not.toContain('(ignored)');
    expect(html).not.toContain('Em revisão');
    expect(html).not.toContain('Agendada');
    expect(html).not.toContain('Ignorada');
    const statusSelect = html.match(/<select id="te-status"[\s\S]*?<\/select>/)?.[0] || '';
    expect(statusSelect.match(/<option/g) ?? []).toHaveLength(2);
    expect(statusSelect).not.toContain('value="review"');
    expect(statusSelect).not.toContain('value="scheduled"');
    expect(statusSelect).not.toContain('value="ignored"');
  });

  it('posted => exibe Pago; qualquer outro (incl. legado) exibe Não pago até toque', () => {
    expect(displayStatusValue('posted')).toBe('posted');
    expect(displayStatusValue('pending')).toBe('pending');
    expect(displayStatusValue('review')).toBe('pending');
    expect(displayStatusValue('scheduled')).toBe('pending');
    expect(displayStatusValue('ignored')).toBe('pending');
  });

  it('bloco de status é condicionado a isStatusEditable(form.occurred_on)', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'TransactionEditor.tsx'), 'utf8');
    expect(src).toContain('isStatusEditable(form.occurred_on)');
  });
});

describe('STATUS-P0 — payload e preservação (sem normalização silenciosa)', () => {
  const base: TxFormState = {
    kind: 'expense',
    description: 'Mercado',
    amount: '10,00',
    occurred_on: '2026-08-01',
    account_id: 'acc-1',
    to_account_id: '',
    category_id: '',
    status: 'posted',
    memo: '',
  };

  it('transaction histórica editada: status original preservado', () => {
    const p = buildSavePayload({ ...base, status: 'posted' });
    expect(p.status).toBe('posted');
  });

  it('legacy review >= cutoff: edição de outro campo preserva review', () => {
    const p = buildSavePayload({ ...base, status: 'review' });
    expect(p.status).toBe('review');
  });

  it('legacy scheduled >= cutoff: edição de outro campo preserva scheduled', () => {
    const p = buildSavePayload({ ...base, status: 'scheduled' });
    expect(p.status).toBe('scheduled');
  });

  it('legacy ignored >= cutoff: edição de outro campo preserva ignored', () => {
    const p = buildSavePayload({ ...base, status: 'ignored' });
    expect(p.status).toBe('ignored');
  });

  it('alteração explícita para Pago => payload status=posted', () => {
    const p = buildSavePayload({ ...base, status: 'posted' });
    expect(p.status).toBe('posted');
  });

  it('alteração explícita para Não pago => payload status=pending', () => {
    const p = buildSavePayload({ ...base, status: 'pending' });
    expect(p.status).toBe('pending');
  });
});
