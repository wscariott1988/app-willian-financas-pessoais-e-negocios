// @vitest-environment jsdom

// pessoal13c3b14Ui.test.tsx — PESSOAL-13C3B.14: conteúdo EFETIVAMENTE visível
// das lentes excluídas. Prova no DOM que a resposta renderiza:
//   - UMA única explicação ("A categoria ... representa ...");
//   - badge global do período presente exatamente UMA vez;
//   - ausência de evidências, notice duplicado e cards;
//   - rodapé determinístico visível.
// E que o fluxo geral continua mostrando o notice coletivo com o aviso de
// exclusão (cards + notice no DOM).
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FinanceAiSection } from '../components/FinanceAiSection';
import type { ChatConversationItem, UiMessage } from '../lib/chatState';
import { askFinance } from '../lib/financeAiClient';
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

const ALUGUEL_ANSWER =
  'A categoria Moradia > Aluguel representa um compromisso fixo e não entra na simulação percentual. O histórico de pagamentos sozinho não permite estimar uma economia real; seria necessário avaliar o contrato e suas condições.';

const DETERMINISTIC_FOOTER =
  'Resposta calculada diretamente a partir dos seus dados (IA não foi acionada).';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatApi.listConversations).mockResolvedValue([
    { id: 'c1', title: 'Conversa Teste', lastMessageAt: '2026-04-10T10:00:00.000Z' } as ChatConversationItem,
  ]);
  vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], hasMore: false });
  vi.mocked(askFinance).mockResolvedValue({} as never);
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C3B.14 — DOM das lentes excluídas (conteúdo visível)', () => {
  it('Aluguel: uma única explicação, badge do período único, sem evidence/notice/cards e rodapé determinístico', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'u1', role: 'user', text: 'Só em aluguel?' }),
      msg({
        key: 'a1',
        role: 'assistant',
        text: ALUGUEL_ANSWER,
        engine: 'deterministic',
        periodAnalyzed: { start: '2026-03-01', end: '2026-08-31' },
        cards: [],
        evidence: [],
        notice: '',
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText(/A categoria Moradia > Aluguel representa/)).toBeDefined();
    expect(screen.getAllByText(/A categoria Moradia > Aluguel representa/)).toHaveLength(1);
    expect(screen.queryAllByText(/Período analisado/)).toHaveLength(1);
    expect(container.querySelector('.finance-ai-evidence')).toBeNull();
    expect(container.querySelector('.finance-ai-notice')).toBeNull();
    expect(container.querySelector('.finance-ai-card-item')).toBeNull();
    expect(screen.getByText(DETERMINISTIC_FOOTER)).toBeDefined();
  });

  it('lente excluída nunca replica o período em evidence (badge é a única menção visível)', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'u1', role: 'user', text: 'E apenas investimentos?' }),
      msg({
        key: 'a1',
        role: 'assistant',
        text:
          'A categoria Investimentos representa alocação patrimonial, não consumo reduzível, e por isso não entra na simulação percentual.',
        engine: 'deterministic',
        periodAnalyzed: { start: '2026-03-01', end: '2026-08-31' },
        cards: [],
        evidence: [],
        notice: '',
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText(/A categoria Investimentos representa/)).toBeDefined();
    expect(screen.queryAllByText(/Período analisado/)).toHaveLength(1);
    expect(container.querySelector('.finance-ai-evidence')).toBeNull();
    expect(container.querySelector('.finance-ai-notice')).toBeNull();
  });

  it('fluxo geral continua exibindo notice coletivo e cards elegíveis no DOM', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'u1', role: 'user', text: 'Onde tenho oportunidades de economia de 10%?' }),
      msg({
        key: 'a1',
        role: 'assistant',
        text: 'Com uma redução de 10% sobre as médias mensais recentes, as maiores oportunidades potenciais para revisar estão em: Alimentação > Supermercado.',
        engine: 'deterministic',
        periodAnalyzed: { start: '2026-03-01', end: '2026-08-31' },
        cards: [
          {
            kind: 'savings' as const,
            title: 'Alimentação > Supermercado',
            subtitle: 'Oportunidade potencial para revisar',
            rows: [
              { label: 'Economia mensal (cenário 10%)', value: 'R$ 40,00' },
              { label: 'Economia anualizada (simulação)', value: 'R$ 480,00' },
            ],
          },
        ],
        evidence: [],
        notice:
          'Simulação com redução de 10% sobre a média mensal recente. Moradia > Aluguel e Dívidas > Empréstimo não entraram na simulação percentual.',
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText(/as maiores oportunidades potenciais/)).toBeDefined();
    expect(screen.getByText(/não entraram na simulação percentual/)).toBeDefined();
    expect(container.querySelectorAll('.finance-ai-card-item')).toHaveLength(1);
    expect(screen.getByText('Alimentação > Supermercado')).toBeDefined();
    expect(screen.getByText(DETERMINISTIC_FOOTER)).toBeDefined();
  });
});