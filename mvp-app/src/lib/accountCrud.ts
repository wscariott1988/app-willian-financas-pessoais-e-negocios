// accountCrud.ts - CRUD de contas (Configurações) com RPCs controlados.
// Regra de domínio (igual ao backend): conta válida em um perfil/data quando
// existe período em account_profile_periods:
//   starts_on <= data AND (ends_on IS NULL OR data <= ends_on)
// ends_on é INCLUSIVO; ends_on NULL = aberto (ativa hoje).
// Nenhum write direto em accounts/account_profile_periods: tudo via RPC
// public.account_* (SECURITY INVOKER -> app.* SECURITY DEFINER; perfil do JWT).

export type AccountType = 'bank' | 'credit_card' | 'cash' | 'benefit' | 'investment' | 'other';

export const ACCOUNT_TYPE_OPTIONS: { value: AccountType; label: string }[] = [
  { value: 'bank', label: 'Banco' },
  { value: 'credit_card', label: 'Cartão de crédito' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'benefit', label: 'Benefício' },
  { value: 'investment', label: 'Investimento' },
  { value: 'other', label: 'Outra' },
];

export interface AccountPeriodLike {
  account_id: string;
  starts_on: string | null;
  ends_on: string | null;
}

export interface AccountCrudClientLike {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface AccountWithStatus {
  id: string;
  display_name: string;
  source_name: string;
  active: boolean;
  is_favorite?: boolean;
  last_activity?: string | null;
  usage_count?: number;
}

export interface AccountActionResult {
  data: unknown;
  error: string | null;
}

export interface FavoriteResult {
  data: unknown;
  error: string | null;
}

/**
 * Ordena contas pela preferência canônica do profile atual (CFG-P8A/P8B):
 *   1) favoritas primeiro;
 *   2) dentro do grupo, recência DESC (last_activity);
 *   3) mesma recência, frequência DESC (usage_count);
 *   4) sem uso depois das com uso (dentro do grupo);
 *   5) empate: nome A→Z (pt-BR);
 *   6) empate final: id (interno, nunca exibido).
 * RECENCY  = MAX(occurred_on)  — perfil atual
 * FREQUENCY= COUNT(transactions) — perfil atual
 */
export function sortAccountsByPreference(
  accounts: AccountWithStatus[],
): AccountWithStatus[] {
  return [...accounts].sort((a, b) => {
    const fa = a.is_favorite ? 1 : 0;
    const fb = b.is_favorite ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const la = a.last_activity ?? '';
    const lb = b.last_activity ?? '';
    if (la !== lb) return la < lb ? 1 : -1;
    const ua = a.usage_count ?? 0;
    const ub = b.usage_count ?? 0;
    if (ua !== ub) return ub - ua;
    const nameCmp = a.display_name.localeCompare(b.display_name, 'pt-BR');
    if (nameCmp !== 0) return nameCmp;
    return a.id < b.id ? -1 : 1;
  });
}

// ---------- Helpers puros (testáveis) ----------

/** A conta está disponível no perfil na data (intervalo inclusivo). */
export function isAccountActiveOn(periods: AccountPeriodLike[], accountId: string, dateISO: string): boolean {
  return periods.some(
    (p) =>
      p.account_id === accountId &&
      p.starts_on !== null &&
      p.starts_on <= dateISO &&
      (p.ends_on === null || dateISO <= p.ends_on),
  );
}

/**
 * A conta está ABERTA (ativa) no perfil cobrindo a data — ou seja, existe
 * período com ends_on NULL cujo início já ocorreu. É a condição exigida para
 * NOVOS lançamentos: uma conta desativada (mesmo no dia do fechamento) não
 * pode receber lançamentos novos; o histórico continua validado pelo
 * intervalo inclusivo (isAccountActiveOn / assert_account_for_profile).
 */
export function isAccountOpenOn(periods: AccountPeriodLike[], accountId: string, dateISO: string): boolean {
  return periods.some(
    (p) => p.account_id === accountId && p.starts_on !== null && p.starts_on <= dateISO && p.ends_on === null,
  );
}

/**
 * Classifica uma conta em relação ao perfil cujos períodos são fornecidos.
 *   - 'active'   : existe período cobrindo a data (regra inclusiva).
 *   - 'inactive' : existe histórico do par (conta, perfil) mas nenhum período
 *                  aberto cobrindo a data — REATIVÁVEL.
 *   - 'other'    : NÃO existe nenhum período do par (conta, perfil) — conta de
 *                  outro perfil; NÃO é "inativa neste perfil".
 */
export function classifyAccountInProfile(
  periods: AccountPeriodLike[],
  accountId: string,
  dateISO: string,
): 'active' | 'inactive' | 'other' {
  const hasAny = periods.some((p) => p.account_id === accountId);
  if (!hasAny) return 'other';
  return isAccountActiveOn(periods, accountId, dateISO) ? 'active' : 'inactive';
}

/** Agrupa períodos por conta e deriva o estado Ativa/Inativa hoje. */
export function mapAccountsWithStatus(
  rows: AccountPeriodLike[],
  todayISO: string,
  names: Map<string, { display_name: string; source_name: string }>,
): AccountWithStatus[] {
  const seen = new Map<string, { display_name: string; source_name: string; active: boolean }>();
  for (const p of rows) {
    const cur = seen.get(p.account_id);
    const active = classifyAccountInProfile(rows, p.account_id, todayISO) === 'active';
    if (!cur) {
      const n = names.get(p.account_id) ?? { display_name: '', source_name: '' };
      seen.set(p.account_id, {
        display_name: n.display_name || n.source_name || 'Conta',
        source_name: n.source_name || '',
        active,
      });
    } else {
      cur.active = cur.active || active;
    }
  }
  return [...seen.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/**
 * Contas GLOBAIS que NUNCA tiveram período no perfil (candidatas a "Vincular
 * conta de outro perfil"). Não são "inativas deste perfil".
 */
export function accountsNeverLinkedToProfile(
  globalAccounts: { id: string; display_name: string; source_name: string }[],
  profilePeriods: AccountPeriodLike[],
): { id: string; display_name: string; source_name: string }[] {
  const present = new Set(profilePeriods.map((p) => p.account_id));
  return globalAccounts
    .filter((a) => !present.has(a.id))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

/** Alias de compatibilidade: mesma regra, nome legado. */
export const filterAvailableAccounts = accountsNeverLinkedToProfile;

export function accountErrorMessage(error: { message: string } | null): string | null {
  if (!error) return null;
  const m = error.message;
  if (m.includes('perfil nao identificado')) return 'Sessão expirada. Entre novamente.';
  if (m.includes('ja existe uma conta com esse nome')) return 'Já existe uma conta com esse nome.';
  if (m.includes('nome da conta obrigatorio')) return 'Informe o nome da conta.';
  if (m.includes('conta ja esta ativa')) return 'Esta conta já está ativa neste perfil.';
  if (m.includes('conta ja esta inativa')) return 'Esta conta já está inativa neste perfil.';
  if (m.includes('sobrepoe periodo historico')) return 'Reative a conta a partir de uma data posterior ao período anterior.';
  if (m.includes('conta nao encontrada')) return 'Conta não encontrada.';
  if (m.includes('nao esta disponivel no perfil')) return 'Esta conta não está disponível neste perfil.';
  if (m.includes('tipo de conta invalido')) return 'Tipo de conta inválido.';
  return 'Não foi possível concluir a operação.';
}

// ---------- Actions (RPCs; perfil sempre do JWT, nunca enviado) ----------

export async function createAccount(
  client: AccountCrudClientLike,
  displayName: string,
  accountType: AccountType,
  startsOn: string,
): Promise<AccountActionResult> {
  const { data, error } = await client.rpc('account_create', {
    p_display_name: displayName,
    p_account_type: accountType,
    p_starts_on: startsOn,
  });
  return { data, error: accountErrorMessage(error) };
}

export async function updateAccountName(
  client: AccountCrudClientLike,
  accountId: string,
  displayName: string,
): Promise<AccountActionResult> {
  const { data, error } = await client.rpc('account_update', {
    p_account_id: accountId,
    p_display_name: displayName,
  });
  return { data, error: accountErrorMessage(error) };
}

export async function setAccountActive(
  client: AccountCrudClientLike,
  accountId: string,
  active: boolean,
  dateISO: string,
): Promise<AccountActionResult> {
  const { data, error } = await client.rpc('account_set_profile_active', {
    p_account_id: accountId,
    p_active: active,
    p_date: dateISO,
  });
  return { data, error: accountErrorMessage(error) };
}

/** Data local ISO (yyyy-mm-dd) para ativar/desativar/novo período. */
export function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}