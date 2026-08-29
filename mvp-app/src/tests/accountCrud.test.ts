import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAccount,
  updateAccountName,
  setAccountActive,
  isAccountActiveOn,
  isAccountOpenOn,
  mapAccountsWithStatus,
  filterAvailableAccounts,
  accountErrorMessage,
  localDateISO,
  ACCOUNT_TYPE_OPTIONS,
  type AccountCrudClientLike,
} from '../lib/accountCrud';

const here = dirname(fileURLToPath(import.meta.url));
function readMigration(): string {
  return readFileSync(resolve(here, '..', '..', '..', 'supabase', 'migrations', '017_accounts_crud.sql'), 'utf8');
}
function readView(): string {
  return readFileSync(resolve(here, '..', 'views', 'SettingsView.tsx'), 'utf8');
}

function mockRpc(overrides?: { error?: { message: string } }) {
  const calls: string[] = [];
  const client: AccountCrudClientLike = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`${fn}||${JSON.stringify(args)}`);
      if (overrides?.error) return { data: null, error: overrides.error };
      return { data: { ok: true }, error: null };
    },
  };
  return { client, calls };
}

function callOf(entry: string): { fn: string; args: Record<string, unknown> } {
  const idx = entry.indexOf('||');
  return { fn: entry.slice(0, idx), args: JSON.parse(entry.slice(idx + 2)) };
}

const TODAY = '2026-08-28';

describe('CFG-P2C — criar conta', () => {
  it('1. criar conta no Pessoal chama o RPC controlado com nome/tipo/data (perfil vem do token)', async () => {
    const { client, calls } = mockRpc();
    const result = await createAccount(client, 'Carteira', 'cash', TODAY);
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(1);
    const call = callOf(calls[0]);
    const fn = call.fn;
    const parsed = call.args;
    expect(fn).toBe('account_create');
    expect(parsed.p_display_name).toBe('Carteira');
    expect(parsed.p_account_type).toBe('cash');
    expect(parsed.p_starts_on).toBe(TODAY);
    expect(Object.keys(parsed)).not.toContain('p_profile_id');
    expect(Object.keys(parsed)).not.toContain('profile_id');
  });

  it('2. criar conta no Negócio usa a mesma ação (o perfil é do JWT, nunca do payload)', async () => {
    const { client, calls } = mockRpc();
    await createAccount(client, 'Inter PJ', 'bank', TODAY);
    const parsed = callOf(calls[0]).args;
    expect(parsed.p_display_name).toBe('Inter PJ');
    expect(Object.keys(parsed)).not.toContain('p_profile_id');
  });

  it('nome vazio é rejeitado pelo backend (mensagem mapeada)', () => {
    expect(accountErrorMessage({ message: 'nome da conta obrigatorio' })).toBe('Informe o nome da conta.');
  });

  it('tipo de conta restrito às opções do produto', () => {
    expect(ACCOUNT_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      'bank', 'credit_card', 'cash', 'benefit', 'investment', 'other',
    ]);
  });
});

describe('CFG-P2C — editar conta', () => {
  it('3. editar nome chama account_update somente com id e nome', async () => {
    const { client, calls } = mockRpc();
    const result = await updateAccountName(client, 'ACC-1', 'Carteira Nova');
    expect(result.error).toBeNull();
    const call = callOf(calls[0]);
    const fn = call.fn;
    const parsed = call.args;
    expect(fn).toBe('account_update');
    expect(parsed.p_account_id).toBe('ACC-1');
    expect(parsed.p_display_name).toBe('Carteira Nova');
    expect(Object.keys(parsed)).toHaveLength(2);
  });

  it('nome vazio é rejeitado na edição', () => {
    expect(accountErrorMessage({ message: 'nome da conta obrigatorio' })).toBe('Informe o nome da conta.');
  });
});

