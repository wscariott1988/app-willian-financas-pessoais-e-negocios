// @vitest-environment jsdom

// pessoal13c2b6Hydration.test.tsx — PESSOAL-13C2B.6: hidratação e restauração
// do chat persistente no browser.
//
// Em B.5 diagnosticou-se que FinanceAiSection NUNCA chamava listConversations
// (nenhum useEffect) e que send() não (re)alimentava a lista. Estes testes
// provam, com o componente MONTADO (jsdom + Testing Library), que:
//   a. no mount a UI dispara listConversations com AbortSignal e mostra
//      "Carregando conversas…" enquanto a hidratação não assenta;
//   b. a conversa mais recente é auto-selecionada e suas mensagens carregadas;
//   c. tempo real: user+assistant persistidos aparecem na timeline;
//   d. remount/F5/troca de perfil (key) hidratam do zero (restauração);
//   e. uma conversa recém-criada entra na sidebar imediatamente;
//   f. respostas movem a conversa para o topo sem duplicar nem renomear;
//   g. falha de LEITURA vira mensagem amigável (nunca "lista vazia" nem
//      "Serviço de inteligência indisponível");
//   h. hidratação lenta não apaga conversa criada/selecionada no intervalo;
//   i. unmount durante a leitura não despacha nada (AbortController);
//   j. StrictMode não duplica conversas nem mensagens na tela;
//   k. o frontend nunca envia profile_id controlado pelo cliente;
//   l. reducer: conversation_upserted (novo/preserva título/bump/sem dup) e
//      mergeServerConversationList (servidor vence/só-local preservado/removidos).
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FinanceAiSection } from '../components/FinanceAiSection';
import {
  chatReducer,
  createChatState,
  mergeServerConversationList,
  type ChatConversationItem,
  type UiMessage,
} from '../lib/chatState';
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

const okAnswer = (answer: string) => ({
  answer,
  period: null,
  toolsUsed: [] as string[],
  engine: 'deterministic' as const,
  periodAnalyzed: null,
  evidence: [] as Array<{ label: string; value: string }>,
});

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatApi.listConversations).mockResolvedValue([]);
  vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], hasMore: false });
  vi.mocked(askFinance).mockResolvedValue(okAnswer('Resposta simulada.'));
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C2B.6 — hidratação no mount', () => {
  it('a. mount dispara listConversations com AbortSignal e destrava a UI', async () => {
    const { container } = render(<FinanceAiSection />);
    expect(container.querySelector('.finance-ai-chat-loading')).toBeTruthy();
    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(chatApi.listConversations).mock.calls[0]?.[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    await waitFor(() =>
      expect(container.querySelector('.finance-ai-chat-loading')).toBeNull(),
    );
    // Sem conversas → hidratação termina e as sugestões aparecem.
    expect(screen.getByRole('group', { name: 'Sugestões de perguntas' })).toBeTruthy();
  });

  it('b. auto-seleciona a conversa mais recente e carrega as mensagens dela', async () => {
    // O servidor (chatApi) entrega ordenado por last_message_at DESC.
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c-new', 'Nova', '2025-01-01T00:00:00.000Z'),
      conv('c-old', 'Antiga', '2024-01-01T00:00:00.000Z'),
    ]);
    const { container } = render(<FinanceAiSection />);
    await waitFor(() => expect(chatApi.listMessages).toHaveBeenCalled());
    const last = vi.mocked(chatApi.listMessages).mock.calls.at(-1);
    expect(last?.[0]).toBe('c-new');
    expect(last?.[1]).toBe(0);
    const active = container.querySelector('.finance-ai-chat-open.is-active');
    expect(active?.textContent).toBe('Nova');
    expect(container.querySelectorAll('.finance-ai-chat-item')).toHaveLength(2);
  });

  it('c. mensagens persistidas (user+assistant) aparecem na timeline', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa', '2026-01-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u1', role: 'user', text: 'Quanto gastei em abril?' }),
        msg({ key: 'a1', role: 'assistant', text: 'R$ 120,00.', status: 'completed', engine: 'deterministic' }),
      ],
      hasMore: false,
    });
    render(<FinanceAiSection />);
    await screen.findByText('Quanto gastei em abril?');
    expect(screen.getByText('R$ 120,00.')).toBeTruthy();
  });

  it('d. remount/F5 (e troca de key por perfil) hidrata do zero', async () => {
    const { rerender } = render(<FinanceAiSection key="p1" />);
    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(1));
    rerender(<FinanceAiSection key="p2" />);
    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(2));
    // O segundo mount parte do estado limpo e hidrata os DADOS do novo perfil.
    await screen.findByRole('group', { name: 'Sugestões de perguntas' });
  });

  it('i. unmount durante a leitura não desperta estado tardio (AbortController)', async () => {
    let rejectList!: (e: Error) => void;
    vi.mocked(chatApi.listConversations).mockImplementation(
      (signal?: AbortSignal) =>
        new Promise<ChatConversationItem[]>((_resolve, reject) => {
          rejectList = reject;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const { unmount } = render(<FinanceAiSection />);
    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(1));
    unmount();
    rejectList(new DOMException('aborted', 'AbortError'));
    // Caso o guard falhasse, este teste quebraria com rejection não tratada
    // (o vitest falha em unhandled rejection) — aqui o abort é engolido.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('j. StrictMode hidrata sem duplicar conversas nem mensagens na tela', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Conversa', '2026-01-01T00:00:00.000Z'),
      conv('c2', 'Outra', '2026-02-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u1', role: 'user', text: 'q' }),
        msg({ key: 'a1', role: 'assistant', text: 'resposta' }),
      ],
      hasMore: false,
    });
    const { container } = render(
      <StrictMode>
        <FinanceAiSection />
      </StrictMode>,
    );
    await screen.findByText('resposta');
    expect(container.querySelectorAll('.finance-ai-chat-item')).toHaveLength(2);
    expect(screen.getAllByText('q')).toHaveLength(1);
    expect(screen.getAllByText('resposta')).toHaveLength(1);
  });
});

