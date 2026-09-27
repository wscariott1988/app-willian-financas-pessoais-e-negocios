// seriesScope.ts — PESSOAL-13C4A-E10B
// Contrato de escopo (this | this_and_next | whole) para edição e exclusão de
// recorrências e parcelamentos. Lógica pura e testável; nenhum write aqui.
// O impacto NUNCA é inventado no cliente: vem de app.series_scope_impact
// (migration 027). Este módulo apenas normaliza, explica e monta argumentos.

import type { SeriesScope } from './series';
import { SERIES_SCOPE_LABELS } from './series';

/** Tri-estado explícito: 'preserve' não é NULL. (defeito 6) */
export type SeriesFieldAction = 'preserve' | 'set' | 'clear';

export const SERIES_FIELD_ACTIONS: readonly SeriesFieldAction[] = ['preserve', 'set', 'clear'] as const;

/** Forma devolvida por app.series_scope_impact. */
export interface SeriesScopeImpact {
  series_id: string;
  kind: string;
  scope: SeriesScope;
  from_occurrence: number | null;
  total_no_escopo: number;
  ativas: number;
  ja_excluidas: number;
  passadas: number;
  futuras: number;
  pagas: number;
  posted: number;
  pending: number;
  scheduled: number;
  editadas: number;
  indices_editados: number[];
  indices_ja_excluidos: number[];
  primeira_data: string | null;
  ultima_data: string | null;
  requer_confirmacao_passado: boolean;
  requer_confirmacao_pago: boolean;
  requer_confirmacao_editada: boolean;
  valor_coletivo_bloqueado: boolean;
  status_propagado: boolean;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function intArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => num(x)).filter((x) => Number.isFinite(x));
}

/**
 * Normaliza a resposta do RPC. Devolve null quando o payload não é um impacto
 * utilizável — a UI nunca deve chutar contagens.
 */
export function normalizeSeriesImpact(raw: unknown): SeriesScopeImpact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.series_id !== 'string' || !r.series_id) return null;
  const scope = r.scope === 'this' || r.scope === 'this_and_next' || r.scope === 'whole' ? (r.scope as SeriesScope) : null;
  if (!scope) return null;
  return {
    series_id: r.series_id,
    kind: typeof r.kind === 'string' ? r.kind : 'recurring',
    scope,
    from_occurrence: r.from_occurrence == null ? null : num(r.from_occurrence),
    total_no_escopo: num(r.total_no_escopo),
    ativas: num(r.ativas),
    ja_excluidas: num(r.ja_excluidas),
    passadas: num(r.passadas),
    futuras: num(r.futuras),
    pagas: num(r.pagas),
    posted: num(r.posted),
    pending: num(r.pending),
    scheduled: num(r.scheduled),
    editadas: num(r.editadas),
    indices_editados: intArray(r.indices_editados),
    indices_ja_excluidos: intArray(r.indices_ja_excluidos),
    primeira_data: typeof r.primeira_data === 'string' ? r.primeira_data : null,
    ultima_data: typeof r.ultima_data === 'string' ? r.ultima_data : null,
    requer_confirmacao_passado: r.requer_confirmacao_passado === true,
    requer_confirmacao_pago: r.requer_confirmacao_pago === true,
    requer_confirmacao_editada: r.requer_confirmacao_editada === true,
    valor_coletivo_bloqueado: r.valor_coletivo_bloqueado === true,
    status_propagado: r.status_propagado === true,
  };
}

/** Escopo nunca altera o que veio antes de p_from_occurrence. */
export function scopeTouchesPast(impact: SeriesScopeImpact | null): boolean {
  if (!impact) return false;
  return impact.passadas > 0;
}

export function scopeTouchesPosted(impact: SeriesScopeImpact | null): boolean {
  if (!impact) return false;
  return impact.pagas > 0;
}

export function scopeTouchesEdited(impact: SeriesScopeImpact | null): boolean {
  if (!impact) return false;
  return impact.editadas > 0;
}

/** Confirmações que a UI precisa exibir antes de liberar a operação. */
export function requiredConfirms(impact: SeriesScopeImpact | null): { past: boolean; posted: boolean; edited: boolean } {
  return {
    past: scopeTouchesPast(impact),
    posted: scopeTouchesPosted(impact),
    edited: scopeTouchesEdited(impact),
  };
}