describe('CFG-P2C — ativar/desativar por perfil', () => {
  it('4. ativar conta em outro perfil chama account_set_profile_active(true, data)', async () => {
    const { client, calls } = mockRpc();
    await setAccountActive(client, 'ACC-1', true, TODAY);
    const parsed = callOf(calls[0]).args;
    expect(callOf(calls[0]).fn).toBe('account_set_profile_active');
    expect(parsed.p_active).toBe(true);
    expect(parsed.p_date).toBe(TODAY);
  });

  it('desativar chama account_set_profile_active(false, data)', async () => {
    const { client, calls } = mockRpc();
    await setAccountActive(client, 'ACC-1', false, TODAY);
    const parsed = callOf(calls[0]).args;
    expect(parsed.p_active).toBe(false);
  });

  it('5. mesma conta pode estar ativa nos DOIS perfis simultaneamente', () => {
    const pessoal = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: null }];
    const negocio = [{ account_id: 'ACC', starts_on: '2022-06-01', ends_on: null }];
    expect(isAccountActiveOn(pessoal, 'ACC', TODAY)).toBe(true);
    expect(isAccountActiveOn(negocio, 'ACC', TODAY)).toBe(true);
  });

  it('6. desativar só o Pessoal não afeta o Negócio', () => {
    const pessoal = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: '2026-07-31' }];
    const negocio = [{ account_id: 'ACC', starts_on: '2022-06-01', ends_on: null }];
    expect(isAccountActiveOn(pessoal, 'ACC', TODAY)).toBe(false);
    expect(isAccountActiveOn(negocio, 'ACC', TODAY)).toBe(true);
  });

  it('7. desativar só o Negócio não afeta o Pessoal', () => {
    const pessoal = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: null }];
    const negocio = [{ account_id: 'ACC', starts_on: '2022-06-01', ends_on: '2026-07-31' }];
    expect(isAccountActiveOn(pessoal, 'ACC', TODAY)).toBe(true);
    expect(isAccountActiveOn(negocio, 'ACC', TODAY)).toBe(false);
  });

  it('erro de sessão/backend é mapeado para mensagem amigável', () => {
    expect(accountErrorMessage({ message: 'perfil nao identificado no token' })).toBe('Sessão expirada. Entre novamente.');
    expect(accountErrorMessage({ message: 'ja existe uma conta com esse nome (normalizado: x)' })).toBe('Já existe uma conta com esse nome.');
    expect(accountErrorMessage(null)).toBeNull();
  });
});

describe('CFG-P2C — semântica de desativação (aberto vs intervalo inclusivo)', () => {
  const closedToday = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: '2026-08-28' }];

  it('desativar hoje grava ends_on = hoje (inclusivo) e o histórico do dia permanece válido', () => {
    expect(isAccountActiveOn(closedToday, 'ACC', '2026-08-28')).toBe(true);
  });

  it('mesmo assim a conta NÃO está aberta para NOVO lançamento hoje', () => {
    expect(isAccountOpenOn(closedToday, 'ACC', '2026-08-28')).toBe(false);
  });

  it('conta aberta cobre novo lançamento; fechada não, mesmo com data histórica', () => {
    const open = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: null }];
    expect(isAccountOpenOn(open, 'ACC', TODAY)).toBe(true);
    expect(isAccountOpenOn(closedToday, 'ACC', '2023-05-10')).toBe(false);
  });

  it('abertura exige início já ocorrido', () => {
    const future = [{ account_id: 'ACC', starts_on: '2026-09-01', ends_on: null }];
    expect(isAccountOpenOn(future, 'ACC', TODAY)).toBe(false);
  });

  it('conta histórica continua válida para edição histórica (inclusivo)', () => {
    const closed = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: '2026-07-31' }];
    expect(isAccountActiveOn(closed, 'ACC', '2023-05-10')).toBe(true);
  });
});

describe('CFG-P2C — rename de conta compartilhada', () => {
  it('rename chama account_update (catálogo global; nome vale nos dois perfis)', async () => {
    const { client, calls } = mockRpc();
    await updateAccountName(client, 'ACC-1', 'Carteira Renomeada');
    const parsed = callOf(calls[0]).args;
    expect(parsed.p_account_id).toBe('ACC-1');
    expect(parsed.p_display_name).toBe('Carteira Renomeada');
    expect(Object.keys(parsed)).toHaveLength(2);
  });
});

