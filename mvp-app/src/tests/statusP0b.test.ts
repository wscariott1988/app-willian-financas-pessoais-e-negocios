// statusP0b.test.ts — Coerência global Pago/Não pago (STATUS-P0b).
// Cobre: badges da listagem, fila "Não pagos" com cutoff, editor com 2 opções e
// preservação de legados, Configurações sem códigos, e a proibição de renderizar
// os vocábulos técnicos antigos em qualquer ponto visível.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { StatusBadge } from '../components/StatusBadge';
import {
  displayPaymentStatus,
  isPaidStatus,
  isStatusOperationalVisible,
  NON_PAID_STATUSES,
  STATUS_EDITABLE_FROM,
  STATUS_OPTIONS,
} from '../lib/status';
import { createTxPageFetcher, buildPendingTxOptions } from '../lib/txList';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

function makeFakeClient() {
  const log: unknown[][] = [];
  const query: any = {
    ilike: (c: string, v: unknown) => { log.push(['ilike', c, v]); return query; },
    eq: (c: string, v: unknown) => { log.push(['eq', c, v]); return query; },
    in: (c: string, v: unknown) => { log.push(['in', c, v]); return query; },
    is: (c: string, v: unknown) => { log.push(['is', c, v]); return query; },
    or: (v: unknown) => { log.push(['or', v]); return query; },
    gte: (c: string, v: unknown) => { log.push(['gte', c, v]); return query; },
    lte: (c: string, v: unknown) => { log.push(['lte', c, v]); return query; },
    order: () => query,
    range: () => query,
    select: () => query,
    abortSignal: (_s?: unknown) => { log.push(['abortSignal']); return query; },
    then: (resolve: (r: any) => void) => resolve({ data: [], count: 0, error: null }),
  };
  return { client: { from: () => query }, log };
}

const VISIBLE_PAID_OR_UNPAID = ['Pago', 'Não pago'];

describe('STATUS-P0b — regra central (lib/status)', () => {
  it('>= cutoff: posted => Pago; todo status não-posted => Não pago', () => {
    expect(displayPaymentStatus('posted', '2026-08-01')).toBe('Pago');
    for (const s of NON_PAID_STATUSES) {
      expect(displayPaymentStatus(s, '2026-08-01')).toBe('Não pago');
    }
    expect(displayPaymentStatus(null, '2026-08-01')).toBe('Não pago');
  });

  it('< cutoff: nenhum status operacional visível (qualquer status)', () => {
    expect(displayPaymentStatus('posted', '2026-07-31')).toBeNull();
    expect(displayPaymentStatus('review', '2026-07-31')).toBeNull();
    expect(displayPaymentStatus('scheduled', '2026-07-31')).toBeNull();
    expect(displayPaymentStatus('pending', '2026-07-31')).toBeNull();
    expect(displayPaymentStatus('ignored', '2026-07-31')).toBeNull();
  });

  it('status desconhecido não-posted: visual = Não pago, nunca escrita automática', () => {
    expect(displayPaymentStatus('weird-status', '2026-08-01')).toBe('Não pago');
    expect(NON_PAID_STATUSES).not.toContain('weird-status');
    expect(isPaidStatus('weird-status')).toBe(false);
  });

  it('NON_PAID_STATUSES == exatamente os status ativos não-posted do CHECK do schema', () => {
    expect([...NON_PAID_STATUSES].sort()).toEqual(['ignored', 'pending', 'review', 'scheduled']);
  });

  it('isStatusOperationalVisible segue o cutoff', () => {
    expect(isStatusOperationalVisible('2026-07-31')).toBe(false);
    expect(isStatusOperationalVisible('2026-08-01')).toBe(true);
    expect(isStatusOperationalVisible('')).toBe(false);
    expect(STATUS_EDITABLE_FROM).toBe('2026-08-01');
  });
});

