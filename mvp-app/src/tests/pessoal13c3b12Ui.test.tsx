// @vitest-environment jsdom

// pessoal13c3b12Ui.test.tsx — PESSOAL-13C3B.12: restauração da aba ativa na
// sessão e timeline do chat sempre visível até a última mensagem.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FinanceAiSection } from '../components/FinanceAiSection';
import { readPersistedView } from '../components/AppShell';
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

const here = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
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
  sessionStorage.clear();
  vi.mocked(chatApi.listConversations).mockResolvedValue([
    { id: 'c1', title: 'Conversa Teste', lastMessageAt: '2026-04-10T10:00:00.000Z' } as ChatConversationItem,
  ]);
  vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], hasMore: false });
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C3B.12 — aba ativa persistida na sessão (readPersistedView)', () => {
  it('1. lê a view válida persistida do perfil', () => {
    sessionStorage.setItem('wf:active-view:pf-a', 'analises');
    expect(readPersistedView('pf-a')).toBe('analises');
  });

  it('2. isola por perfil (trocar de perfil nunca restaura aba incompatível)', () => {
    sessionStorage.setItem('wf:active-view:pf-a', 'analises');
    expect(readPersistedView('pf-b')).toBeNull();
  });

  it('3. valor inválido ou ausente cai em null (App usa o default inicio)', () => {
    sessionStorage.setItem('wf:active-view:pf-a', 'invasora');
    expect(readPersistedView('pf-a')).toBeNull();
    expect(readPersistedView('pf-c')).toBeNull();
  });
});

describe('PESSOAL-13C3B.12 — timeline do chat rola até a última mensagem', () => {
  it('4. hidratação posiciona no rodapé assim que as mensagens chegam (imediato)', async () => {
    let resolveMessages!: (v: { messages: UiMessage[]; hasMore: boolean }) => void;
    const gate: Promise<{ messages: UiMessage[]; hasMore: boolean }> = new Promise((r) => {
      resolveMessages = r;
    });
    vi.mocked(chatApi.listMessages).mockReturnValue(gate);

    const { container } = render(<FinanceAiSection />);
    // A hidratação abriu a conversa e está aguardando a leitura (intenção de
    // scroll 'immediate' será registrada quando a leitura resolver e o layout
    // effect ainda não rodou com as mensagens).
    const el = container.querySelector('.finance-ai-messages') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 900 });

    resolveMessages({
      messages: [
        msg({ key: 'u1', role: 'user', text: 'Onde estou gastando mais?' }),
        msg({ key: 'a1', role: 'assistant', text: 'Análise inicial', engine: 'deterministic' }),
      ],
      hasMore: false,
    });

    expect(await screen.findByText('Análise inicial')).toBeDefined();
    expect(el.scrollTop).toBe(900);
  });

  it('5. trocar de conversa rola imediatamente até o fundo', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      { id: 'c2', title: 'Conversa 2', lastMessageAt: '2026-04-11T10:00:00.000Z' },
      { id: 'c1', title: 'Conversa 1', lastMessageAt: '2026-04-10T10:00:00.000Z' },
    ] as ChatConversationItem[]);
    vi.mocked(chatApi.listMessages).mockImplementation(async (id: string) =>
      id === 'c2'
        ? {
            messages: [
              msg({ key: 'u2', role: 'user', text: 'Q2' }),
              msg({ key: 'a2', role: 'assistant', text: 'R2', engine: 'deterministic' }),
            ],
            hasMore: false,
          }
        : {
            messages: [
              msg({ key: 'u1', role: 'user', text: 'Q1' }),
              msg({ key: 'a1', role: 'assistant', text: 'R1', engine: 'deterministic' }),
            ],
            hasMore: false,
          },
    );

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('R2')).toBeDefined();
    const el = container.querySelector('.finance-ai-messages') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1500 });

    fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa: Conversa 1' }));
    expect(await screen.findByText('R1')).toBeDefined();
    expect(el.scrollTop).toBe(1500);
  });

  it('6. ao enviar, a timeline rola até o fundo após a resposta (sem matchMedia, cai no imediato)', async () => {
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u0', role: 'user', text: 'Pergunta inicial' }),
        msg({ key: 'a0', role: 'assistant', text: 'Resposta inicial', engine: 'deterministic' }),
      ],
      hasMore: false,
    });
    vi.mocked(askFinance).mockResolvedValue({
      question: 'Só em aluguel?',
      answer: 'Resposta final',
      messageTime: new Date().toISOString(),
      engine: 'deterministic',
    } as never);

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('Resposta inicial')).toBeDefined();
    const el = container.querySelector('.finance-ai-messages') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1400 });

    fireEvent.change(screen.getByLabelText('Sua pergunta sobre as finanças'), {
      target: { value: 'Só em aluguel?' },
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    expect(await screen.findByText('Resposta final')).toBeDefined();
    expect(el.scrollTop).toBe(1400);
  });

  it('7. carregar mensagens anteriores preserva a posição (sem scroll forçado)', async () => {
    const page0 = [
      msg({ key: 'u0', role: 'user', text: 'Q0' }),
      msg({ key: 'a0', role: 'assistant', text: 'R0', engine: 'deterministic' }),
    ];
    const page1 = [
      msg({ key: 'u-1', role: 'user', text: 'Q-1' }),
      msg({ key: 'a-1', role: 'assistant', text: 'R-1', engine: 'deterministic' }),
    ];
    vi.mocked(chatApi.listMessages)
      .mockResolvedValueOnce({ messages: page0, hasMore: true })
      .mockResolvedValue({ messages: page1, hasMore: false });

    const { container } = render(<FinanceAiSection />);
    expect(await screen.findByText('R0')).toBeDefined();
    const el = container.querySelector('.finance-ai-messages') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1200 });

    fireEvent.click(screen.getByRole('button', { name: 'Ver mensagens anteriores' }));
    expect(await screen.findByText('R-1')).toBeDefined();
    expect(el.scrollTop).toBe(0);
  });
});

describe('PESSOAL-13C3B.12 — wiring da persistência e scroll (fonte)', () => {
  it('8. AppShell/App conectam readPersistedView; FinanceAiSection mantém privacidade', () => {
    const shell = readSource('components/AppShell.tsx');
    expect(shell).toContain("import { useEffect, useState } from 'react';");
    expect(shell).toContain('export function readPersistedView');
    expect(shell).toContain('sessionStorage.setItem');
    expect(shell).toContain('const [view, setView] = useState<ViewId>(initialView)');
    expect(shell).toContain('onClick={() => setView(item.id)}');

    const app = readSource('App.tsx');
    expect(app).toContain('readPersistedView');
    expect(app).toContain("initialView={readPersistedView(profileId) ?? 'inicio'}");

    const sectionRaw = readSource('components/FinanceAiSection.tsx');
    const section = sectionRaw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(sectionRaw).toContain('messagesRef');
    expect(section).not.toContain('profile_id');
    expect(section).not.toContain('profileId');
  });
});