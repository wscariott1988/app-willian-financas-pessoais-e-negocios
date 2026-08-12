import { describe, it, expect } from 'vitest';

// --- Pure helper functions replicated from component logic ---

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('T')[0].split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatCurrencyText(val: string, kind: string): string {
  const num = parseFloat(val);
  const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
  return `${prefix} R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isCategoryCompatible(
  catDirection: string,
  txKind: string
): boolean {
  return catDirection === txKind;
}

function filterTransactions(
  transactions: Array<{ status: string; category_id: string | null; account_id: string; occurred_on: string; raw_description: string }>,
  opts: {
    filterReviewOnly?: boolean;
    filterNoCategory?: boolean;
    selectedAccount?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
  }
) {
  return transactions.filter(tx => {
    if (opts.filterReviewOnly && tx.status !== 'review') return false;
    if (opts.filterNoCategory && tx.category_id !== null) return false;
    if (opts.selectedAccount && tx.account_id !== opts.selectedAccount) return false;
    if (opts.startDate && tx.occurred_on < opts.startDate) return false;
    if (opts.endDate && tx.occurred_on > opts.endDate) return false;
    if (opts.search && !tx.raw_description.toLowerCase().includes(opts.search.toLowerCase())) return false;
    return true;
  });
}

// --- Tests ---

describe('formatDate', () => {
  it('formats ISO date correctly (YYYY-MM-DD)', () => {
    expect(formatDate('2022-01-01')).toBe('01/01/2022');
  });

  it('formats ISO datetime (strips time part)', () => {
    expect(formatDate('2022-03-15T00:00:00.000Z')).toBe('15/03/2022');
  });

  it('returns empty string for empty input', () => {
    expect(formatDate('')).toBe('');
  });

  it('returns original string if format is unrecognized', () => {
    expect(formatDate('invalid')).toBe('invalid');
  });
});

describe('formatCurrencyText', () => {
  it('formats expense with minus prefix', () => {
    const result = formatCurrencyText('100.00', 'expense');
    expect(result).toContain('-');
    expect(result).toContain('R$');
    expect(result).toContain('100');
  });

  it('formats income with plus prefix', () => {
    const result = formatCurrencyText('250.50', 'income');
    expect(result).toContain('+');
    expect(result).toContain('250');
  });

  it('formats transfer without sign prefix', () => {
    const result = formatCurrencyText('50.00', 'transfer');
    expect(result.trim()).not.toMatch(/^[-+]/);
    expect(result).toContain('R$');
  });

  it('handles large values correctly', () => {
    const result = formatCurrencyText('12345.67', 'expense');
    expect(result).toContain('-');
    expect(result).toContain('12.345');
  });
});

describe('isCategoryCompatible', () => {
  it('returns true when category direction matches transaction kind', () => {
    expect(isCategoryCompatible('expense', 'expense')).toBe(true);
    expect(isCategoryCompatible('income', 'income')).toBe(true);
  });

  it('returns false when they do not match', () => {
    expect(isCategoryCompatible('expense', 'income')).toBe(false);
    expect(isCategoryCompatible('income', 'expense')).toBe(false);
    expect(isCategoryCompatible('transfer', 'expense')).toBe(false);
  });
});

describe('filterTransactions', () => {
  const transactions = [
    { id: '1', status: 'review', category_id: null, account_id: 'acc-1', occurred_on: '2022-01-05', raw_description: 'Aluguel' },
    { id: '2', status: 'posted', category_id: 'cat-1', account_id: 'acc-2', occurred_on: '2022-02-10', raw_description: 'Supermercado' },
    { id: '3', status: 'review', category_id: null, account_id: 'acc-1', occurred_on: '2022-03-15', raw_description: 'Salário' },
    { id: '4', status: 'posted', category_id: null, account_id: 'acc-2', occurred_on: '2022-04-20', raw_description: 'Academia' },
  ];

  it('returns all transactions with no filters', () => {
    expect(filterTransactions(transactions as any, {})).toHaveLength(4);
  });

  it('filters by status = review', () => {
    const result = filterTransactions(transactions as any, { filterReviewOnly: true });
    expect(result).toHaveLength(2);
    expect(result.every(t => t.status === 'review')).toBe(true);
  });

  it('filters by no category', () => {
    const result = filterTransactions(transactions as any, { filterNoCategory: true });
    expect(result).toHaveLength(3);
    expect(result.every(t => t.category_id === null)).toBe(true);
  });

  it('filters by account', () => {
    const result = filterTransactions(transactions as any, { selectedAccount: 'acc-1' });
    expect(result).toHaveLength(2);
    expect(result.every(t => t.account_id === 'acc-1')).toBe(true);
  });

  it('filters by date range', () => {
    const result = filterTransactions(transactions as any, {
      startDate: '2022-02-01',
      endDate: '2022-03-31'
    });
    expect(result).toHaveLength(2);
    expect(result.map(t => t.occurred_on)).toEqual(['2022-02-10', '2022-03-15']);
  });

  it('filters by search text (case insensitive)', () => {
    const result = filterTransactions(transactions as any, { search: 'salário' });
    expect(result).toHaveLength(1);
    expect(result[0].raw_description).toBe('Salário');
  });

  it('combines multiple filters correctly', () => {
    const result = filterTransactions(transactions as any, {
      filterReviewOnly: true,
      filterNoCategory: true,
      selectedAccount: 'acc-1'
    });
    expect(result).toHaveLength(2);
  });
});
