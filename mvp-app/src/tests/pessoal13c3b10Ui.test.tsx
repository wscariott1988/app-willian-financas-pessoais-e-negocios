// @vitest-environment jsdom

// pessoal13c3b10Ui.test.tsx — PESSOAL-13C3B.10: nomenclatura "Economia
// anualizada (simulação)" na interface. O rótulo antigo "Projeção anual
// (simulação)" NÃO pode aparecer visualmente.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FinanceAiSection } from '../components/FinanceAiSection';
import type { UiMessage } from '../lib/chatState';
import * as chatApi from '../lib/chatApi';

vi.mock('../lib/financeAiClient', () => {
  class FinanceApiError extends Error {
    constructor(message?: string) {
      super(message ?? 'FinanceApiError');
      this.name = 'FinanceApiError';
    }
  }
  return {
    FinanceApiError,
    askFinance: vi.fn(),
  };
});

vi.mock('../lib/chatApi', () => ({
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listMessages: vi.fn(),
}));

let originalActEnv: unknown;

beforeAll(() => {
  originalActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (originalActEnv === undefined) {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  } else {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  }
});

const msg = (over: Partial<UiMessage> & { key: string; role: 'user' | 'assistant' }): UiMessage => ({
  text: '',
  status: over.role === 'assistant' ? 'completed' : 'sent',
  optimistic: false,
  clientRequestId: null,
  createdAt: '2026-04-10T10:00:00.000Z',
  error: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatApi.listConversations).mockResolvedValue([
    { id: 'c1', title: 'Conversa Teste', lastMessageAt: '2026-04-10T10:00:00.000Z' },
  ]);
  vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], hasMore: false });
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C3B.10 — nomenclatura de economia anualizada na interface', () => {
  it('DOM mostra "Economia anualizada (simulação)" no card de savings', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Oportunidades de economia' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Oportunidade potencial identificada:',
        cards: [
          {
            kind: 'savings',
            title: 'Alimentação > Supermercado',
            subtitle: 'Oportunidade potencial para revisar',
            rows: [
              { label: 'Economia mensal (cenário 10%)', value: 'R$ 40,00' },
              { label: 'Economia anualizada (simulação)', value: 'R$ 480,00' },
            ],
          },
        ],
        notice:
          'Simulação com redução de 10% sobre a média mensal recente. Moradia > Aluguel e Dívidas > Empréstimo não entraram na simulação percentual.',
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Economia anualizada (simulação)')).toBeDefined();
    expect(screen.getByText('R$ 480,00')).toBeDefined();
    expect(screen.queryByText('Projeção anual (simulação)')).toBeNull();
    expect(screen.queryByText('Projeção')).toBeNull();
  });
});