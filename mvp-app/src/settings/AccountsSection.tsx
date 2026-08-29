import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { buildAccountQuery, type AccountPeriodRow } from '../lib/accountQuery';
import {
  ACCOUNT_TYPE_OPTIONS,
  createAccount,
  filterAvailableAccounts,
  localDateISO,
  mapAccountsWithStatus,
  setAccountActive,
  updateAccountName,
  type AccountType,
  type AccountWithStatus,
} from '../lib/accountCrud';

interface AvailableAccount {
  id: string;
  display_name: string;
  source_name: string;
}

export const DEACTIVATE_HINT =
  'Desativar esta conta impede novos lançamentos nela neste perfil. Os lançamentos anteriores continuam no histórico.';

export function AccountsSection({ profileId }: { profileId: string }) {
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([]);
  const [available, setAvailable] = useState<AvailableAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType>('bank');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const loadList = async (isCancelled?: () => boolean) => {
    const today = localDateISO(new Date());
    const names = new Map<string, { display_name: string; source_name: string }>();
    const { data: periodRows, error: periodError } = await buildAccountQuery(supabase as any, profileId);
    if (periodError) throw periodError;
    const rows = (periodRows ?? []) as AccountPeriodRow[];
    for (const p of rows) {
      const embedded = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts;
      if (!names.has(p.account_id) && embedded) {
        names.set(p.account_id, { display_name: embedded.display_name, source_name: embedded.source_name });
      }
    }
    const { data: globalRows, error: globalError } = await supabase
      .from('accounts')
      .select('id, display_name, source_name');
    if (globalError) throw globalError;
    if (isCancelled?.()) return;
    setAccounts(mapAccountsWithStatus(rows, today, names));
    setAvailable(filterAvailableAccounts((globalRows ?? []) as AvailableAccount[], rows));
  };

  useEffect(() => {
    let cancelled = false;
    setAccounts([]);
    setAvailable([]);
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        await loadList(() => cancelled);
      } catch {
        if (!cancelled) setError('Não foi possível carregar as contas.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [profileId]);

  const refresh = async () => {
    setActionError(null);
    setBusyId(null);
    setCreating(false);
    setEditingId(null);
    setConfirmingId(null);
    setActivatingId(null);
    setLoading(true);
    try {
      await loadList();
    } catch {
      setActionError('Não foi possível atualizar a lista de contas.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (newName.trim() === '' || creating) return;
    setCreating(true);
    setActionError(null);
    const result = await createAccount(supabase as any, newName.trim(), newType, localDateISO(new Date()));
    if (result.error) {
      setActionError(result.error);
      setCreating(false);
      return;
    }
    setNewName('');
    await refresh();
  };

  const handleRename = async (accountId: string) => {
    if (editName.trim() === '' || busyId) return;
    setBusyId(accountId);
    setActionError(null);
    const result = await updateAccountName(supabase as any, accountId, editName.trim());
    if (result.error) {
      setActionError(result.error);
      setBusyId(null);
      return;
    }
    await refresh();
  };

  const handleToggle = async (accountId: string, activate: boolean) => {
    if (busyId) return;
    setBusyId(accountId);
    setActionError(null);
    const result = await setAccountActive(supabase as any, accountId, activate, localDateISO(new Date()));
    if (result.error) {
      setActionError(result.error);
      setBusyId(null);
      return;
    }
    await refresh();
  };

  const handleActivateAvailable = async (accountId: string) => {
    if (busyId) return;
    setBusyId(accountId);
    setActionError(null);
    const result = await setAccountActive(supabase as any, accountId, true, localDateISO(new Date()));
    if (result.error) {
      setActionError(result.error);
      setBusyId(null);
      return;
    }
    await refresh();
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Contas</h2>
      {loading ? (
        <p className="settings-state">Carregando...</p>
      ) : error ? (
        <p className="settings-state settings-state-error">{error}</p>
      ) : (
        <>
          {accounts.length === 0 ? (
            <p className="settings-state">Nenhuma conta encontrada para este perfil.</p>
          ) : (
            <ul className="settings-list settings-accounts-list">
              {accounts.map((a) => (
                <li key={a.id} className="settings-item settings-account-row">
                  <div className="settings-account-info">
                    <span className="settings-account-name">{a.display_name}</span>
                    <span className={`settings-status-badge ${a.active ? 'settings-status-active' : 'settings-status-inactive'}`}>
                      {a.active ? 'Ativa' : 'Inativa'}
                    </span>
                  </div>
                  {editingId === a.id ? (
                    <div className="settings-account-actions">
                      <input
                        className="settings-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Nome da conta"
                      />
                      <button
                        className="settings-btn"
                        disabled={busyId !== null || editName.trim() === ''}
                        onClick={() => handleRename(a.id)}
                      >
                        Salvar
                      </button>
                      <button className="settings-btn" onClick={() => setEditingId(null)}>Cancelar</button>
                    </div>
                  ) : (
                    <div className="settings-account-actions">
                      {a.active ? (
                        confirmingId === a.id ? (
                          <>
                            <span className="settings-hint">{DEACTIVATE_HINT}</span>
                            <button
                              className="settings-btn settings-btn-danger"
                              disabled={busyId !== null}
                              onClick={() => handleToggle(a.id, false)}
                            >
                              Desativar
                            </button>
                            <button className="settings-btn" onClick={() => setConfirmingId(null)}>Cancelar</button>
                          </>
                        ) : (
                          <button className="settings-btn" onClick={() => { setConfirmingId(a.id); setActionError(null); }}>
                            Desativar
                          </button>
                        )
                      ) : (
                        <button className="settings-btn" disabled={busyId !== null} onClick={() => handleToggle(a.id, true)}>
                          Reativar
                        </button>
                      )}
                      <button
                        className="settings-btn"
                        disabled={busyId !== null}
                        onClick={() => { setEditingId(a.id); setEditName(a.display_name); setConfirmingId(null); }}
                      >
                        Editar
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="settings-block">
            <h3 className="settings-dir-title">Nova conta</h3>
            <div className="settings-account-actions">
              <input
                className="settings-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nome da conta"
              />
              <select
                className="settings-input"
                value={newType}
                onChange={(e) => setNewType(e.target.value as AccountType)}
              >
                {ACCOUNT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button className="settings-btn" disabled={creating || newName.trim() === ''} onClick={handleCreate}>
                Adicionar
              </button>
            </div>
          </div>

          {available.length > 0 && (
            <div className="settings-block">
              <h3 className="settings-dir-title">Ativar conta existente neste perfil</h3>
              <p className="settings-hint">A conta permanece disponível nos outros perfis em que já está ativa.</p>
              <div className="settings-account-actions">
                <select
                  className="settings-input"
                  value={activatingId ?? ''}
                  onChange={(e) => setActivatingId(e.target.value || null)}
                >
                  <option value="">Escolher conta...</option>
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>{a.display_name}</option>
                  ))}
                </select>
                <button
                  className="settings-btn"
                  disabled={busyId !== null || !activatingId}
                  onClick={() => activatingId && handleActivateAvailable(activatingId)}
                >
                  Ativar neste perfil
                </button>
              </div>
            </div>
          )}

          {actionError && <p className="settings-state settings-state-error">{actionError}</p>}
        </>
      )}
    </section>
  );
}