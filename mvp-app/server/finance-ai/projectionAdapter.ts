// projectionAdapter.ts — Adapter server-side da projeção (PESSOAL-13C4A-E2).
//
// SOMENTE mapeia dados para ProjectionEngineInput e chama buildProjection.
// NUNCA duplica as regras de cobertura/janela/qualidade/categorias/projeção.
//
// Contrato:
//   - recebe o SupabaseClient JÁ autenticado pela rota (JWT do usuário); a RLS
//     isola o perfil via app.jwt_profile_id() — NENHUM profile_id é recebido e
//     nenhum service_role/cliente administrativo é criado aqui;
//   - consulta somente tabelas/colunas existentes no código atual
//     (transactions, account_profile_periods, categories embebidas);
//   - paginação COMPLETA com .range(from, to) + ordenação estável;
//   - transações NÃO deletadas até o fim do mês de referência (mês atual inclui
//     lançamentos futuros registrados; mês passado nunca usa dados posteriores);
//   - status NÃO é filtro;
//   - transaction_kind NÃO é filtro: receitas/transferências chegam ao motor
//     (podem determinar o início do fallback), embora o buildProjection as
//     exclua dos totais;
//   - reutiliza o mapeamento monetário (centavos) e de categoria
//     (canonical_path/display_name) já adotado pelos analytics atuais;
//   - categoria nula chega como nula; o motor cria "Sem categoria";
//   - relógio injetável nos testes; em produção deriva a data de
//     America/Sao_Paulo com Intl.DateTimeFormat(...).formatToParts(), sem
//     depender da timezone do servidor;
//   - erro Supabase vira falha controlada (mensagem genérica, nunca bruta).

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildProjection,
  type ProjectionEngineInput,
  type ProjectionEngineResult,
  type ProjectionLensInput,
  type ProjectionPeriod,
  type ProjectionTransaction,
  type TransactionKind,
  type YearMonth,
} from '../../src/lib/analyticsProjection.js';
import { daysInMonth, toLocalISODate } from '../../src/lib/period.js';
import { providerStatusOf } from './observability.js';

export const PROJECTION_PAGE_SIZE = 1000;

// ============ Falha controlada ============

/** Erro do adapter: mensagem genérica; a mensagem bruta do Supabase NUNCA vaza. */
export class ProjectionDataError extends Error {
  /**
   * Status HTTP sanitizado do provider (inteiro 100–599) quando o falha de
   * busca veio com um; ausente caso contrário. Alimenta `providerStatus` do
   * evento de falha sem expor nenhuma mensagem/sql do Supabase.
   */
  status?: number;

  constructor(providerStatus?: number) {
    super('Não foi possível carregar os dados para a projeção.');
    this.name = 'ProjectionDataError';
    if (providerStatus !== undefined) this.status = providerStatus;
  }
}

// ============ Relógio (America/Sao_Paulo) ============

/**
 * Data de HOJE em São Paulo (YYYY-MM-DD), independente da timezone do
 * servidor. `now` é injetável apenas para testes determinísticos.
 */