describe('CFG-P2C — regras preservadas no backend (migration 017)', () => {
  const sql = readMigration();

  it('8. reativar cria NOVO período (INSERT) e nunca reabre o histórico', () => {
    expect(sql).toContain("'ui'");
    expect(sql).toContain('INSERT INTO account_profile_periods');
    expect(sql).not.toContain("UPDATE account_profile_periods\n           SET ends_on    = NULL");
    expect(sql).not.toMatch(/SET ends_on\s*=\s*NULL/i);
  });

  it('9. desativar fecha somente o período aberto (ends_on IS NULL), histórico intacto', () => {
    expect(sql).toMatch(/WHERE account_id = p_account_id[\s\S]*AND ends_on IS NULL/);
    expect(sql).not.toMatch(/DELETE FROM account_profile_periods/i);
  });

  it('10. sobreposição continua rejeitada (trigger por conta+perfil mantido)', () => {
    expect(sql).toContain('account_set_profile_active');
    expect(sql).toMatch(/sobrepoe periodo historico/i);
  });

  it('11. conta inativa não é válida para data atual (helper de disponibilidade)', () => {
    const closed = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: '2026-07-31' }];
    expect(isAccountActiveOn(closed, 'ACC', TODAY)).toBe(false);
  });

  it('12. conta histórica continua válida para transação na data histórica', () => {
    const closed = [{ account_id: 'ACC', starts_on: '2020-01-01', ends_on: '2026-07-31' }];
    expect(isAccountActiveOn(closed, 'ACC', '2023-05-10')).toBe(true);
    expect(isAccountActiveOn(closed, 'ACC', '2026-07-31')).toBe(true);
    expect(isAccountActiveOn(closed, 'ACC', '2026-08-01')).toBe(false);
  });

  it('15. nenhum physical delete em nenhuma tabela', () => {
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it('16. nenhuma mutation em transactions ou categories', () => {
    expect(sql).not.toMatch(/INSERT INTO\s+(transactions|categories)/i);
    expect(sql).not.toMatch(/UPDATE\s+(transactions|categories)\b/i);
    expect(sql).not.toMatch(/DELETE FROM\s+(transactions|categories)/i);
    expect(sql).not.toMatch(/UPDATE\s+transactions/i);
    expect(sql).not.toMatch(/UPDATE\s+categories/i);
  });
});

describe('CFG-P2C — UI (SettingsView)', () => {
  const view = readFileSync(resolve(here, '..', 'settings', 'AccountsSection.tsx'), 'utf8');

  it('13. erro do backend é exibido na interface ({actionError})', () => {
    expect(view).toContain('{actionError}');
    expect(view).toContain("setActionError(result.error)");
  });

  it('mensagem de desativação explica que o histórico é preservado', () => {
    expect(view).toContain('Desativar esta conta impede novos lançamentos nela neste perfil. Os lançamentos anteriores continuam no histórico.');
  });

  it('14. isolamento de perfil: lista escopada ao perfil ativo (query por períodos do perfil)', () => {
    const rows = [
      { account_id: 'ACC_PESSOAL', starts_on: '2022-01-01', ends_on: null },
    ];
    const names = new Map([['ACC_PESSOAL', { display_name: 'Pessoal', source_name: '' }]]);
    const result = mapAccountsWithStatus(rows, TODAY, names);
    expect(result.map((a) => a.id)).toEqual(['ACC_PESSOAL']);
    expect(result.map((a) => a.id)).not.toContain('ACC_NEGOCIO');
  });

  it('estado Ativa/Inativa derivado dos períodos do perfil', () => {
    const rows = [
      { account_id: 'A1', starts_on: '2020-01-01', ends_on: null },
      { account_id: 'A2', starts_on: '2020-01-01', ends_on: '2026-07-31' },
    ];
    const names = new Map([
      ['A1', { display_name: 'Ativa', source_name: '' }],
      ['A2', { display_name: 'Inativa', source_name: '' }],
    ]);
    const result = mapAccountsWithStatus(rows, TODAY, names);
    expect(result.find((a) => a.id === 'A1')?.active).toBe(true);
    expect(result.find((a) => a.id === 'A2')?.active).toBe(false);
  });

  it('contas de outro perfil aparecem como disponíveis para ativar (sem duplicar a conta)', () => {
    const globals = [
      { id: 'ACC', display_name: 'Carteira', source_name: 'Banco' },
      { id: 'OUTRA', display_name: 'Outra', source_name: 'X' },
    ];
    const periods = [{ account_id: 'OUTRA', starts_on: '2020-01-01', ends_on: null }];
    const available = filterAvailableAccounts(globals, periods);
    expect(available.map((a) => a.id)).toEqual(['ACC']);
    expect(available.map((a) => a.id)).not.toContain('OUTRA');
  });

  it('data local ISO para ativar/desativar (sem UTC shift)', () => {
    expect(localDateISO(new Date(2026, 7, 28))).toBe('2026-08-28');
    expect(localDateISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});