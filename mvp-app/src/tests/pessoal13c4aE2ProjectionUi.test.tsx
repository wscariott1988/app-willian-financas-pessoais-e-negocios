// @vitest-environment jsdom

// pessoal13c4aE2ProjectionUi.test.tsx — PESSOAL-13C4A-E2: cards de projeção
// no navegador, renderizados EXCLUSIVAMENTE a partir do ProjectionPayloadV1
// (o cliente só formata; não recalcula média, desvio, fechamento ou
// anualização). Badge, cards gerais/por categoria/remaining, insufficient sem
// projeções, payload ausente/legado, hidratação/F5/cache, acessibilidade e
// ausência de rolagem horizontal.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FinanceAiSection } from '../components/FinanceAiSection';
import type { ChatConversationItem, UiMessage } from '../lib/chatState';
import { askFinance } from '../lib/financeAiClient';
import type {
  ProjectionPayloadCategoryV1,
  ProjectionPayloadInsufficientV1,
  ProjectionPayloadSuccessV1,
  ProjectionPayloadV1,
} from '../../server/finance-ai/projectionPayloadV1';
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

const brl = (cents: number) =>
  (cents / 100)
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    .replace(/\s+/g, ' ');

const COVERAGE_FULL = {
  windowMonths: 12,
  coveredMonths: 12,
  minimumCoverageMonths: 6,
  requiredFullCoverageMonths: 12,
  windowStart: '2025-08',
  windowEnd: '2026-07',
};

function success(over: Partial<ProjectionPayloadSuccessV1> = {}): ProjectionPayloadSuccessV1 {
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
      deviationCents: 5000,
      referenceBasis: 'expected_to_date',
      referenceCents: 19355,
      realizedCents: 50000,
      expectedToDateCents: 19355,
      futureRegisteredCents: 30000,
      committedCents: 80000,
      closingProjectionCents: 155000,
    },
    categories: [],
    ...over,
  };
}

function cat(label: string, over: Partial<ProjectionPayloadCategoryV1> = {}): ProjectionPayloadCategoryV1 {
  return {
    label,
    monthlyMeanCents: 10000,
    annualScenarioCents: 120000,
    realizedCents: 9000,
    referenceBasis: 'expected_to_date',
    mode: 'variable_pace',
    referenceCents: 10000,
    deviationCents: -1000,
    deviation: 'below',
    ...over,
  };
}

function insufficient(): ProjectionPayloadInsufficientV1 {
  return {
    version: 1,
    status: 'insufficient',
    intent: 'projection_base',
    quality: 'insufficient',
    reference: { month: '2026-08', kind: 'current' },
    coverage: { ...COVERAGE_FULL, coveredMonths: 1 },
    realizedCents: 0,
    reason: { code: 'covered_months_below_minimum', coveredMonths: 1, minimumCoveredMonths: 6 },
  };
}

const msg = (over: Partial<UiMessage> & { key: string; role: 'user' | 'assistant' }): UiMessage => ({
  text: '',
  status: over.role === 'assistant' ? 'completed' : 'sent',
  optimistic: false,
  clientRequestId: null,
  createdAt: '2026-08-10T10:00:00.000Z',
  error: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatApi.listConversations).mockResolvedValue([
    { id: 'c1', title: 'Conversa Teste', lastMessageAt: '2026-08-10T10:00:00.000Z' } as ChatConversationItem,
  ]);
  vi.mocked(chatApi.listMessages).mockResolvedValue({ messages: [], hasMore: false });
});

afterEach(() => {
  cleanup();
});