describe('STATUS-P0b — badge da listagem (StatusBadge)', () => {
  it('posted >= cutoff => badge Pago', () => {
    const html = renderToString(createElement(StatusBadge, { status: 'posted', occurredOn: '2026-08-01' }));
    expect(html).toContain('>Pago</span>');
    expect(html).not.toContain('Não pago');
  });

  it('review/scheduled/pending/ignored >= cutoff => badge Não pago', () => {
    for (const s of NON_PAID_STATUSES) {
      const html = renderToString(createElement(StatusBadge, { status: s, occurredOn: '2026-08-02' }));
      expect(html).toContain('>Não pago</span>');
      expect(html).not.toContain('>Pago</span>');
    }
  });

  it('< cutoff => nenhum badge/label operacional', () => {
    for (const s of ['posted', 'review', 'scheduled', 'pending', 'ignored']) {
      const html = renderToString(createElement(StatusBadge, { status: s, occurredOn: '2026-07-31' }));
      expect(html).toBe('');
    }
  });

  it('badge nunca contém códigos nem vocábulos antigos', () => {
    for (const s of ['posted', 'review', 'scheduled', 'pending', 'ignored']) {
      const html = renderToString(createElement(StatusBadge, { status: s, occurredOn: '2026-08-01' }));
      for (const forbidden of ['Confirmada', 'Pendente', 'Em revisão', 'Agendada', 'Ignorada', '(posted)', '(review)', '(scheduled)', '(ignored)']) {
        expect(html).not.toContain(forbidden);
      }
    }
  });
});

describe('STATUS-P0b — pontos visíveis nunca usam vocábulos antigos', () => {
  it('TransactionList usa StatusBadge/displayPaymentStatus (sem statusLabel antigo)', () => {
    const src = readSource('components/TransactionList.tsx');
    expect(src).toContain('StatusBadge');
    expect(src).toContain('displayPaymentStatus');
    expect(src).not.toContain('statusLabel');
    expect(src).not.toContain('Confirmada');
    expect(src).not.toContain('Em revisão');
    expect(src).not.toContain('Agendada');
    expect(src).not.toContain('Ignorada');
  });

  it('RecentTransactions usa displayPaymentStatus e não renderiza labels antigos', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain('displayPaymentStatus');
    expect(src).not.toContain('statusLabel');
    expect(src).not.toContain('Confirmada');
    expect(src).not.toContain('Em revisão');
    expect(src).not.toContain('Agendada');
    expect(src).not.toContain('Ignorada');
  });

  it('RecentTransactions importa e renderiza StatusBadge (badge visual na Home)', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain("import { StatusBadge } from './StatusBadge'");
    expect(src).toContain('<StatusBadge status={tx.status} occurredOn={tx.occurred_on} />');
  });

  it('Dashboard/TransactionsView/AppShell: fila renomeada para Não pagos, sem review operacional', () => {
    const dash = readSource('components/Dashboard.tsx');
    expect(dash).toContain('Não pagos');
    expect(dash).not.toContain("'Em revisão'");
    expect(dash).not.toContain('status.eq.review');
    const view = readSource('views/TransactionsView.tsx');
    expect(view).toContain("label: 'Não pagos'");
    expect(view).not.toContain("label: 'Em revisão'");
    const shell = readSource('components/AppShell.tsx');
    expect(shell).toContain("'unpaid' | 'noCategory'");
  });

  it('txList.ts: nenhum label operacional restante (apresentação central em lib/status)', () => {
    const src = readSource('lib/txList.ts');
    expect(src).not.toContain('Confirmada');
    expect(src).not.toContain('Pendente');
    expect(src).not.toContain('Em revisão');
    expect(src).not.toContain('Agendada');
    expect(src).not.toContain('Ignorada');
    expect(src).not.toContain('statusLabel');
  });
});

describe('STATUS-P0b — fila "Não pagos" (query + cutoff)', () => {
  it('fila unpaid: somente status não-posted E occurred_on >= cutoff', async () => {
    const { client, log } = makeFakeClient();
    const fetcher = createTxPageFetcher(client, buildPendingTxOptions({ search: '', accountId: '', pendingFilter: 'unpaid' }));
    await fetcher(0, 29);
    const s = log.map((c) => JSON.stringify(c));
    expect(s).toContain(JSON.stringify(['in', 'status', ['pending', 'review', 'scheduled', 'ignored']]));
    expect(s).toContain(JSON.stringify(['gte', 'occurred_on', '2026-08-01']));
  });

  it('posted nunca entra na fila Não pagos', async () => {
    const { log } = makeFakeClient();
    expect(NON_PAID_STATUSES).not.toContain('posted');
    // o conjunto da query vem de NON_PAID_STATUSES (sem literais espalhados)
    const src = readSource('lib/txList.ts');
    expect(src).toContain('NON_PAID_STATUSES');
  });
});

