// @vitest-environment jsdom

// pessoal13c4aE5MobileQuestionOrder.test.tsx — PESSOAL-13C4A-E5: no mobile o
// formulário de pergunta vem ANTES do painel "Nova conversa"/histórico, sem
// duplicar o composer e sem depender só de CSS order (a ordem DOM/leitor/
// teclado coincide com a visual). No desktop o layout visual é preservado via
// grid-template-areas (chats | main com composer abaixo das mensagens).
//
// Provas:
//   a. em viewports mobile (375×667 e 390×844) o composer precede o histórico
//      e o histórico precede as mensagens na ordem DOM/acessível;
//   b. o campo e o botão de envio vêm antes de "Nova conversa";
//   c. existe exatamente UMA instância do composer (sem duplicação);
//   d. o CSS desktop mantém as áreas/layout esperados (chats | main/composer);
//   e. o CSS mobile (≤820px) define o fluxo único composer → chats → main;
//   f. envio e seleção de conversa continuam funcionando;
//   g. mensagens antigas (cache/F5) e cards de projeção continuam renderizando.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FinanceAiSection } from '../components/FinanceAiSection';
import type { ChatConversationItem, UiMessage } from '../lib/chatState';
import { askFinance } from '../lib/financeAiClient';
import type { ProjectionPayloadSuccessV1 } from '../../server/finance-ai/projectionPayloadV1';
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

const here = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

const css = readSource('index.css');

/** Devolve o interior do primeiro bloco `selector { … }` encontrado. */
function ruleBlock(cssSource: string, selector: string): string | null {
  let idx = -1;
  for (;;) {
    idx = cssSource.indexOf(selector, idx + 1);
    if (idx === -1) return null;
    const before = idx === 0 ? ' ' : cssSource[idx - 1];
    if (!/[\s;})]/.test(before)) continue;
    const rest = cssSource.slice(idx + selector.length);
    if (!rest.trimStart().startsWith('{')) continue;
    const open = idx + selector.length + (rest.length - rest.trimStart().length);
    let depth = 0;
    for (let i = open; i < cssSource.length; i++) {
      if (cssSource[i] === '{') depth += 1;
      else if (cssSource[i] === '}') {
        depth -= 1;
        if (depth === 0) return cssSource.slice(open + 1, i);
      }
    }
    return null;
  }
}

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

const conv = (id: string, title: string, lastMessageAt: string): ChatConversationItem => ({
  id,
  title,
  lastMessageAt,
});

const msg = (over: Partial<UiMessage> & { key: string; role: 'user' | 'assistant' }): UiMessage => ({
  text: '',
  status: over.role === 'assistant' ? 'completed' : 'sent',
  optimistic: false,
  clientRequestId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  error: null,
  ...over,
});

const COVERAGE_FULL = {
  windowMonths: 12,
  coveredMonths: 12,
  minimumCoverageMonths: 6,
  requiredFullCoverageMonths: 12,
  windowStart: '2025-08',
  windowEnd: '2026-07',
};

function successBase(): ProjectionPayloadSuccessV1 {
  return {
    version: 1,
    status: 'success',
    intent: 'projection_base',
    quality: 'full',
    reference: { month: '2026-08', kind: 'current' },
    coverage: COVERAGE_FULL,
    summary: { monthlyMeanCents: 100000, annualScenarioCents: 1200000, totalBaseCents: 1200000 },
    comparison: {
      deviation: 'above',
      deviationCents: 30645,
      referenceBasis: 'monthly_mean',
      referenceCents: 19355,
      realizedCents: 50000,
    },
    categories: [],
  };
}

function follows(a: Node, b: Node): boolean {
  return (
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatApi.listConversations).mockResolvedValue([]);
  vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], hasMore: false });
  vi.mocked(askFinance).mockResolvedValue({
    answer: 'Resposta simulada.',
    engine: 'deterministic',
    period: null,
    toolsUsed: [],
    periodAnalyzed: null,
    evidence: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C4A-E5 — mobile: composer antes do histórico (ordem DOM/acessível = visual)', () => {
  it.each([
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ])('$width×$height: composer → histórico → mensagens, e o envio vem antes de "Nova conversa"', async ({ width, height }) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa A', '2026-08-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta A', engine: 'deterministic' }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Resposta A')).toBeTruthy();

    const composer = container.querySelector('.finance-ai-composer') as HTMLElement;
    const chats = container.querySelector('.finance-ai-chats') as HTMLElement;
    const main = container.querySelector('.finance-ai-main') as HTMLElement;
    expect(composer).toBeTruthy();
    expect(chats).toBeTruthy();
    expect(main).toBeTruthy();

    // Ordem DOM/leitor/teclado: composer < histórico < mensagens.
    expect(follows(composer, chats)).toBe(true);
    expect(follows(chats, main)).toBe(true);

    // O campo e o botão de envio vêm antes do painel "Nova conversa" + lista.
    const input = screen.getByLabelText('Sua pergunta sobre as finanças');
    const submit = screen.getByRole('button', { name: 'Perguntar' });
    const newChat = screen.getByRole('button', { name: 'Nova conversa' });
    expect(follows(input, newChat)).toBe(true);
    expect(follows(submit, newChat)).toBe(true);
    expect(follows(newChat, main)).toBe(true);
  });

  it('existe exatamente UM composer: um único form, textarea e botão de envio', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa A', '2026-08-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [msg({ key: 'a1', role: 'assistant', text: 'Resposta A', engine: 'deterministic' })],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Resposta A')).toBeTruthy();

    expect(container.querySelectorAll('.finance-ai-composer')).toHaveLength(1);
    expect(container.querySelectorAll('.finance-ai-form')).toHaveLength(1);
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(screen.getAllByLabelText('Sua pergunta sobre as finanças')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Perguntar' })).toHaveLength(1);
  });
});