export function saoPauloTodayISO(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ============ Tipos de linha (colunas existentes) ============

interface ProjectionTxRow {
  transaction_kind?: string | null;
  amount?: number | string | null;
  account_id?: string | null;
  category_id?: string | null;
  occurred_on?: string | null;
  status?: string | null;
  categories?:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null;
}

interface ProjectionPeriodRow {
  account_id?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
}

// ============ Helpers de mapeamento (mesma semântica dos analytics atuais) ============

function embeddedCategory(
  value:
    | { display_name: string; canonical_path: string | null }
    | Array<{ display_name: string; canonical_path: string | null }>
    | null
    | undefined,
): { display_name: string; canonical_path: string | null } | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/** Centavos: converte o valor monetário (reais) com a mesma regra dos analytics. */
function toCents(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Normaliza transaction_kind (mesmo fallback dos analytics atuais). */
function normalizeKind(v: string | null | undefined): TransactionKind {
  if (v === 'expense' || v === 'transfer') return v;
  return 'income';
}

function mapTransaction(r: ProjectionTxRow): ProjectionTransaction {
  const cat = embeddedCategory(r.categories);
  return {
    accountId: typeof r.account_id === 'string' ? r.account_id : '',
    occurredOn: typeof r.occurred_on === 'string' ? r.occurred_on : '',
    amountCents: toCents(r.amount),
    transactionKind: normalizeKind(r.transaction_kind),
    categoryId: r.category_id ?? null,
    categoryLabel:
      cat?.canonical_path || cat?.display_name || null,
    deletedAt: null,
    status: r.status ?? null,
  };
}

function mapPeriod(r: ProjectionPeriodRow): ProjectionPeriod {
  return {
    accountId: typeof r.account_id === 'string' ? r.account_id : '',
    startsOn: typeof r.starts_on === 'string' ? r.starts_on : '',
    endsOn: r.ends_on ?? null,
  };
}

// ============ Paginação completa ============

interface PageResult {
  data: unknown[] | null;
  error: unknown;
  count: number | null;
}

/**
 * Percorre TODAS as páginas (.range(from, to)) até esgotar. Sem perda sem
 * duplicação: páginas acumuladas; páginas vazias com count pendente abortam de
 * forma controlada. Qualquer erro da camada Supabase vira ProjectionDataError.
 */
export async function fetchAllProjectionPages<T>(
  fetchPage: (from: number, to: number) => Promise<PageResult>,
  pageSize: number = PROJECTION_PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  let totalCount: number | null = null;
  let from = 0;
  for (;;) {
    const { data, error, count } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new ProjectionDataError(providerStatusOf(error));
    const page = (data ?? []) as T[];
    out.push(...page);
    totalCount = typeof count === 'number' ? count : totalCount;
    if (totalCount !== null) {
      if (out.length >= totalCount) break;
      if (page.length === 0) throw new ProjectionDataError();
    } else if (page.length < pageSize || page.length === 0) {
      break;
    }
    from += pageSize;
  }
  return out;
}

const TRANSACTION_SELECT =
  'transaction_kind, amount, account_id, category_id, occurred_on, status, categories(display_name, canonical_path)';
const PERIOD_SELECT = 'account_id, starts_on, ends_on';

/** Página de transações VIVAS até `until` (inclusivo), sem filtrar status/kind. */
export function buildTransactionPageFetcher(
  supabase: SupabaseClient,
  until: string,
  pageSize: number = PROJECTION_PAGE_SIZE,
): (from: number, to: number) => Promise<PageResult> {
  return (from, to) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = supabase
      .from('transactions')
      .select(TRANSACTION_SELECT, { count: 'exact' })
      .is('deleted_at', null)
      .lte('occurred_on', until)
      .order('occurred_on', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    const pageSizeApplied = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : PROJECTION_PAGE_SIZE;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return q.range(from, from + pageSizeApplied - 1).then((r: any) => ({
      data: r?.data ?? null,
      error: r?.error ?? null,
      count: typeof r?.count === 'number' ? r.count : null,
    }));
  };
}

/** Períodos persistidos do perfil (RLS). Ends é nulo quando o período é aberto. */
export async function fetchPersistedProjectionPeriods(
  supabase: SupabaseClient,
  pageSize: number = PROJECTION_PAGE_SIZE,
): Promise<ProjectionPeriod[]> {
  const fetchPage: (from: number, to: number) => Promise<PageResult> = (from, to) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = supabase
      .from('account_profile_periods')
      .select(PERIOD_SELECT, { count: 'exact' })
      .order('account_id', { ascending: true })
      .order('starts_on', { ascending: true })
      .order('id', { ascending: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return q.range(from, to).then((r: any) => ({
      data: r?.data ?? null,
      error: r?.error ?? null,
      count: typeof r?.count === 'number' ? r.count : null,
    }));
  };
  const rows = await fetchAllProjectionPages<ProjectionPeriodRow>(fetchPage, pageSize);
  return rows.map(mapPeriod);
}

// ============ Entrada principal ============

export interface ProjectionAdapterOptions {
  /** Relógio injetável (YYYY-MM-DD, America/Sao_Paulo). Default: saoPauloTodayISO(). */
  todayISO?: string;
  /** Mês de referência a projetar. Default: mês atual de todayISO. */
  referenceMonth?: YearMonth | null;
  /** Lente de categoria que restringe os agregados (PESSOAL-13C4A-E3). Default: none. */
  lens?: ProjectionLensInput | null;
  /** Tamanho da página de transações. Default: PROJECTION_PAGE_SIZE. */
  pageSize?: number;
}

function resolveReferenceMonth(
  reference: YearMonth | null | undefined,
  todayISO: string,
): YearMonth {
  if (reference != null) {
    return { year: reference.year, month: reference.month };
  }
  const m = Number(todayISO.slice(5, 7));
  const y = Number(todayISO.slice(0, 4));
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new RangeError(
      `todayISO inválido: "${todayISO}" (esperado YYYY-MM-DD local válido para America/Sao_Paulo)`,
    );
  }
  return { year: y, month: m };
}

/**
 * Consulta transações vivas até o fim do mês de referência e os períodos
 * persistidos, monta ProjectionEngineInput e chama buildProjection.
 */
export async function fetchProjection(
  supabase: SupabaseClient,
  options: ProjectionAdapterOptions = {},
): Promise<ProjectionEngineResult> {
  const todayISO = options.todayISO ?? saoPauloTodayISO();
  const pageSize = options.pageSize ?? PROJECTION_PAGE_SIZE;
  const reference = resolveReferenceMonth(options.referenceMonth, todayISO);
  const until = toLocalISODate(
    reference.year,
    reference.month,
    daysInMonth(reference.year, reference.month),
  );

  const [txRows, periods] = await Promise.all([
    fetchAllProjectionPages<ProjectionTxRow>(
      buildTransactionPageFetcher(supabase, until, pageSize),
      pageSize,
    ),
    fetchPersistedProjectionPeriods(supabase, pageSize),
  ]);

  const input: ProjectionEngineInput = {
    todayISO,
    transactions: txRows.map(mapTransaction),
    periods,
    lens: options.lens ?? null,
  };
  if (options.referenceMonth != null) {
    input.referenceMonth = options.referenceMonth;
  }
  return buildProjection(input);
}