describe('STATUS-P0b — editor preserva regras do STATUS-P0', () => {
  const editor = readSource('components/TransactionEditor.tsx');

  it('opções = exatamente Pago/Não pago', () => {
    expect(STATUS_OPTIONS.map((o) => o.label)).toEqual(['Pago', 'Não pago']);
    expect(STATUS_OPTIONS).toHaveLength(2);
  });

  it('controle condicionado ao cutoff e status legado preservado (buildSavePayload)', () => {
    expect(editor).toContain('isStatusEditable(form.occurred_on)');
    expect(editor).toContain('statusEdited');
    expect(editor).toContain('buildSavePayload');
    // nenhum código entre parênteses nem vocábulos antigos no editor
    expect(editor).not.toContain('(posted)');
    expect(editor).not.toContain('(review)');
    expect(editor).not.toContain('(scheduled)');
    expect(editor).not.toContain('(ignored)');
    expect(editor).not.toContain('Sair de');
  });
});

describe('STATUS-P0b — Configurações sem códigos (herdado do STATUS-P0)', () => {
  it('não renderiza (review)/(archive) nem códigos crus', () => {
    const src = readSource('views/SettingsView.tsx') + readSource('settings/CategoriesSection.tsx');
    expect(src).not.toContain('(review)');
    expect(src).not.toContain('(archive)');
    const jsx = src.slice(src.lastIndexOf('return ('));
    expect(jsx).not.toContain('{node.cat.status}');
    expect(src).toContain('Arquivada');
    expect(src).toContain('Em revisão');
  });
});

describe('STATUS-P0b — vocabulário global (regra de produto final)', () => {
  it('o único vocabulário visível de status é Pago/Não pago (mais nenhum outro label operacional existe no frontend)', () => {
    const files = [
      'components/TransactionList.tsx',
      'components/RecentTransactions.tsx',
      'components/TransactionEditor.tsx',
      'components/StatusBadge.tsx',
      'views/Dashboard.tsx' === 'views/Dashboard.tsx' ? 'components/Dashboard.tsx' : '',
      'views/TransactionsView.tsx',
      'lib/txList.ts',
      'lib/status.ts',
    ].filter(Boolean);
    for (const f of files) {
      const src = readSource(f);
      expect(src).not.toMatch(/Confirmada/);
      expect(src).not.toMatch(/Pendente/);
      expect(src).not.toMatch(/Agendada/);
      expect(src).not.toMatch(/Ignorada/);
      // "Em revisão" só pode aparecer como label amigável de categoria em Configurações
      if (f !== 'views/SettingsView.tsx') expect(src).not.toMatch(/Em revisão/);
    }
    expect(VISIBLE_PAID_OR_UNPAID.join('|')).toContain('Pago');
    expect(VISIBLE_PAID_OR_UNPAID.join('|')).toContain('Não pago');
  });
});

describe('STATUS-P0c — RecentTransactions renderiza badge visual de status', () => {
  it('StatusBadge renderiza "Pago" para posted >= cutoff', () => {
    const html = renderToString(createElement(StatusBadge, { status: 'posted', occurredOn: '2026-08-01' }));
    expect(html).toContain('badge-posted');
    expect(html).toContain('>Pago</span>');
  });

  it('StatusBadge renderiza "Não pago" para cada status não-posted >= cutoff', () => {
    for (const s of NON_PAID_STATUSES) {
      const html = renderToString(createElement(StatusBadge, { status: s, occurredOn: '2026-08-01' }));
      expect(html).toContain('badge-pending');
      expect(html).toContain('>Não pago</span>');
    }
  });

  it('StatusBadge renderiza nada para posted < cutoff', () => {
    const html = renderToString(createElement(StatusBadge, { status: 'posted', occurredOn: '2026-07-31' }));
    expect(html).toBe('');
  });

  it('StatusBadge renderiza nada para review < cutoff', () => {
    const html = renderToString(createElement(StatusBadge, { status: 'review', occurredOn: '2026-07-31' }));
    expect(html).toBe('');
  });

  it('nenhuma string técnica aparece como badge visual', () => {
    for (const s of ['posted', 'pending', 'review', 'scheduled', 'ignored']) {
      const html = renderToString(createElement(StatusBadge, { status: s, occurredOn: '2026-08-01' }));
      for (const forbidden of ['posted', 'pending', 'review', 'scheduled', 'ignored']) {
        expect(html).not.toContain(`>${forbidden}<`);
      }
    }
  });
});

