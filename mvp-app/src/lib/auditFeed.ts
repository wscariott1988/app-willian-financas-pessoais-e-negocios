// auditFeed.ts
// Lógica pura do feed combinado de auditoria:
//   * transaction_audit  -> criação, edição e exclusão;
//   * category_assignment_audit -> alterações de categoria.
// Ordenação combinada por created_at DESC + merge sem duplicação.
// Nenhuma dependência de UI/Supabase (testável em Vitest).

export type AuditSource = 'tx' | 'cat';
export type TxAction = 'create' | 'update' | 'delete';

export interface AuditEntry {
  source: AuditSource;
  id: string;
  label: string;
  description: string;
  amountText: string;
  kind: 'expense' | 'income' | 'transfer' | 'other';
  fromCat: string | null;
  toCat: string | null;
  reason: string | null;
  created_at: string;
}

export interface RawTxAudit {
  id: string;
  action: TxAction;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

export interface RawCatAudit {
  id: string;
  from_category_id: string | null;
  to_category_id: string;
  reason: string | null;
  created_at: string;
}

export const ACTION_LABELS: Record<TxAction, string> = {
  create: 'Transação criada',
  update: 'Transação editada',
  delete: 'Transação excluída',
};

export const CATEGORY_LABEL = 'Categoria alterada';

function stateText(state: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const v = state?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function formatAuditAmount(val?: string, kind?: string): string {
  if (!val) return '';
  const num = parseFloat(val);
  if (Number.isNaN(num)) return '';
  const prefix = kind === 'expense' ? '-' : kind === 'income' ? '+' : '';
  return `${prefix} R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatAuditDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR');
}

function normalizeKind(kind?: string): AuditEntry['kind'] {
  return kind === 'expense' || kind === 'income' || kind === 'transfer' ? kind : 'other';
}

export function mapTxEntry(row: RawTxAudit): AuditEntry {
  const before = row.before_state ?? {};
  const after = row.after_state ?? {};
  const description = stateText(after, 'raw_description') ?? stateText(before, 'raw_description') ?? 'Transação';
  const amount = stateText(after, 'amount') ?? stateText(before, 'amount');
  const kind = stateText(after, 'transaction_kind') ?? stateText(before, 'transaction_kind');
  return {
    source: 'tx',
    id: row.id,
    label: ACTION_LABELS[row.action] ?? 'Transação',
    description,
    amountText: formatAuditAmount(amount, kind),
    kind: normalizeKind(kind),
    fromCat: null,
    toCat: null,
    reason: null,
    created_at: row.created_at,
  };
}

export function mapCatEntry(row: RawCatAudit): AuditEntry {
  return {
    source: 'cat',
    id: row.id,
    label: CATEGORY_LABEL,
    description: '',
    amountText: '',
    kind: 'other',
    fromCat: row.from_category_id,
    toCat: row.to_category_id,
    reason: row.reason,
    created_at: row.created_at,
  };
}

function entryKey(entry: AuditEntry): string {
  return `${entry.source}:${entry.id}`;
}

const SOURCE_ORDER: Record<AuditSource, number> = { tx: 0, cat: 1 };

// Ordenação ESTÁVEL e total: created_at DESC, depois source (tx antes de cat),
// depois id (desempate determinístico — total, sem ordem ambígua).
export function compareEntries(a: AuditEntry, b: AuditEntry): number {
  const t = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  if (t !== 0) return t;
  const s = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  if (s !== 0) return s;
  return a.id.localeCompare(b.id);
}

// Merge + ordenação estável + dedupe por (source, id). Nunca perde linhas:
// entradas com o mesmo created_at são todas mantidas (ordem por source/id).
export function mergeSortedUnique(entries: AuditEntry[]): AuditEntry[] {
  const seen = new Set<string>();
  const out: AuditEntry[] = [];
  for (const e of [...entries].sort(compareEntries)) {
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export interface FeedPageResult {
  entries: AuditEntry[];
  hasMore: boolean;
}

// Paginação CUMULATIVA: recebe um recorte (0..pageSize-1) de CADA fonte já
// ordenado por created_at DESC, mescla, ordena estavelmente, deduplica e exibe
// os primeiros `pageSize`. hasMore pelos totais exatos de cada fonte.
// Comporta múltiplos eventos com created_at idêntico sem perda nem duplicação.
export function computeFeed(
  txRows: RawTxAudit[],
  catRows: RawCatAudit[],
  txTotal: number,
  catTotal: number,
  pageSize: number,
): FeedPageResult {
  const merged = mergeSortedUnique([
    ...txRows.map(mapTxEntry),
    ...catRows.map(mapCatEntry),
  ]);
  return {
    entries: merged.slice(0, pageSize),
    // Há mais quando: (a) o conjunto mesclado excede a página exibida
    // (linhas ocultas pelo slice), ou (b) alguma fonte tem mais linhas do que
    // as buscadas no recorte (registros mais antigos ainda não carregados).
    hasMore: merged.length > pageSize || txTotal > txRows.length || catTotal > catRows.length,
  };
}
