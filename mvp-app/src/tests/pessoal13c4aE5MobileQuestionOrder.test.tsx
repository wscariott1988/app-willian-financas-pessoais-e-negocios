// @vitest-environment jsdom

// pessoal13c4aE5MobileQuestionOrder.test.tsx — PESSOAL-13C4A-E5.2: no mobile o
// formulário de pergunta vem ANTES da conversa atual (perguntas, respostas,
// cards, loading/erro) e o histórico "+ Nova conversa" fica por ÚLTIMO. O
// histórico nunca fica entre o composer e as mensagens da conversa ativa — a
// partida de pergunta-resposta nunca é cortada. Sem duplicar o composer. No
// desktop o layout visual é preservado via grid-template-areas (chats | main
// com composer abaixo das mensagens).
//
// Provas:
//   a. em viewports mobile (375×667 e 390×844) a ordem DOM/acessível é
//      composer → conversa atual → histórico;
//   b. o campo e o botão de envio vêm antes da conversa atual e a última
//      resposta vem antes do histórico;
//   c. existe exatamente UMA instância do composer (sem duplicação);
//   d. o CSS desktop mantém as áreas/layout esperados (chats | main/composer);
//   e. o CSS mobile (≤820px) define o fluxo único composer → main → chats;
//   f. envio mantém pergunta e resposta na conversa ativa (antes do histórico);
//   g. o scroll ao enviar termina na última mensagem (.finance-ai-messages),
//      sem avançar até o histórico que vem abaixo;
//   h. "Nova conversa" continua funcionando dentro do painel de histórico;
//   i. seleção de conversa antiga continua funcionando;
//   j. mensagens antigas (cache/F5), cards de projeção e isolamento continuam
//      renderizando.
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

describe('PESSOAL-13C4A-E5.2 — mobile: composer → conversa atual → histórico (ordem DOM/acessível = visual)', () => {
  it.each([
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ])('$width×$height: composer → conversa atual → histórico, e a última resposta vem antes do histórico', async ({ width, height }) => {
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
    const main = container.querySelector('.finance-ai-main') as HTMLElement;
    const chats = container.querySelector('.finance-ai-chats') as HTMLElement;
    expect(composer).toBeTruthy();
    expect(main).toBeTruthy();
    expect(chats).toBeTruthy();

    // Ordem DOM/leitor/teclado: composer < conversa atual < histórico.
    expect(follows(composer, main)).toBe(true);
    expect(follows(main, chats)).toBe(true);

    // O campo e o botão de envio vêm antes da conversa atual; a última
    // resposta vem antes do histórico; "Nova conversa" mora no painel.
    const input = screen.getByLabelText('Sua pergunta sobre as finanças');
    const submit = screen.getByRole('button', { name: 'Perguntar' });
    const answer = container.querySelector('.finance-ai-msg.is-assistant') as HTMLElement;
    const newChat = screen.getByRole('button', { name: 'Nova conversa' });
    expect(follows(input, main)).toBe(true);
    expect(follows(submit, main)).toBe(true);
    expect(follows(main, newChat)).toBe(true);
    expect(follows(answer, chats)).toBe(true);
    expect(chats.contains(newChat)).toBe(true);
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

describe('PESSOAL-13C4A-E5.2 — desktop preserva as áreas e o layout', () => {
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

  it('mobile ≤820px: fluxo único composer → main → chats (sem colunas que gerem overflow)', () => {
    const tail = css.slice(css.indexOf('@media (max-width: 820px)'));
    const layout = ruleBlock(tail, '.finance-ai-layout');
    expect(layout).toContain('grid-template-columns: 1fr');
    const first = layout?.indexOf("'composer'") ?? -1;
    const second = layout?.indexOf("'main'") ?? -1;
    const third = layout?.indexOf("'chats'") ?? -1;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});

describe('PESSOAL-13C4A-E5.2 — envio, scroll e seleção continuam funcionando', () => {
  it('enviar pergunta pelo composer dispara askFinance e renderiza a resposta', async () => {
    vi.mocked(chatApi.createConversation).mockResolvedValue({ id: 'c-local' });
    const { container } = render(<FinanceAiSection />);
    await screen.findByRole('group', { name: 'Sugestões de perguntas' });

    const input = screen.getByLabelText('Sua pergunta sobre as finanças') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Quanto gastei em junho?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(await screen.findByText('Resposta simulada.')).toBeTruthy();
    expect(askFinance).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Quanto gastei em junho?', conversationId: 'c-local' }),
    );

    // A pergunta e a resposta entram na CONVERSA ATIVA (main), antes do
    // histórico — a dupla nunca fica separada pelo painel ao lado/abaixo.
    const composer = container.querySelector('.finance-ai-composer') as HTMLElement;
    const main = container.querySelector('.finance-ai-main') as HTMLElement;
    const chats = container.querySelector('.finance-ai-chats') as HTMLElement;
    const qBubble = container.querySelector('.finance-ai-msg.is-user .finance-ai-bubble') as HTMLElement;
    const a = screen.getByText('Resposta simulada.');
    expect(qBubble.textContent).toContain('Quanto gastei em junho?');
    expect(main.contains(qBubble)).toBe(true);
    expect(main.contains(a)).toBe(true);
    expect(follows(composer, qBubble)).toBe(true);
    expect(follows(a, chats)).toBe(true);
  });

  it('ao enviar, o scroll termina na última mensagem da conversa (não avança ao histórico)', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa A', '2026-08-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u0', role: 'user', text: 'Pergunta inicial' }),
        msg({ key: 'a0', role: 'assistant', text: 'Resposta inicial', engine: 'deterministic' }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Resposta inicial')).toBeTruthy();

    const messagesEl = container.querySelector('.finance-ai-messages') as HTMLElement;
    Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, get: () => 2100 });

    fireEvent.change(screen.getByLabelText('Sua pergunta sobre as finanças'), {
      target: { value: 'E em julho?' },
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    expect(await screen.findByText('Resposta simulada.')).toBeTruthy();
    // O alvo do scroll é o contêiner das mensagens (última mensagem)…
    expect(messagesEl.scrollTop).toBe(2100);
    // …que fica com limite próprio e ANTES do histórico na DOM: rolar até o
    // scrollHeight do contêiner termina na última resposta, nunca no histórico.
    const msgs = ruleBlock(css, '.finance-ai-messages');
    expect(msgs).toContain('overflow-y: auto');
    expect(msgs).toContain('max-height');
    const main = container.querySelector('.finance-ai-main') as HTMLElement;
    const chats = container.querySelector('.finance-ai-chats') as HTMLElement;
    expect(messagesEl.closest('.finance-ai-main')).toBe(main);
    expect(follows(main, chats)).toBe(true);
  });

  it('"Nova conversa" continua funcionando dentro do painel de histórico', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa A', '2026-08-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [msg({ key: 'a1', role: 'assistant', text: 'Resposta A', engine: 'deterministic' })],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Resposta A')).toBeTruthy();

    const newChat = screen.getByRole('button', { name: 'Nova conversa' });
    const chats = container.querySelector('.finance-ai-chats') as HTMLElement;
    expect(chats.contains(newChat)).toBe(true);

    fireEvent.click(newChat);
    // Abre uma conversa vazia (sugestões visíveis), sem mensagens antigas.
    expect(await screen.findByRole('group', { name: 'Sugestões de perguntas' })).toBeTruthy();
    expect(screen.queryByText('Resposta A')).toBeNull();
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

describe('PESSOAL-13C4A-E5.2 — mensagens antigas (F5/cache) e projection cards', () => {
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