describe('PESSOAL-13C4A-E5 — desktop preserva as áreas e o layout', () => {
  it('grid base: colunas 220px|1fr com áreas chats|main e composer abaixo das mensagens', () => {
    const layout = ruleBlock(css, '.finance-ai-layout');
    expect(layout).toContain('grid-template-columns: 220px minmax(0, 1fr)');
    expect(layout).toMatch(/'chats main'/);
    expect(layout).toMatch(/'chats composer'/);
  });

  it('composer, chats e main ocupam suas áreas nomeadas', () => {
    expect(ruleBlock(css, '.finance-ai-composer')).toContain('grid-area: composer');
    expect(ruleBlock(css, '.finance-ai-chats')).toContain('grid-area: chats');
    expect(ruleBlock(css, '.finance-ai-main')).toContain('grid-area: main');
    // Sem rolagem horizontal nos blocos internos do desktop.
    expect(ruleBlock(css, '.finance-ai-composer')).toContain('min-width: 0');
    expect(ruleBlock(css, '.finance-ai-main')).toContain('min-width: 0');
  });

  it('mobile ≤820px: fluxo único composer → chats → main (sem colunas que gerem overflow)', () => {
    const tail = css.slice(css.indexOf('@media (max-width: 820px)'));
    const layout = ruleBlock(tail, '.finance-ai-layout');
    expect(layout).toContain('grid-template-columns: 1fr');
    const first = layout?.indexOf("'composer'") ?? -1;
    const second = layout?.indexOf("'chats'") ?? -1;
    const third = layout?.indexOf("'main'") ?? -1;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});

describe('PESSOAL-13C4A-E5 — envio e seleção de conversa continuam funcionando', () => {
  it('enviar pergunta pelo composer dispara askFinance e renderiza a resposta', async () => {
    vi.mocked(chatApi.createConversation).mockResolvedValue({ id: 'c-local' });
    render(<FinanceAiSection />);
    await screen.findByRole('group', { name: 'Sugestões de perguntas' });

    const input = screen.getByLabelText('Sua pergunta sobre as finanças') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Quanto gastei em junho?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(await screen.findByText('Resposta simulada.')).toBeTruthy();
    expect(askFinance).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Quanto gastei em junho?', conversationId: 'c-local' }),
    );
  });

  it('selecionar uma conversa do histórico carrega as mensagens dela', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c2', 'Conversa Dois', '2026-08-02T00:00:00.000Z'),
      conv('c1', 'Conversa Um', '2026-08-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockImplementation(async (id: string) =>
      id === 'c2'
        ? {
            messages: [msg({ key: 'a2', role: 'assistant', text: 'Resposta Dois', engine: 'deterministic' })],
            hasMore: false,
          }
        : {
            messages: [msg({ key: 'a1', role: 'assistant', text: 'Resposta Um', engine: 'deterministic' })],
            hasMore: false,
          },
    );

    render(<FinanceAiSection />);
    // A mais recente (c2) é auto-selecionada na hidratação.
    expect(await screen.findByText('Resposta Dois')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa: Conversa Um' }));
    expect(await screen.findByText('Resposta Um')).toBeTruthy();
    expect(screen.queryByText('Resposta Dois')).toBeNull();
  });
});

describe('PESSOAL-13C4A-E5 — mensagens antigas (F5/cache) e projection cards', () => {
  it('histórico persistido renderiza mensagens e cards de projeção no main', async () => {
    const projection = successBase();
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa', '2026-08-10T10:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u1', role: 'user', text: 'Qual a previsão?' }),
        msg({ key: 'a1', role: 'assistant', text: 'Resposta cache', projection, engine: 'deterministic' }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText('Qual a previsão?')).toBeTruthy();
    expect(screen.getByText('Resposta cache')).toBeTruthy();
    await screen.findByText('Base completa · 12/12 meses');
    expect(screen.getByText('Visão geral')).toBeTruthy();
    expect(screen.getByText('Média mensal histórica')).toBeTruthy();
    expect(container.querySelector('.finance-ai-projection')).toBeTruthy();
  });
});