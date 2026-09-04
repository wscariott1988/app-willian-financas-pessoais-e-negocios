// accountQuery.ts - Consulta testável de contas por perfil.
// Contas NÃO possuem profile_id: a associação conta ↔ perfil é feita por
// account_profile_periods (profile_id + período). O filtro de contas deve
// consultar account_profile_periods filtrado pelo perfil ATIVO e obter os
// dados de accounts — mesma semântica usada pelo TransactionEditor (todas as
// associações do perfil; sem filtro temporal na SQL; a data é tratada na UI).
// Nenhuma regra nova de vigência é inventada aqui.

export interface AccountClientLike {
  from(table: string): any;
  rpc(name: string, params?: Record<string, unknown>): any;
}

export interface AccountPeriodRow {
  account_id: string;
  starts_on: string | null;
  ends_on: string | null;
  accounts: { display_name: string; source_name: string }
    | Array<{ display_name: string; source_name: string }>
    | null;
}

export interface ProfileAccount {
  id: string;
  display_name: string;
  source_name: string;
}

/** Preferência de favorito por perfil (uma verdade atual por account+profile). */
export interface ProfileFavorite {
  account_id: string;
  is_favorite: boolean;
}

/** Nome do RPC read-only de uso por perfil (recência + frequência). */
export const USAGE_RPC_NAME = 'account_usage_stats';

/**
 * Recência e frequência por conta no perfil, em UMA chamada (N+1=0):
 *   RECENCY  = MAX(occurred_on)
 *   FREQUENCY= COUNT(transactions)
 * sem transações deletadas. O perfil é derivado do JWT no backend
 * (app.jwt_profile_id()); este endpoint NÃO aceita profile_id do cliente.
 * Agregados PostgREST estão desabilitados no Cloud (PGRST123, CFG-P8C0) —
 * por isso a metadata vem de um RPC read-only e não de .max()/.count()/.group().
 */
export function buildUsageQuery(client: AccountClientLike) {
  return client.rpc(USAGE_RPC_NAME);
}

export interface AccountUsageRow {
  account_id: string;
  last_activity: string | null;
  usage_count: number | string;
}

export function mapUsage(rows: AccountUsageRow[]): Map<string, { last_activity: string | null; usage_count: number }> {
  const out = new Map<string, { last_activity: string | null; usage_count: number }>();
  for (const r of rows) {
    const n = Number(r.usage_count ?? 0);
    out.set(r.account_id, {
      last_activity: r.last_activity ?? null,
      usage_count: Number.isFinite(n) ? n : 0,
    });
  }
  return out;
}

export function buildAccountQuery(client: AccountClientLike, profileId: string, signal?: AbortSignal) {
  const q = client
    .from('account_profile_periods')
    .select('account_id, starts_on, ends_on, accounts(display_name, source_name)')
    .eq('profile_id', profileId);
  if (signal) q.abortSignal(signal);
  return q;
}

export function mapAccountPeriods(rows: AccountPeriodRow[]): ProfileAccount[] {
  const seen = new Map<string, ProfileAccount>();
  for (const p of rows) {
    if (seen.has(p.account_id)) continue;
    const embedded = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts;
    seen.set(p.account_id, {
      id: p.account_id,
      display_name: embedded?.display_name || embedded?.source_name || 'Conta indisponível',
      source_name: embedded?.source_name || '',
    });
  }
  return [...seen.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
}