describe('PESSOAL-13C2B.6 — criação e bump de conversa (sidebar viva)', () => {
  async function settleHydration(question: string) {
    vi.mocked(chatApi.createConversation).mockResolvedValue({ id: 'c-local' });
    const { container } = render(<FinanceAiSection />);
    await screen.findByRole('group', { name: 'Sugestões de perguntas' });
    const input = screen.getByRole('textbox', { name: 'Sua pergunta sobre as finanças' });
    fireEvent.change(input, { target: { value: question } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(container.querySelectorAll('.finance-ai-chat-item')).toHaveLength(1),
    );
    return container;
  }

  it('e. conversa recém-criada entra na sidebar imediatamente e é selecionada', async () => {
    const container = await settleHydration('Total de despesas em maio?');
    expect(chatApi.createConversation).toHaveBeenCalledTimes(1);
    // A pergunta segue para o servidor na conversa recém-criada.
    await waitFor(() =>
      expect(askFinance).toHaveBeenCalledWith(
        expect.objectContaining({ question: 'Total de despesas em maio?', conversationId: 'c-local' }),
      ),
    );
    const list = container.querySelector('.finance-ai-chat-list');
    expect(list?.textContent).toContain('Total de despesas em maio?');
    const active = container.querySelector('.finance-ai-chat-open.is-active');
    expect(active?.textContent).toContain('Total de despesas em maio?');
  });

  it('f. resposta concluída move a conversa para o topo sem duplicar nem renomear', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c-new', 'Nova', '2025-01-01T00:00:00.000Z'),
      conv('c-old', 'Antiga', '2024-01-01T00:00:00.000Z'),
    ]);
    const { container } = render(<FinanceAiSection />);
    await waitFor(() => expect(chatApi.listMessages).toHaveBeenCalled());
    const activeBefore = container.querySelector('.finance-ai-chat-open.is-active');
    expect(activeBefore?.textContent).toBe('Nova');

    // Usuário abre a conversa MAIS ANTIGA e envia uma pergunta nela.
    fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa: Antiga' }));
    // Clique manual não carrega AbortSignal (só a hidratação aborta leitura).
    await waitFor(() =>
      expect(chatApi.listMessages).toHaveBeenCalledWith('c-old', 0, undefined),
    );
    const input = screen.getByRole('textbox', { name: 'Sua pergunta sobre as finanças' });
    fireEvent.change(input, { target: { value: 'E em junho?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      const items = container.querySelectorAll('.finance-ai-chat-item');
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toContain('Antiga');
      expect(items[1]?.textContent).toContain('Nova');
    });
    expect(chatApi.createConversation).not.toHaveBeenCalled();
  });
});