/** true quando todas as confirmações exigidas foram marcadas. */
export function confirmsSatisfied(
  impact: SeriesScopeImpact | null,
  given: { past: boolean; posted: boolean; edited: boolean },
): boolean {
  const req = requiredConfirms(impact);
  return (!req.past || given.past) && (!req.posted || given.posted) && (!req.edited || given.edited);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function isoToBr(iso: string | null): string | null {
  if (!iso) return null;
  const d = iso.split('-');
  if (d.length !== 3) return iso;
  return `${d[2]}/${d[1]}/${d[0]}`;
}

/**
 * Linhas de prévia do impacto, em pt-BR, sem UUID e sem JSON.
 * `action` troca "excluir" por "alterar" na leitura.
 */
export function impactSummaryLines(impact: SeriesScopeImpact | null, action: 'edit' | 'delete'): string[] {
  if (!impact) return [];
  const verb = action === 'delete' ? 'serão excluídas' : 'serão alteradas';
  const out: string[] = [];
  // O número principal é o de ATIVAS, que é o que a mutação realmente toca:
  // os laços do backend filtram transactions.deleted_at IS NULL. Anunciar
  // total_no_escopo aqui inflaria a contagem quando há ocorrências já
  // excluídas no intervalo.
  out.push(`${plural(impact.ativas, 'ocorrência ativa', 'ocorrências ativas')} no escopo “${SERIES_SCOPE_LABELS[impact.scope]}” ${verb}.`);

  if (impact.ativas > 0) out.push(`Total no escopo: ${impact.total_no_escopo}.`);
  if (impact.passadas > 0) out.push(`${plural(impact.passadas, 'ocorrência passada', 'ocorrências passadas')} (datas anteriores a hoje).`);
  if (impact.pagas > 0) out.push(`${plural(impact.pagas, 'ocorrência paga/postada', 'ocorrências pagas/postadas')} (status posted).`);
  if (impact.pending > 0) out.push(`${plural(impact.pending, 'ocorrência pendente', 'ocorrências pendentes')}.`);
  if (impact.scheduled > 0) out.push(`${plural(impact.scheduled, 'ocorrência agendada', 'ocorrências agendadas')} (status scheduled).`);
  if (impact.editadas > 0) out.push(`${plural(impact.editadas, 'ocorrência editada individualmente', 'ocorrências editadas individualmente')} — serão incluídas, não ignoradas.`);

  const dmin = isoToBr(impact.primeira_data);
  const dmax = isoToBr(impact.ultima_data);
  if (dmin && dmax) out.push(`Período: ${dmin} até ${dmax}.`);
  else if (dmin) out.push(`Primeira data: ${dmin}.`);

  if (impact.indices_editados.length > 0) {
    out.push(`Ocorrências editadas no intervalo: ${impact.indices_editados.join(', ')}.`);
  }
  if (impact.ja_excluidas > 0) {
    out.push(`${plural(impact.ja_excluidas, 'ocorrência já excluída', 'ocorrências já excluídas')} no intervalo (reversível; nada será apagado em definitivo).`);
  }
  if (impact.valor_coletivo_bloqueado) {
    out.push('Valor não pode ser alterado em lote neste parcelamento: o escopo “Somente esta ocorrência” permite editar o valor de uma parcela.');
  }
  out.push('Nenhuma ocorrência será pulada em silêncio e nenhum status será propagado.');
  return out;
}

/** Avisos duros (passado / pago / editada) para a confirmação forte. */
export function impactWarnings(impact: SeriesScopeImpact | null, action: 'edit' | 'delete'): string[] {
  if (!impact) return [];
  const verb = action === 'delete' ? 'excluir' : 'alterar';
  const out: string[] = [];
  if (impact.passadas > 0) {
    out.push(`Esta operação ${verb} ${plural(impact.passadas, 'ocorrência passada', 'ocorrências passadas')} — lançamentos que já venceram.`);
  }
  if (impact.pagas > 0) {
    out.push(`Esta operação ${verb} ${plural(impact.pagas, 'ocorrência com status posted', 'ocorrências com status posted')} (paga/postada).`);
  }
  if (impact.editadas > 0) {
    out.push(`Esta operação ${verb} ${plural(impact.editadas, 'ocorrência editada individualmente', 'ocorrências editadas individualmente')} — elas entram na operação, não são ignoradas.`);
  }
  return out;
}

/**
 * Deriva o tri-estado de um campo editável a partir do valor original e do
 * valor do formulário. 'preserve' = intocado; 'clear' = limpar de verdade.
 * Nenhum NULL ambíguo: string vazia significa explicitamente "limpar".
 */
export function resolveFieldAction(
  original: string | null | undefined,
  next: string | null | undefined,
): { action: SeriesFieldAction; value: string | null } {
  const orig = original ?? '';
  const nxt = next ?? '';
  if (nxt === orig) return { action: 'preserve', value: null };
  if (nxt === '') return { action: 'clear', value: null };
  return { action: 'set', value: nxt };
}

export interface SeriesEditInfoLike {
  series_id: string;
  occurrence_index: number;
  total: number | null;
  kind: string;
  /** updated_at da SÉRIE: é contra este valor que a 027 faz concorrência otimista. */
  series_updated_at?: string | null;
}

export interface SeriesEditOptions {
  /** valores originais da ocorrência editada, para preservar/limpar */
  original?: { category_id?: string | null; memo?: string | null };
  /** updated_at da SÉRIE (concorrência otimista correta: 027 compara a série) */
  seriesUpdatedAt?: string | null;
  confirms?: { past?: boolean; posted?: boolean; edited?: boolean };
}

/** Valor só pode trafegar em 'this' para installment; recorrentecollective ok. */
export function seriesAmountAllowed(kind: string, scope: SeriesScope): boolean {
  if (scope === 'this') return true;
  return kind !== 'installment';
}

/**
 * Argumentos de app.transaction_series_edit.
 * Regra crítica: p_status NUNCA é enviado em escopo coletivo.
 */
export function buildSeriesEditArgs(
  seriesInfo: SeriesEditInfoLike,
  scope: SeriesScope,
  payload: Record<string, any>,
  expectedUpdatedAt: string | null,
  confirmPast: boolean,
  opts: SeriesEditOptions = {},
): Record<string, any> {
  const category = resolveFieldAction(opts.original?.category_id, payload.category_id);
  const memo = resolveFieldAction(opts.original?.memo, payload.memo);
  const amountAllowed = seriesAmountAllowed(seriesInfo.kind, scope);
  const collective = scope !== 'this';
  const c = opts.confirms ?? {};

  return {
    p_series_id: seriesInfo.series_id,
    p_from_occurrence: seriesInfo.occurrence_index,
    p_scope: scope,
    // 027 compara contra transaction_series.updated_at
    // O token de concorrência é SEMPRE o updated_at da SÉRIE, porque é contra
   // transaction_series.updated_at que a 027 compara. Cair no updated_at da
   // transação (legado do 021) compararia relógios de domínios diferentes e
   // dispararia CONFLITO espúrio em quase toda edição. Sem token de série, o
   // certo é mandar null e deixar o backend recusar com erro explícito.
   p_expected_updated_at: opts.seriesUpdatedAt ?? seriesInfo.series_updated_at ?? null,
    p_display_name: payload.description || null,
    p_amount: amountAllowed ? payload.amount ?? null : null,
    p_account_id: payload.account_id || null,
    p_category_action: category.action,
    p_category_id: category.action === 'set' ? category.value : null,
    p_memo_action: memo.action,
    p_memo: memo.action === 'set' ? memo.value : null,
    // backend rejeita p_status fora de 'this'; o cliente não envia.
    p_status: collective ? null : payload.status || null,
    p_confirm_past: collective ? !!c.past || !!confirmPast : false,
    p_confirm_posted: collective ? !!c.posted : false,
    p_confirm_edited: collective ? !!c.edited : false,
  };
}

/** Argumentos de app.transaction_series_delete. */
export function buildSeriesDeleteArgs(
  seriesInfo: SeriesEditInfoLike,
  scope: SeriesScope,
  expectedUpdatedAt: string | null,
  seriesUpdatedAt: string | null,
  confirms: { past?: boolean; posted?: boolean; edited?: boolean } = {},
): Record<string, any> {
  const collective = scope !== 'this';
  return {
    p_series_id: seriesInfo.series_id,
    p_from_occurrence: seriesInfo.occurrence_index,
    p_scope: scope,
    // Token de concorrência é o da SÉRIE (ver nota em buildSeriesEditArgs):
   // nunca o da transação. Sem ele, null para o backend recusar.
   p_expected_updated_at: seriesUpdatedAt ?? seriesInfo.series_updated_at ?? null,
    p_confirm_past: collective ? !!confirms.past : false,
    p_confirm_posted: collective ? !!confirms.posted : false,
    p_confirm_edited: collective ? !!confirms.edited : false,
  };
}

/** Argumentos de app.series_scope_impact (prévia, somente leitura). */
export function buildImpactArgs(seriesId: string, scope: SeriesScope, fromOccurrence: number): Record<string, any> {
  return {
    p_series_id: seriesId,
    p_from_occurrence: scope === 'whole' ? null : fromOccurrence,
    p_scope: scope,
  };
}