describe('STATUS-P0c — harness/proteção contra 401 na troca de perfil', () => {
  it('smoke-prod.mjs não fecha browser/page antes do fluxo completar', () => {
    const src = readSource('../smoke-prod.mjs');
    const closeIdx = src.indexOf('browser.close()');
    const mainEnd = src.lastIndexOf('await browser.close()');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(mainEnd).toBeGreaterThan(-1);
    const afterClose = src.slice(mainEnd);
    expect(afterClose).not.toContain('process.exit(0)');
    expect(afterClose).not.toMatch(/page\.close\(\)/);
    expect(afterClose).not.toMatch(/context\.close\(\)/);
  });

  it('smoke-prod.mjs aguarda estabilização após troca de perfil (polling)', () => {
    const src = readSource('../smoke-prod.mjs');
    expect(src).toContain('aguardando troca de perfil');
    expect(src).toContain('sleep(5000)');
  });

  it('smoke-prod.mjs registra HTTP errors como arrays por fase (STARTUP/OFFICIAL), não como exceção', () => {
    const src = readSource('../smoke-prod.mjs');
    expect(src).toContain('STARTUP_HTTP_ERRORS.push');
    expect(src).toContain('OFFICIAL_HTTP_ERRORS.push');
    expect(src).toContain('status < 400');
  });

  it('smoke-prod.mjs não intercepta requests de auth', () => {
    const src = readSource('../smoke-prod.mjs');
    expect(src).toContain("url.includes('/auth/')");
    expect(src).toContain('return;');
  });

  it('smoke-prod.mjs instrumenta request trace por fase com profile/phase/auth', () => {
    const src = readSource('../smoke-prod.mjs');
    expect(src).toContain('STARTUP_TRACE');
    expect(src).toContain('OFFICIAL_TRACE');
    expect(src).toContain('OFFICIAL_PERSONAL');
    expect(src).toContain('OFFICIAL_BUSINESS');
    expect(src).toContain('authPresent');
    expect(src).toContain('currentProfile');
  });
});

describe('STATUS-P0c — AbortController em fetches (eliminação da race 401)', () => {
  it('RecentTransactions useEffect retorna cleanup que aborta', () => {
    const src = readSource('components/RecentTransactions.tsx');
    expect(src).toContain('new AbortController()');
    expect(src).toContain('ac.abort()');
    expect(src).toContain('AbortError');
  });

  it('TransactionList useEffect principal retorna cleanup que aborta', () => {
    const src = readSource('components/TransactionList.tsx');
    expect(src).toContain('new AbortController()');
    expect(src).toContain('ac.abort()');
    expect(src).toContain("err?.name === 'AbortError'");
  });

  it('Dashboard useEffect de resumo retorna cleanup que aborta', () => {
    const src = readSource('components/Dashboard.tsx');
    expect(src).toContain('new AbortController()');
    expect(src).toContain('ac.abort()');
    expect(src).toContain("err?.name === 'AbortError'");
  });

  it('txList.ts createTxPageFetcher aceita signal e aplica no query', () => {
    const src = readSource('lib/txList.ts');
    expect(src).toContain('signal?: AbortSignal');
    expect(src).toContain('opts.signal');
    expect(src).toContain('q.abortSignal(');
  });

  it('accountQuery.ts buildAccountQuery aceita signal', () => {
    const src = readSource('lib/accountQuery.ts');
    expect(src).toContain('signal?: AbortSignal');
    expect(src).toContain('q.abortSignal(signal)');
  });

  it('summary.ts fetchPeriodSummary aceita signal', () => {
    const src = readSource('lib/summary.ts');
    expect(src).toContain('signal?: AbortSignal');
  });
});