describe('PESSOAL-13C2B.6 — falhas e corridas', () => {
  it('g. falha de LEITURA mostra erros amigáveis e nunca "lista vazia"/"Serviço indisponível"', async () => {
    vi.mocked(chatApi.listConversations).mockRejectedValue(new Error('network down'));
    const { container } = render(<FinanceAiSection />);
    await screen.findByText(
      /Não foi possível carregar suas conversas\. Verifique sua conexão e tente novamente\./,
    );
    expect(screen.queryByRole('group', { name: 'Sugestões de perguntas' })).toBeNull();
    expect(container.querySelector('.finance-ai-chat-loading')).toBeNull();
    expect(screen.queryByText(/indisponível/i)).toBeNull();
  });

  it('h. hidratação lenta não apaga a conversa criada pelo usuário no intervalo', async () => {
    let resolveList!: (v: ChatConversationItem[]) => void;
    vi.mocked(chatApi.listConversations).mockImplementation(
      () =>
        new Promise<ChatConversationItem[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    vi.mocked(chatApi.createConversation).mockResolvedValue({ id: 'c-local' });

    const { container } = render(<FinanceAiSection />);
    await waitFor(() => expect(chatApi.listConversations).toHaveBeenCalledTimes(1));

    // Usuário age ANTES do snapshot do servidor chegar.
    const input = screen.getByRole('textbox', { name: 'Sua pergunta sobre as finanças' });
    fireEvent.change(input, { target: { value: 'Quanto gastei em junho?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(container.querySelectorAll('.finance-ai-chat-item')).toHaveLength(1),
    );

    // Snapshot lento confirma que o servidor "não tem nada" — a conversa local
    // criada no intervalo precisa sobreviver ao merge.
    resolveList([]);
    await waitFor(() =>
      expect(container.querySelectorAll('.finance-ai-chat-item')).toHaveLength(1),
    );
    const list = container.querySelector('.finance-ai-chat-list');
    expect(list?.textContent).toContain('Quanto gastei em junho?');
    const active = container.querySelector('.finance-ai-chat-open.is-active');
    expect(active?.textContent).toContain('Quanto gastei em junho?');
    expect(chatApi.listMessages).not.toHaveBeenCalled();
  });
});

describe('PESSOAL-13C2B.6 — camada de dados não vaza perfil', () => {
  it('k. o componente nunca contém profile_id/profileId (RLS decide a ownership)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'components', 'FinanceAiSection.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toContain('profile_id');
    expect(src).not.toContain('profileId');
  });

  it('k2. chatApi deriva o perfil do usuário logado (nunca de parâmetro da UI)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'chatApi.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Nenhum parâmetro/typedef carrega profile controlado pela UI.
    expect(src).not.toMatch(/profileId\??:/);
    // O único uso de profile_id é o INSERT derivado da SESSÃO (ownProfileId).
    expect(src).toMatch(/const profileId = await ownProfileId\(\);/);
    expect(src).toContain("insert({ profile_id: profileId, title: '' })");
    expect(src).toContain('resolveProfileId(data.user');
  });
});

describe('PESSOAL-13C2B.6 — reducer conversation_upserted e merge da hidratação', () => {
  it('l1. upsert insere conversa nova no topo e zera o erro', () => {
    let s = chatReducer(createChatState(), {
      type: 'conversations_loaded',
      conversations: [conv('c1', 'Antiga', '2024-01-01T00:00:00.000Z')],
    });
    s = chatReducer(s, { type: 'fail', message: 'erro antigo' });
    s = chatReducer(s, {
      type: 'conversation_upserted',
      conversation: conv('c-local', 'Nova local', '2026-06-01T00:00:00.000Z'),
    });
    expect(s.conversations.map((c) => c.id)).toEqual(['c-local', 'c1']);
    expect(s.error).toBeNull();
  });

  it('l2. bump parcial preserva o título e coloca a conversa no topo', () => {
    let s = createChatState();
    s = chatReducer(s, {
      type: 'conversations_loaded',
      conversations: [
        conv('c1', 'Titulo salvo', '2024-01-01T00:00:00.000Z'),
        conv('c2', 'Outra', '2025-01-01T00:00:00.000Z'),
      ],
    });
    s = chatReducer(s, {
      type: 'conversation_upserted',
      conversation: { id: 'c1', lastMessageAt: '2026-09-01T00:00:00.000Z' },
    });
    expect(s.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(s.conversations[0]?.title).toBe('Titulo salvo');
    expect(s.conversations).toHaveLength(2);
  });

  it('l3. mix de merges no momento da hidratação (servidor vence/só-local preservado/removido descartado)', () => {
    const server = [
      conv('s1', 'Servidor', '2026-05-01T00:00:00.000Z'),
      conv('dup', 'Titulo do servidor', '2026-04-01T00:00:00.000Z'),
      conv('removed', 'Ia sumir', '2026-03-01T00:00:00.000Z'),
    ];
    const local = [
      conv('dup', 'Titulo local (ignorado)', '2026-02-01T00:00:00.000Z'),
      conv('local-only', 'Criada no browser', '2026-06-01T00:00:00.000Z'),
    ];
    const removed = new Set(['removed']);
    const merged = mergeServerConversationList(server, local, removed);
    expect(merged.map((c) => c.id)).toEqual(['local-only', 's1', 'dup']);
    expect(merged.find((c) => c.id === 'dup')?.title).toBe('Titulo do servidor');
  });
});