describe('PESSOAL-13C4A-E2 — cards gerais por intent (somente valores do payload)', () => {
  it('full/base: badge completa + card Visão geral (média mensal e anualizado)', async () => {
    const projection = success({ intent: 'projection_base' });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u1', role: 'user', text: 'Qual a previsão?' }),
        msg({ key: 'a1', role: 'assistant', text: 'Resposta base', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Base completa · 12/12 meses')).toBeDefined();
    expect(screen.getByText('Visão geral')).toBeDefined();
    expect(screen.getByText('Média mensal histórica')).toBeDefined();
    expect(screen.getByText(brl(100000))).toBeDefined();
    expect(screen.getByText('Cenário se a média se repetir por 12 meses')).toBeDefined();
    expect(screen.getByText(brl(1200000))).toBeDefined();
    expect(screen.queryByText('Mês atual')).toBeNull();
    expect(screen.queryByText('Mês analisado')).toBeNull();
  });

  it('preliminary: badge "Base preliminar · 7/12 meses"', async () => {
    const projection = success({
      intent: 'projection_base',
      quality: 'preliminary',
      coverage: { ...COVERAGE_FULL, coveredMonths: 7 },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta preliminar', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Base preliminar · 7/12 meses')).toBeDefined();
  });

  it('current com fechamento: card Mês atual com as cinco linhas do payload', async () => {
    const projection = success({ intent: 'projection_current_month' });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta mês atual', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Mês atual')).toBeDefined();
    expect(screen.getByText('Realizado até hoje')).toBeDefined();
    expect(screen.getByText(brl(50000))).toBeDefined();
    expect(screen.getByText('Esperado até hoje')).toBeDefined();
    expect(screen.getByText(brl(19355))).toBeDefined();
    expect(screen.getByText('Futuros registrados')).toBeDefined();
    expect(screen.getByText(brl(30000))).toBeDefined();
    expect(screen.getByText('Comprometido')).toBeDefined();
    expect(screen.getByText(brl(80000))).toBeDefined();
    expect(screen.getByText('Fechamento estimado')).toBeDefined();
    expect(screen.getByText(brl(155000))).toBeDefined();
    expect(screen.queryByText('Visão geral')).toBeNull();
  });

  it('current antes do dia 7: fechamento null → "Disponível a partir do 7º dia"', async () => {
    const projection = success({
      intent: 'projection_current_month',
      comparison: {
        deviation: 'above',
        deviationCents: 30645,
        referenceBasis: 'expected_to_date',
        referenceCents: 19355,
        realizedCents: 50000,
        expectedToDateCents: 19355,
        futureRegisteredCents: 30000,
        committedCents: 80000,
        closingProjectionCents: null,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta dia 6', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Disponível a partir do 7º dia')).toBeDefined();
  });

  it('zero legítimo: fechamento 0 mostra "R$ 0,00" (e nunca o aviso do 7º dia)', async () => {
    const projection = success({
      intent: 'projection_current_month',
      comparison: {
        deviation: 'equal',
        deviationCents: 0,
        referenceBasis: 'expected_to_date',
        referenceCents: 0,
        realizedCents: 0,
        expectedToDateCents: 0,
        futureRegisteredCents: 0,
        committedCents: 0,
        closingProjectionCents: 0,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta zero', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Mês atual')).toBeDefined();
    expect(screen.getAllByText(brl(0)).length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText('Disponível a partir do 7º dia')).toBeNull();
  });

  it.each([
    {
      name: 'acima',
      deviation: 'above' as const,
      deviationCents: 50000,
      realizedCents: 150000,
      dir: 'acima da referência',
      money: 150000,
    },
    {
      name: 'abaixo',
      deviation: 'below' as const,
      deviationCents: -50000,
      realizedCents: 50000,
      dir: 'abaixo da referência',
    },
    {
      name: 'igual',
      deviation: 'equal' as const,
      deviationCents: 0,
      realizedCents: 100000,
      dir: 'igual à referência',
      money: 100000,
    },
  ])('past $name: Mês analisado com direção neutra ($dir), sem bom/ruim', async ({ deviation, deviationCents, realizedCents, dir, money }) => {
    const projection = success({
      intent: 'projection_month_comparison',
      reference: { month: '2026-07', kind: 'past' },
      comparison: {
        deviation,
        deviationCents,
        referenceBasis: 'monthly_mean',
        referenceCents: 100000,
        realizedCents,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta passado', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Mês analisado · julho de 2026')).toBeDefined();
    expect(screen.getByText('Realizado')).toBeDefined();
    expect(screen.getByText('Média histórica')).toBeDefined();
    expect(screen.getByText('Diferença')).toBeDefined();
    expect(screen.getByText(dir)).toBeDefined();
    if (money !== undefined) {
      expect(screen.getAllByText(brl(money)).length).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([
    { month: '2025-03', title: 'Mês analisado · março de 2025' },
    { month: '2024-11', title: 'Mês analisado · novembro de 2024' },
  ])('mês histórico distante ($month): "$title" (não apenas o imediatamente anterior)', async ({ month, title }) => {
    const projection = success({
      intent: 'projection_month_comparison',
      reference: { month, kind: 'past' },
      comparison: {
        deviation: 'equal',
        deviationCents: 0,
        referenceBasis: 'monthly_mean',
        referenceCents: 100000,
        realizedCents: 100000,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta mês distante', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText(title)).toBeDefined();
    expect(screen.queryByText('Mês atual')).toBeNull();
    expect(screen.queryByText('Mês passado')).toBeNull();
  });
});

describe('PESSOAL-13C4A-E2 — categorias, remaining e insufficient', () => {
  it('oito categorias + remaining: card por categoria (apenas categorias) e "Outras N categorias"', async () => {
    const categories = Array.from({ length: 8 }, (_, i) => cat(`Categoria ${i + 1}`));
    const projection = success({
      intent: 'projection_categories',
      categories,
      remaining: {
        categoriesCount: 4,
        monthlyMeanCents: 40000,
        annualScenarioCents: 480000,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta categorias', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText('Categoria 1')).toBeDefined();
    expect(screen.getByText('Categoria 8')).toBeDefined();
    expect(screen.getAllByText('Referência até hoje (média proporcional)').length).toBe(8);
    expect(screen.getAllByText('Realizado até hoje').length).toBe(8);
    expect(screen.getAllByText('Média mensal histórica').length).toBe(9);
    expect(screen.getAllByText('Cenário se a média se repetir por 12 meses').length).toBe(9);
    expect(screen.getByText('Outras 4 categorias')).toBeDefined();
    expect(screen.getByText(brl(40000))).toBeDefined();
    expect(screen.getByText(brl(480000))).toBeDefined();
    expect(screen.queryByText('Visão geral')).toBeNull();
    expect(screen.queryByText('Mês atual')).toBeNull();
  });

  it('insufficient: apenas o estado, sem nenhum card projetado nem valor', async () => {
    const projection = insufficient();
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta insuficiente', projection }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText('Dados insuficientes · 1 mês · mínimo 6')).toBeDefined();
    const section = await screen.findByLabelText('Cards de projeção');
    expect(within(section).getByText('Dados insuficientes')).toBeDefined();
    expect(within(section).queryByText('Média mensal histórica')).toBeNull();
    expect(within(section).queryByText('Fechamento estimado')).toBeNull();
    expect(section.innerHTML).not.toMatch(/R\$/);
    expect(container.querySelector('.finance-ai-proj-category')).toBeNull();
  });

  it.each([
    { covered: 0, badge: 'Dados insuficientes · 0 meses · mínimo 6' },
    { covered: 1, badge: 'Dados insuficientes · 1 mês · mínimo 6' },
    { covered: 2, badge: 'Dados insuficientes · 2 meses · mínimo 6' },
  ])('pluralização do badge insuficiente: "$badge"', async ({ covered, badge }) => {
    const projection: ProjectionPayloadInsufficientV1 = {
      ...insufficient(),
      coverage: { ...COVERAGE_FULL, coveredMonths: covered },
      reason: { code: 'covered_months_below_minimum', coveredMonths: covered, minimumCoveredMonths: 6 },
    };
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta insuficiente', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText(badge)).toBeDefined();
  });
});

describe('PESSOAL-13C4A-E2 — payload ausente/legado e fontes (fresco/cache/F5/troca)', () => {
  it('mensagem sem projection: sem badge nem cards (legado idêntico)', async () => {
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'u1', role: 'user', text: 'Onde estou gastando mais?' }),
        msg({ key: 'a1', role: 'assistant', text: 'Resposta sem projeção', engine: 'deterministic' }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText('Resposta sem projeção')).toBeDefined();
    expect(container.querySelector('.finance-ai-projection')).toBeNull();
  });

  it('projeção legada fora do contrato v1: nenhum card renderizado', async () => {
    const legacy = {
      status: 'success',
      intent: 'projection_base',
      summary: { monthlyMeanCents: 100000 },
    } as unknown as ProjectionPayloadV1;
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta legada', projection: legacy }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);

    expect(await screen.findByText('Resposta legada')).toBeDefined();
    expect(container.querySelector('.finance-ai-projection')).toBeNull();
  });

  it('cache/F5: listMessages (persistido) renderiza os mesmos cards', async () => {
    const projection = success({ intent: 'projection_base' });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta cache', projection, engine: 'deterministic' }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    expect(await screen.findByText(brl(100000))).toBeDefined();
    expect(screen.getByText('Base completa · 12/12 meses')).toBeDefined();
  });

  it('troca de conversa: cada conversa renderiza os cards do seu próprio payload', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([
      { id: 'c1', title: 'Conv 1', lastMessageAt: '2026-08-10T10:00:00.000Z' },
      { id: 'c2', title: 'Conv 2', lastMessageAt: '2026-08-10T11:00:00.000Z' },
    ] as ChatConversationItem[]);
    const projA = success({
      intent: 'projection_base',
      summary: { monthlyMeanCents: 100000, annualScenarioCents: 1200000, totalBaseCents: 1200000 },
    });
    const projB = success({
      intent: 'projection_base',
      summary: { monthlyMeanCents: 200000, annualScenarioCents: 2400000, totalBaseCents: 2400000 },
    });
    vi.mocked(chatApi.listMessages).mockImplementation(async (id: string) =>
      id === 'c1'
        ? { messages: [msg({ key: 'a1', role: 'assistant', text: 'R1', projection: projA })], hasMore: false }
        : { messages: [msg({ key: 'a2', role: 'assistant', text: 'R2', projection: projB })], hasMore: false },
    );

    render(<FinanceAiSection />);

    expect(await screen.findByText(brl(100000))).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir conversa: Conv 2' }));
    expect(await screen.findByText(brl(200000))).toBeDefined();
    expect(screen.queryByText(brl(100000))).toBeNull();
  });

  it('resposta fresca: cards nascem da resposta otimista (askFinance.projection)', async () => {
    vi.mocked(chatApi.listConversations).mockResolvedValue([]);
    vi.mocked(chatApi.createConversation).mockResolvedValue({ id: 'c2' });
    vi.mocked(askFinance).mockResolvedValue({
      answer: 'Resposta fresca',
      engine: 'deterministic',
      period: null,
      toolsUsed: [],
      projection: success({ intent: 'projection_base' }),
    });

    render(<FinanceAiSection />);

    const input = screen.getByLabelText('Sua pergunta sobre as finanças') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Qual a previsão?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Perguntar' }));

    expect(await screen.findByText(brl(100000))).toBeDefined();
    expect(screen.getByText('Base completa · 12/12 meses')).toBeDefined();
  });
});

describe('PESSOAL-13C4A-E2 — acessibilidade, scroll e ausência de rolagem horizontal', () => {
  it('scroll ao final continua funcionando com cards de projeção', async () => {
    const projection = success({ intent: 'projection_base' });
    let resolveMessages!: (v: { messages: UiMessage[]; hasMore: boolean }) => void;
    const gate: Promise<{ messages: UiMessage[]; hasMore: boolean }> = new Promise((r) => {
      resolveMessages = r;
    });
    vi.mocked(chatApi.listMessages).mockReturnValue(gate);

    const { container } = render(<FinanceAiSection />);
    const el = container.querySelector('.finance-ai-messages') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1400 });

    resolveMessages({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta com cards', projection }),
      ],
      hasMore: false,
    });

    expect(await screen.findByText('Base completa · 12/12 meses')).toBeDefined();
    expect(el.scrollTop).toBe(1400);
  });

  it('sem rolagem horizontal: containers/cards com min-width 0, max-width 100% e quebra de palavra', () => {
    const projection = ruleBlock(css, '.finance-ai-projection');
    const list = ruleBlock(css, '.finance-ai-projection-list');
    const card = ruleBlock(css, '.finance-ai-proj-card');
    const badge = ruleBlock(css, '.finance-ai-projection-badge');

    expect(projection).toContain('min-width: 0');
    expect(projection).toContain('max-width: 100%');
    expect(list).toContain('min-width: 0');
    expect(list).toContain('max-width: 100%');
    expect(card).toContain('min-width: 0');
    expect(card).toContain('max-width: 100%');
    expect(card).toContain('box-sizing: border-box');
    expect(card).toContain('overflow-wrap: break-word');
    expect(badge).toContain('white-space: normal');
    expect(badge).toContain('overflow-wrap: break-word');
  });

  it('acessibilidade: seção rotulada, títulos e listas semânticos, SVGs decorativos ocultos', async () => {
    const projection = success({
      intent: 'projection_month_comparison',
      reference: { month: '2026-07', kind: 'past' },
      comparison: {
        deviation: 'above',
        deviationCents: 50000,
        referenceBasis: 'monthly_mean',
        referenceCents: 100000,
        realizedCents: 150000,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta a11y', projection }),
      ],
      hasMore: false,
    });

    const { container } = render(<FinanceAiSection />);

    const section = await screen.findByLabelText('Cards de projeção');
    expect(section.tagName).toBe('SECTION');
    const headings = section.querySelectorAll('h3');
    expect(headings.length).toBeGreaterThan(0);
    expect(headings[0]?.textContent).toBe('Mês analisado · julho de 2026');
    expect(section.querySelectorAll('ul').length).toBeGreaterThan(0);
    expect(section.querySelectorAll('li').length).toBeGreaterThan(0);
    expect(section.querySelectorAll('dt').length).toBeGreaterThan(0);
    expect(section.querySelectorAll('dd').length).toBeGreaterThan(0);
    const svgs = section.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of Array.from(svgs)) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.querySelector('.finance-ai-projection')?.textContent ?? '').not.toMatch(/svg/i);
  });

  it.each([
    { deviation: 'above', dir: 'acima da referência' },
    { deviation: 'below', dir: 'abaixo da referência' },
    { deviation: 'equal', dir: 'igual à referência' },
  ])('direção $dir: ícone decorativo (aria-hidden) + texto acessível', async ({ deviation, dir }) => {
    const projection = success({
      intent: 'projection_month_comparison',
      reference: { month: '2026-07', kind: 'past' },
      comparison: {
        deviation: deviation as ProjectionPayloadSuccessV1['comparison']['deviation'],
        deviationCents:
          deviation === 'above' ? 50000 : deviation === 'below' ? -50000 : 0,
        referenceBasis: 'monthly_mean',
        referenceCents: 100000,
        realizedCents:
          deviation === 'above' ? 150000 : deviation === 'below' ? 50000 : 100000,
      },
    });
    vi.mocked(chatApi.listMessages).mockResolvedValue({
      messages: [
        msg({ key: 'a1', role: 'assistant', text: 'Resposta direção', projection }),
      ],
      hasMore: false,
    });

    render(<FinanceAiSection />);

    const section = await screen.findByLabelText('Cards de projeção');
    expect(screen.getByText(dir)).toBeDefined();
    const pill = section.querySelector('.finance-ai-proj-dir');
    expect(pill?.textContent ?? '').toContain(dir);
    const svg = pill?.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBe('presentation');
  });
});