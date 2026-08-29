// auditFeed.ts - Feed de Histórico (read-only) a partir de transaction_audit
// e category_assignment_audit. Logica pura/testavel; nenhum write.
// Fonte canônica: transaction_audit (create/update/delete com before/after_state)
// e category_assignment_audit (atribuição de categoria). Contas (017) e
// categorias (018) NÃO geram eventos de auditoria no backend atual — eventos
// de contas/categorias são NÃO OBSERVADOS (documentado, sem inventar).
// Isolamento por perfil: resolvido pela RLS (profile_id = jwt_profile_id) +
// filtro .eq('profile_id') no frontend; os helpers recebem dados já filtrados.

export interface AuditRow {
  id: string;
  created_at: string;
}

export interface TxAuditRow extends AuditRow {
  action: 'create' | 'update' | 'delete';
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface CatAuditRow extends AuditRow {
  from_category_id: string | null;
  to_category_id: string | null;
  reason: string | null;
}

export interface SettingsAuditRow extends AuditRow {
  entity_type: 'account' | 'category';
  entity_id: string;
  action: 'create' | 'rename' | 'update' | 'link' | 'deactivate' | 'reactivate' | 'archive';
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface AuditEntry {
  source: 'transaction' | 'settings' | 'category';
  id: string;
  created_at: string;
  title: string;
  detail: string | null;
}

export interface CatNameMap {
  [id: string]: string;
}

export const ACTION_LABELS: Record<string, string> = {
  create: 'Transação criada',
  update: 'Transação editada',
  delete: 'Transação excluída',
};

export function formatCurrency(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'R$ —';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'R$ —';
  const digits = n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `R$ ${digits}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function str(state: Record<string, unknown> | null, key: string): string {
  const v = state?.[key];
  return v === null || v === undefined ? '' : String(v);
}

function diffLine(label: string, before: string, after: string): string | null {
  if (before === after) return null;
  return `${label} alterado de ${before} para ${after}`;
}

/** Mapeia um evento de transação para linguagem amigável (sem JSON cru). */
export function mapTxEntry(row: TxAuditRow, catNames: CatNameMap = {}): AuditEntry {
  const before = row.before_state ?? {};
  const after = row.after_state ?? {};
  const descr = (s: Record<string, unknown>) => str(s, 'raw_description') || str(s, 'normalized_description') || 'Transação';
  const amount = (s: Record<string, unknown>) => formatCurrency(s.amount);

  if (row.action === 'create') {
    return { source: 'transaction', id: row.id, created_at: row.created_at, title: 'Transação criada', detail: `${descr(after)} — ${amount(after)}` };
  }
  if (row.action === 'delete') {
    return { source: 'transaction', id: row.id, created_at: row.created_at, title: 'Transação excluída', detail: `${descr(before)} — ${amount(before)}` };
  }

  // update: diffs por campo observável
  const diffs: string[] = [];
  const aAmount = amount(before);
  const bAmount = amount(after);
  if (aAmount !== bAmount) diffs.push(`Valor alterado de ${aAmount} para ${bAmount}`);
  const d = diffLine('Descrição', descr(before), descr(after));
  if (d) diffs.push(d);
  const dt = diffLine('Data', str(before, 'occurred_on'), str(after, 'occurred_on'));
  if (dt) diffs.push(dt);
  const st = diffLine('Status', str(before, 'status'), str(after, 'status'));
  if (st) diffs.push(st);
  const kind = diffLine('Tipo', str(before, 'transaction_kind'), str(after, 'transaction_kind'));
  if (kind) diffs.push(kind);
  const catB = catNames[str(before, 'category_id')] ?? '';
  const catA = catNames[str(after, 'category_id')] ?? '';
  if (catB && catA && catB !== catA) diffs.push(`Categoria alterada de ${catB} para ${catA}`);
  return {
    source: 'transaction',
    id: row.id,
    created_at: row.created_at,
    title: 'Transação editada',
    detail: diffs.length > 0 ? diffs.join('; ') : 'Detalhes alterados',
  };
}

/** Mapeia um evento de atribuição de categoria. */
export function mapCatEntry(row: CatAuditRow, catNames: CatNameMap = {}): AuditEntry {
  const from = row.from_category_id ? (catNames[row.from_category_id] ?? '—') : '—';
  const to = row.to_category_id ? (catNames[row.to_category_id] ?? '—') : '—';
  return { source: 'category', id: row.id, created_at: row.created_at, title: 'Categoria alterada', detail: `${from} → ${to}` };
}

const SETTINGS_ACTION_LABELS: Record<string, { title: string; kind: 'account' | 'category' }> = {
  'account:create': { title: 'Conta criada', kind: 'account' },
  'account:rename': { title: 'Conta renomeada', kind: 'account' },
  'account:link': { title: 'Conta vinculada ao perfil', kind: 'account' },
  'account:deactivate': { title: 'Conta desativada', kind: 'account' },
  'account:reactivate': { title: 'Conta reativada', kind: 'account' },
  'category:create': { title: 'Categoria criada', kind: 'category' },
  'category:update': { title: 'Categoria atualizada', kind: 'category' },
  'category:archive': { title: 'Categoria arquivada', kind: 'category' },
  'category:reactivate': { title: 'Categoria reativada', kind: 'category' },
};

function nameOf(state: Record<string, unknown> | null): string {
  return state && typeof state.display_name === 'string' ? state.display_name : '';
}

function parentName(state: Record<string, unknown> | null, catNames: CatNameMap): string {
  const p = state?.parent_id;
  if (p === null || p === undefined) return 'raiz';
  return typeof p === 'string' ? (catNames[p] ?? '—') : '—';
}

/** Mapeia um evento de settings (contas/categorias) para linguagem amigável. */
export function mapSettingsEntry(row: SettingsAuditRow, catNames: CatNameMap = {}): AuditEntry {
  const meta = SETTINGS_ACTION_LABELS[`${row.entity_type}:${row.action}`];
  if (!meta) return { source: 'settings', id: row.id, created_at: row.created_at, title: 'Alteração registrada', detail: null };
  const before = row.before_state ?? {};
  const after = row.after_state ?? {};
  let title = meta.title;
  let detail: string | null = null;

  if (row.entity_type === 'account') {
    const nm = nameOf(after) || nameOf(before);
    if (row.action === 'rename') {
      detail = `${nameOf(before)} → ${nameOf(after)}`;
    } else if (row.action === 'create' || row.action === 'deactivate' || row.action === 'reactivate' || row.action === 'link') {
      detail = nm || null;
    }
  } else if (row.action === 'update') {
    // derivar rename/move do before/after (UM evento para ambas as mudanças)
    const bn = nameOf(before);
    const an = nameOf(after);
    const nameChanged = bn !== an;
    const parentChanged = before.parent_id !== after.parent_id;
    const parts: string[] = [];
    if (nameChanged) parts.push(`${bn} → ${an}`);
    if (parentChanged) {
      parts.push(`${an || bn}: ${parentName(before, catNames)} → ${parentName(after, catNames)}`);
    }
    if (nameChanged && parentChanged) title = 'Categoria renomeada e movida';
    else if (nameChanged) title = 'Categoria renomeada';
    else if (parentChanged) title = 'Categoria movida';
    detail = parts.length > 0 ? parts.join('; ') : null;
  } else {
    const nm = nameOf(after) || nameOf(before);
    detail = nm || null;
  }
  return { source: 'settings', id: row.id, created_at: row.created_at, title, detail };
}

/** Ordenação determinística: created_at DESC; empate -> transaction, settings, category; depois id DESC. */
const SOURCE_ORDER: Record<string, number> = { transaction: 0, settings: 1, category: 2 };

export function compareEntries(a: AuditEntry, b: AuditEntry): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  const sa = SOURCE_ORDER[a.source] ?? 9;
  const sb = SOURCE_ORDER[b.source] ?? 9;
  if (sa !== sb) return sa - sb;
  return a.id < b.id ? 1 : -1;
}

export function mergeSortedUnique(a: AuditEntry[], b: AuditEntry[]): AuditEntry[] {
  const seen = new Set<string>();
  const out: AuditEntry[] = [];
  for (const e of [...a, ...b]) {
    const key = `${e.source}:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort(compareEntries);
}

export interface FeedResult {
  entries: AuditEntry[];
  hasMore: boolean;
}

export interface FeedSources {
  tx: TxAuditRow[];
  cat: CatAuditRow[];
  settings: SettingsAuditRow[];
}

/**
 * Paginação cumulativa sobre TRES fontes (transaction_audit,
 * category_assignment_audit, settings_audit). Recorta `pageSize` de cada
 * fonte (já ordenadas por created_at DESC no banco), mescla, deduplica e
 * ordena globalmente (created_at DESC; tie-breaker estável).
 */
export function computeFeed(sources: FeedSources, catNames: CatNameMap, pageSize: number): FeedResult {
  const txSlice = sources.tx.slice(0, pageSize);
  const catSlice = sources.cat.slice(0, pageSize);
  const setSlice = sources.settings.slice(0, pageSize);
  const entries = mergeSortedUnique(
    mergeSortedUnique(
      txSlice.map((r) => mapTxEntry(r, catNames)),
      setSlice.map((r) => mapSettingsEntry(r, catNames)),
    ),
    catSlice.map((r) => mapCatEntry(r, catNames)),
  );
  const hasMore =
    sources.tx.length > txSlice.length ||
    sources.settings.length > setSlice.length ||
    sources.cat.length > catSlice.length;
  return { entries: entries.slice(0, pageSize), hasMore };
}