// accountQuery.ts - Consulta testável de contas por perfil.
// Contas NÃO possuem profile_id: a associação conta ↔ perfil é feita por
// account_profile_periods (profile_id + período). O filtro de contas deve
// consultar account_profile_periods filtrado pelo perfil ATIVO e obter os
// dados de accounts — mesma semântica usada pelo TransactionEditor (todas as
// associações do perfil; sem filtro temporal na SQL; a data é tratada na UI).
// Nenhuma regra nova de vigência é inventada aqui.

export interface AccountClientLike {
  from(table: string): any;
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

export function buildAccountQuery(client: AccountClientLike, profileId: string, signal?: AbortSignal) {
  const q = client
    .from('account_profile_periods')
    .select('account_id, starts_on, ends_on, accounts(display_name, source_name)')
    .eq('profile_id', profileId);
  if (signal) q.abort(signal);
  return q;
}

export function mapAccountPeriods(rows: AccountPeriodRow[]): ProfileAccount[] {
  const seen = new Map<string, ProfileAccount>();
  for (const p of rows) {
    if (seen.has(p.account_id)) continue;
    const embedded = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts;
    seen.set(p.account_id, {
      id: p.account_id,
      display_name: embedded?.display_name || embedded?.source_name || 'Conta',
      source_name: embedded?.source_name || '',
    });
  }
  return [...seen.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
}
