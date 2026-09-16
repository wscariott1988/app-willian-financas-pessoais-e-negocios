// @vitest-environment jsdom

// pessoal13c2b8Truncation.test.tsx — PESSOAL-13C2B.8: título da conversa
// cortado na barra lateral do chat.
//
// O conteúdo persistido ("Quanto gastei em supermercado em abril de 2026?") é
// salvo por completo; o defeito era 100% visual: o button global do app usa
// display:inline-flex + justify-content:center, e .finance-ai-chat-open não
// anulava isso. Texto longo centralizado dentro do botão é recortado
// simetricamente pelos dois lados → o usuário via o MEIO ("tei em supermercado
// em ab") em vez do começo.
//
// Estes testes provam:
//   a. o título completo permanece no DOM (texto, aria-label e title);
//   b. o botão usa a classe de truncamento que mostra o INÍCIO e corta só o
//      final (display block, text-align left, nowrap, overflow hidden, ellipsis,
//      min-width 0) e a lixeira é independente (flex-shrink: 0);
//   c. título curto não é alterado;
//   d. fallback "Sem título" permanece visível e acessível;
//   e. selecionar a conversa continua funcionando (is-active + listMessages);
//   f. excluir continua funcionando (confirmação → deleteConversation → some da
//      lista).
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const LONG_TITLE = 'Quanto gastei em supermercado em abril de 2026?';

const conv = (id: string, title: string, lastMessageAt: string): ChatConversationItem => ({
  id,
  title,
  lastMessageAt,
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
  vi.mocked(askFinance).mockResolvedValue({
    answer: 'Resposta simulada.',
    period: null,
    toolsUsed: [] as string[],
    engine: 'deterministic' as const,
    periodAnalyzed: null,
    evidence: [] as Array<{ label: string; value: string }>,
  });
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C2B.8 — título completo preservado e truncamento no final', () => {
  it('a. título longo permanece completo no DOM (texto, aria-label e title)', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', LONG_TITLE, '2026-04-10T00:00:00.000Z'),
    ]);
    render(<FinanceAiSection />);
    const open = await screen.findByRole('button', { name: `Abrir conversa: ${LONG_TITLE}` });
    // O texto real do botão não é alterado pela persistência — só a CLASSE trunca.
    expect(open.textContent).toBe(LONG_TITLE);
    expect(open.getAttribute('aria-label')).toBe(`Abrir conversa: ${LONG_TITLE}`);
    expect(open.getAttribute('title')).toBe(LONG_TITLE);
    // A linha usa (e mantém) a classe de truncamento, nunca um corte de string.
    expect(open.className).toContain('finance-ai-chat-open');
  });

  it('b. CSS: botão do título mostra o INÍCIO com reticências no fim; lixeira independente', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
    const cssBlock = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      let depth = 0;
      for (let i = start; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) return css.slice(start, i + 1);
        }
      }
      throw new Error(`Bloco CSS não encontrado: ${selector}`);
    };
    const openBlock = cssBlock('.finance-ai-chat-open');
    expect(openBlock).toMatch(/display:\s*block/); // anula o button{inline-flex; center} global
    expect(openBlock).toMatch(/flex:\s*1/);
    expect(openBlock).toMatch(/min-width:\s*0/);
    expect(openBlock).toMatch(/text-align:\s*left/);
    expect(openBlock).toMatch(/white-space:\s*nowrap/);
    expect(openBlock).toMatch(/overflow:\s*hidden/);
    expect(openBlock).toMatch(/text-overflow:\s*ellipsis/);

    // Linha da conversa é flexbox (título + lixeira lado a lado, sem sobreposição).
    expect(cssBlock('.finance-ai-chat-item')).toMatch(/display:\s*flex/);

    // A lixeira é um item separado, com flex-shrink: 0 (nunca esmagada pelo título).
    expect(cssBlock('.finance-ai-chat-delete')).toMatch(/flex-shrink:\s*0/);
  });

  it('c. título curto não é alterado', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', 'Nova', '2026-04-10T00:00:00.000Z'),
    ]);
    render(<FinanceAiSection />);
    const open = await screen.findByRole('button', { name: 'Abrir conversa: Nova' });
    expect(open.textContent).toBe('Nova');
    expect(open.getAttribute('title')).toBe('Nova');
  });

  it('d. fallback "Sem título" permanece visível e acessível', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', '', '2026-04-10T00:00:00.000Z'),
    ]);
    render(<FinanceAiSection />);
    const open = await screen.findByRole('button', { name: 'Abrir conversa: Sem título' });
    expect(open.textContent).toBe('Sem título');
    expect(open.getAttribute('title')).toBe('Sem título');
    expect(screen.getByRole('button', { name: 'Excluir conversa: Sem título' })).toBeTruthy();
  });

  it('e. selecionar a conversa continua funcionando (is-active + listMessages)', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', LONG_TITLE, '2026-04-10T00:00:00.000Z'),
      conv('c2', 'Antiga', '2026-03-01T00:00:00.000Z'),
    ]);
    const { container } = render(<FinanceAiSection />);
    await waitFor(() => expect(chatApi.listMessages).toHaveBeenCalled());
    // Auto-seleção hidrata a mais recente.
    expect(container.querySelector('.finance-ai-chat-open.is-active')?.textContent).toBe(
      LONG_TITLE,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa: Antiga' }));
    await waitFor(() =>
      expect(chatApi.listMessages).toHaveBeenCalledWith('c2', 0, undefined),
    );
    expect(container.querySelector('.finance-ai-chat-open.is-active')?.textContent).toBe(
      'Antiga',
    );
  });

  it('f. excluir continua funcionando (lixeira separada → confirmação → some da lista)', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      conv('c1', LONG_TITLE, '2026-04-10T00:00:00.000Z'),
      conv('c2', 'Antiga', '2026-03-01T00:00:00.000Z'),
    ]);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    const { container } = render(<FinanceAiSection />);
    await screen.findByRole('button', { name: 'Abrir conversa: Antiga' });

    const trash = screen.getByRole('button', { name: `Excluir conversa: Antiga` });
    fireEvent.click(trash);
    // Entra no estado de confirmação; a lixeira continua sendo um botão acessível.
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão da conversa' }));
    await waitFor(() => expect(chatApi.deleteConversation).toHaveBeenCalledWith('c2'));
    await waitFor(() =>
      expect(container.querySelectorAll('.finance-ai-chat-item')).toHaveLength(1),
    );
    expect(container.textContent).not.toContain('Antiga');
    expect(container.textContent).toContain(LONG_TITLE);
  });

  it('a2. título completo permanece no atributo acessível mesmo com botão truncado pela classe', async () => {
    // Garante que nenhuma lógica de corte de string foi introduzida: se o título
    // voltar encurtado no futuro, nem mesmo o aria-label salva a acessibilidade.
    const css = readFileSync(join(process.cwd(), 'src', 'components', 'FinanceAiSection.tsx'), 'utf8');
    expect(css).toContain(`aria-label={\`Abrir conversa: \${c.title || 'Sem título'}\`}`);
    expect(css).toContain(`title={c.title || 'Sem título'}`);
    expect(css).toContain(`{c.title || 'Sem título'}`);
  });
});