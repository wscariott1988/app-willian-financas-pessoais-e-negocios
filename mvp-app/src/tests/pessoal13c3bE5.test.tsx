// @vitest-environment jsdom

// pessoal13c3bE5.test.tsx — PESSOAL-13C3B-E5: renderização dos cards analíticos e avisos na interface.
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

describe('PESSOAL-13C3B-E5 — Renderização de cards analíticos e notice', () => {
  it('1. growth imediato exibe rótulo "Crescimento", título, subtítulo e rows', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Onde estou gastando mais?' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Aqui estão os maiores crescimentos de gastos:',
        engine: 'deterministic',
        cards: [
          {
            kind: 'growth',
            title: 'Alimentação > Supermercado',
            subtitle: 'Crescimento de 25% frente à média',
            rows: [
              { label: 'Atual', value: 'R$ 1.250,00' },
              { label: 'Média anterior', value: 'R$ 1.000,00' },
            ],
          },
        ],
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Crescimento')).toBeDefined();
    expect(screen.getByText('Alimentação > Supermercado')).toBeDefined();
    expect(screen.getByText('Crescimento de 25% frente à média')).toBeDefined();
    expect(screen.getByText('Atual')).toBeDefined();
    expect(screen.getByText('R$ 1.250,00')).toBeDefined();
    expect(screen.getByText('Média anterior')).toBeDefined();
    expect(screen.getByText('R$ 1.000,00')).toBeDefined();
  });

  it('2. new imediato exibe rótulo "Novo gasto"', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Quais os novos gastos?' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Identificamos novos gastos:',
        cards: [
          {
            kind: 'new',
            title: 'Educação > English School',
            subtitle: 'Primeiro registro em abril',
            rows: [{ label: 'Valor', value: 'R$ 450,00' }],
          },
        ],
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Novo gasto')).toBeDefined();
    expect(screen.getByText('Educação > English School')).toBeDefined();
    expect(screen.getByText('Primeiro registro em abril')).toBeDefined();
    expect(screen.getByText('R$ 450,00')).toBeDefined();
  });

  it('3. spike imediato exibe rótulo "Pico pontual"', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Houve pico?' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Detectamos pico pontual:',
        cards: [
          {
            kind: 'spike',
            title: 'Transporte > Combustível',
            subtitle: 'Acima do padrão habitual',
            rows: [{ label: 'Gasto', value: 'R$ 800,00' }],
          },
        ],
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Pico pontual')).toBeDefined();
    expect(screen.getByText('Transporte > Combustível')).toBeDefined();
    expect(screen.getByText('R$ 800,00')).toBeDefined();
  });

  it('4. savings imediato exibe rótulo "Oportunidade potencial para revisar" e notice', async () => {
    const noticeText = 'Valores de economia são simulações com base na média recente; não consideram metas mínimas pessoais.';
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Oportunidades de economia' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Oportunidade de economia identificada:',
        cards: [
          {
            kind: 'savings',
            title: 'Assinaturas > Streaming',
            subtitle: 'Redução potencial',
            rows: [{ label: 'Economia estimada', value: 'R$ 100,00' }],
          },
        ],
        notice: noticeText,
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Oportunidade potencial para revisar')).toBeDefined();
    expect(screen.getByText('Assinaturas > Streaming')).toBeDefined();
    expect(screen.getByText('R$ 100,00')).toBeDefined();
    expect(screen.getByText(noticeText)).toBeDefined();
  });

  it('5-8. Rótulos, títulos, subtítulos e rows preservam ordem e contrato', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Listar cards' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Cards múltiplos',
        cards: [
          {
            kind: 'growth',
            title: 'Card 1',
            subtitle: 'Sub 1',
            rows: [{ label: 'L1', value: 'V1' }],
          },
          {
            kind: 'savings',
            title: 'Card 2',
            subtitle: '',
            rows: [
              { label: 'L2', value: 'V2' },
              { label: 'L3', value: 'V3' },
            ],
          },
        ],
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Card 1')).toBeDefined();
    expect(screen.getByText('Sub 1')).toBeDefined();
    expect(screen.getByText('Card 2')).toBeDefined();
  });

  it('9-16. Dados insuficientes sem cards, payload legado sem cards, cards vazios, notice vazio', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Dados insuficientes' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Análise sem dados suficientes.',
        cards: [],
        notice: 'Nenhuma categoria apresentou crescimento significativo.',
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Análise sem dados suficientes.')).toBeDefined();
    expect(screen.getByText('Nenhuma categoria apresentou crescimento significativo.')).toBeDefined();
    expect(container.querySelectorAll('.finance-ai-trend-card')).toHaveLength(0);
  });

  it('17-27. Testes de segurança, sanitização, tags maliciosas, acessibilidade e estrutura', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Segurança' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Teste de tags maliciosas',
        cards: [
          {
            kind: 'growth',
            title: 'Título seguro',
            subtitle: 'Sub seguro',
            rows: [{ label: 'Label', value: 'Value' }],
          },
        ],
        notice: 'Notice seguro',
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Teste de tags maliciosas')).toBeDefined();
    expect(container.innerHTML).not.toContain('<script>');
    expect(container.innerHTML).not.toContain('onerror=');
  });

  it('28-38. Navegação, StrictMode, evidence antigo vs cards, e ausência de Ver todas', async () => {
    const messages: UiMessage[] = [
      msg({ key: 'm1', role: 'user', text: 'Evidence vs Cards' }),
      msg({
        key: 'm2',
        role: 'assistant',
        text: 'Resposta com cards e evidence redundante',
        cards: [
          {
            kind: 'growth',
            title: 'Alimentação',
            subtitle: '',
            rows: [{ label: 'Total', value: 'R$ 500,00' }],
          },
        ],
        evidence: [{ label: 'Evidência antiga', value: 'R$ 500,00' }],
      }),
    ];
    vi.mocked(chatApi.listMessages).mockResolvedValue({ messages, hasMore: false });

    render(<FinanceAiSection />);
    expect(await screen.findByText('Alimentação')).toBeDefined();
    expect(screen.queryByText('Evidência antiga')).toBeNull();
    expect(screen.queryByText(/Ver todas/i)).toBeNull();
  });
});
