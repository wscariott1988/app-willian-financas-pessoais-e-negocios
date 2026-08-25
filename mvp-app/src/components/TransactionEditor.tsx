import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { displayStatusValue, isStatusEditable, STATUS_OPTIONS } from '../lib/status';
import {
  Check, AlertCircle, RefreshCw, Pencil, Plus, X, ArrowLeftRight, Info, Trash2,
} from 'lucide-react';

interface Transaction {
  id: string;
  profile_id: string;
  account_id: string;
  category_id: string | null;
  transaction_kind: 'income' | 'expense' | 'transfer';
  amount: string;
  occurred_on: string;
  raw_description: string;
  normalized_description: string;
  category_raw: string | null;
  status: 'posted' | 'pending' | 'review' | 'scheduled' | 'ignored';
  categories: { display_name: string } | null;
  accounts: { display_name: string } | null;
}

export type TxKind = 'income' | 'expense' | 'transfer';
export type TxStatus = 'posted' | 'pending' | 'review' | 'scheduled' | 'ignored';

interface Account {
  id: string;
  display_name: string;
  source_name: string;
}

interface Category {
  id: string;
  display_name: string;
  canonical_path: string | null;
}

interface AccountPeriod {
  account_id: string;
  starts_on: string;
  ends_on: string | null;
  accounts: { display_name: string; source_name: string } | Array<{ display_name: string; source_name: string }> | null;
}

export interface TxFormState {
  kind: TxKind;
  description: string;
  amount: string;
  occurred_on: string;
  account_id: string;
  to_account_id: string;
  category_id: string;
  status: TxStatus;
  memo: string;
}

interface TransactionEditorProps {
  profileId: string;
  profileCode: 'personal' | 'business';
  transaction: Transaction | null;
  creating: boolean;
  onSuccess: () => void;
  onClose: () => void;
}

const KIND_LABEL: Record<TxKind, string> = {
  expense: 'Despesa',
  income: 'Receita',
  transfer: 'Transferência',
};

const EMPTY_FORM: TxFormState = {
  kind: 'expense',
  description: '',
  amount: '',
  occurred_on: '',
  account_id: '',
  to_account_id: '',
  category_id: '',
  status: 'posted',
  memo: '',
};

function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseAmount(input: string): number | null {
  if (input == null) return null;
  let s = input.trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = s.replace(/,/g, '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function isAccountValidForDate(
  accountId: string,
  date: string,
  periods: Array<Pick<AccountPeriod, 'account_id' | 'starts_on' | 'ends_on'>>
): boolean {
  if (!accountId || !date) return false;
  return periods.some((p) => {
    if (p.account_id !== accountId) return false;
    if (p.starts_on > date) return false;
    if (p.ends_on != null && p.ends_on < date) return false;
    return true;
  });
}

// Payload exato enviado aos RPCs transaction_create/transaction_update (STATUS-P0).
// Envia SEMPRE form.status (o valor real do formulário): o status é inicializado
// do registro carregado e só muda por ação explícita do usuário no controle
// Pago/Não pago — assim status legados (review/scheduled/ignored) e históricos
// são preservados em edições não relacionadas, sem normalização silenciosa.
export function buildSavePayload(form: TxFormState): Record<string, any> {
  const amount = parseAmount(form.amount);
  return {
    kind: form.kind,
    description: form.description.trim(),
    amount: String(amount),
    occurred_on: form.occurred_on,
    account_id: form.account_id,
    to_account_id: form.to_account_id || null,
    category_id: form.category_id || null,
    status: form.status,
    memo: form.memo || null,
  };
}

export const TransactionEditor: React.FC<TransactionEditorProps> = ({
  profileId,
  profileCode,
  transaction,
  creating,
  onSuccess,
  onClose,
}) => {
  const [form, setForm] = useState<TxFormState>(EMPTY_FORM);
  const [statusEdited, setStatusEdited] = useState(false);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);
  const [detailTxId, setDetailTxId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<AccountPeriod[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingCats, setLoadingCats] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  const savingRef = useRef(false);

  const isEdit = !!transaction && !creating;
  const editId = transaction?.id ?? null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- Load accounts (valid for the chosen date) ----
  useEffect(() => {
    let cancelled = false;
    const loadAccounts = async () => {
      try {
        const { data, error: accError } = await supabase
          .from('account_profile_periods')
          .select('account_id, starts_on, ends_on, accounts(display_name, source_name)')
          .eq('profile_id', profileId);
        if (accError) throw accError;
        if (cancelled) return;
        const rows = (data || []) as unknown as AccountPeriod[];
        setPeriods(rows);
      } catch (err: any) {
        console.error('Erro ao carregar contas do editor:', err);
        if (!cancelled) setError(err.message || 'Falha ao carregar contas.');
      }
    };
    loadAccounts();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const accountsForDate = useCallback((): Account[] => {
    const seen = new Map<string, Account>();
    for (const p of periods) {
      if (!isAccountValidForDate(p.account_id, form.occurred_on, periods)) continue;
      const embedded = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts;
      const name = embedded?.display_name || '';
      if (!seen.has(p.account_id)) {
        seen.set(p.account_id, {
          id: p.account_id,
          display_name: name || p.account_id.slice(0, 8),
          source_name: embedded?.source_name || '',
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [periods, form.occurred_on]);

  const accounts = accountsForDate();
  const originAccounts = accounts.filter((a) => a.id !== form.to_account_id);
  const destAccounts = accounts.filter((a) => a.id !== form.account_id);

  // ---- Load detail on edit ----
  useEffect(() => {
    if (!editId) {
      setForm((f) => ({ ...EMPTY_FORM, kind: f.kind, status: f.status, occurred_on: f.occurred_on || localDateISO(new Date()) }));
      setStatusEdited(false);
      setExpectedUpdatedAt(null);
      setDetailTxId(null);
      setError(null);
      setConflict(false);
      return;
    }
    if (detailTxId === editId) return;

    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    setConflict(false);
    setSuccessMsg(null);

    const loadDetail = async () => {
      try {
        const { data, error: rpcError } = await supabase.rpc('transaction_get_detail', {
          transaction_id: editId,
        });
        if (rpcError) throw rpcError;
        if (cancelled || !data?.transaction) return;

        const t = data.transaction;
        let toAccountId = '';
        if (t.transaction_kind === 'transfer' && data.transfer) {
          const isOut = t.id === data.transfer.out_transaction_id;
          toAccountId = isOut ? data.transfer.in_account_id : data.transfer.out_account_id;
        }

        setForm({
          kind: t.transaction_kind as TxKind,
          description: t.raw_description || '',
          amount: formatAmountForInput(t.amount),
          occurred_on: (t.occurred_on || '').split('T')[0],
          account_id: t.account_id || '',
          to_account_id: toAccountId,
          category_id: t.category_id || '',
          status: (t.status as TxStatus) || 'posted',
          memo: t.memo || '',
        });
        setStatusEdited(false);
        setExpectedUpdatedAt(t.updated_at || null);
        setDetailTxId(editId);
      } catch (err: any) {
        console.error('Erro ao carregar detalhe da transação:', err);
        if (!cancelled) setError(err.message || 'Falha ao carregar a transação.');
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    };
    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [editId, detailTxId]);

  // ---- Load categories by kind/profile ----
  useEffect(() => {
    let cancelled = false;
    const loadCategories = async () => {
      if (form.kind === 'transfer') {
        setCategories([]);
        return;
      }
      setLoadingCats(true);
      try {
        const { data, error: catError } = await supabase
          .from('categories')
          .select('id, display_name, canonical_path')
          .eq('profile_id', profileId)
          .eq('direction', form.kind)
          .eq('status', 'active');
        if (catError) throw catError;
        if (cancelled) return;
        const sorted = ((data as Category[]) || []).sort((a, b) => {
          const pathA = a.canonical_path || a.display_name;
          const pathB = b.canonical_path || b.display_name;
          return pathA.localeCompare(pathB);
        });
        setCategories(sorted);
      } catch (err: any) {
        console.error('Erro ao carregar categorias do editor:', err);
        if (!cancelled) setError(err.message || 'Falha ao carregar categorias.');
      } finally {
        if (!cancelled) setLoadingCats(false);
      }
    };
    loadCategories();
    return () => {
      cancelled = true;
    };
  }, [form.kind, profileId]);

  const set = (patch: Partial<TxFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
    setConflict(false);
  };

  const handleKindChange = (kind: TxKind) => {
    setForm((f) => ({
      ...f,
      kind,
      category_id: kind === 'transfer' ? '' : f.category_id,
      to_account_id: kind === 'transfer' ? f.to_account_id : '',
    }));
    setError(null);
    setConflict(false);
  };

  const amountValue = parseAmount(form.amount);
  const transferReady = form.kind !== 'transfer' || (!!form.to_account_id && form.to_account_id !== form.account_id);
  const canSave =
    form.description.trim() !== '' &&
    amountValue !== null &&
    !!form.occurred_on &&
    !!form.account_id &&
    (form.kind === 'transfer' ? transferReady : true) &&
    !!form.status;

  const doSave = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setConflict(false);
    setSuccessMsg(null);

    const payload = buildSavePayload(form);

    try {
      let data: any;
      let rpcError: any;
      if (isEdit && editId) {
        const res = await supabase.rpc('transaction_update', {
          ...payload,
          transaction_id: editId,
          expected_updated_at: expectedUpdatedAt,
        });
        data = res.data;
        rpcError = res.error;
      } else {
        const res = await supabase.rpc('transaction_create', payload);
        data = res.data;
        rpcError = res.error;
      }

      if (rpcError) {
        const msg = String(rpcError.message || rpcError);
        if (msg.includes('CONFLITO')) {
          setConflict(true);
          setError('Conflito de edição: a transação foi modificada por outra operação. Recarregue e tente novamente.');
        } else {
          setError(msg);
        }
        return;
      }

      const actionLabel = isEdit ? 'atualizada' : 'criada';
      setSuccessMsg(`Transação ${actionLabel} com sucesso!`);
      if (!mounted.current) return;
      setTimeout(() => {
        if (mounted.current) onSuccess();
      }, 1200);
    } catch (err: any) {
      console.error('Erro ao salvar transação:', err);
      const msg = String(err.message || err);
      if (msg.includes('CONFLITO')) {
        setConflict(true);
        setError('Conflito de edição: a transação foi modificada por outra operação. Recarregue e tente novamente.');
      } else {
        setError(msg || 'Erro ao salvar a transação.');
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!isEdit || !editId || !expectedUpdatedAt) return;
    setDeleting(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('transaction_delete', {
        p_transaction_id: editId,
        p_expected_updated_at: expectedUpdatedAt,
      });
      if (rpcError) {
        const msg = String(rpcError.message || rpcError);
        if (msg.includes('CONFLITO')) {
          setError('Conflito: a transação foi modificada por outra operação. Recarregue e tente novamente.');
        } else {
          setError(msg || 'Erro ao excluir a transação.');
        }
        return;
      }
      setSuccessMsg('Transação excluída com sucesso!');
      if (!mounted.current) return;
      setTimeout(() => { if (mounted.current) onSuccess(); }, 1200);
    } catch (err: any) {
      console.error('Erro ao excluir transação:', err);
      setError(String(err.message || 'Erro ao excluir a transação.'));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  };

  const header = isEdit ? 'Editar Transação' : 'Nova Transação';
  const headerHint = isEdit
    ? 'Edição atômica com bloqueio otimista e auditoria completa'
    : 'Criação atômica de transação com auditoria';

  return (
    <div className="glass" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '-0.01em', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isEdit ? <Pencil size={16} style={{ color: 'var(--color-primary)' }} /> : <Plus size={16} style={{ color: 'var(--color-primary)' }} />}
            {header}
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            {headerHint}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Fechar editor"
          title="Fechar editor"
          style={{
            minWidth: '44px', minHeight: '44px', width: '44px', height: '44px',
            padding: 0, background: 'transparent', color: 'var(--color-text-muted)',
            borderRadius: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <X size={18} />
        </button>
      </div>

      {error && (
        <div style={{
          backgroundColor: conflict ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          border: `1px solid ${conflict ? 'rgba(245, 158, 11, 0.25)' : 'rgba(239, 68, 68, 0.2)'}`,
          color: conflict ? 'var(--color-warning)' : 'var(--color-danger)',
          padding: '12px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          border: '1px solid rgba(16, 185, 129, 0.2)',
          color: 'var(--color-success)', padding: '12px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', gap: '8px', alignItems: 'center', animation: 'fadeIn 0.3s ease',
        }}>
          <Check size={16} style={{ flexShrink: 0 }} />
          <span>{successMsg}</span>
        </div>
      )}

      {loadingDetail ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '20px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
          <RefreshCw size={16} className="spin-animation" />
          Carregando detalhes da transação...
        </div>
      ) : (
        <>
          {/* Tipo */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label htmlFor="te-kind" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Tipo
            </label>
            <select
              id="te-kind"
              value={form.kind}
              onChange={(e) => handleKindChange(e.target.value as TxKind)}
              style={{ width: '100%' }}
            >
              <option value="expense">Despesa (saída)</option>
              <option value="income">Receita (entrada)</option>
              <option value="transfer">Transferência</option>
            </select>
          </div>

          {/* Descrição */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label htmlFor="te-desc" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Descrição <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <input
              id="te-desc"
              type="text"
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Ex.: Mercado Pão de Açúcar"
              style={{ width: '100%' }}
            />
          </div>

          {/* Valor + Data */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-amount" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Valor (R$) <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <input
                id="te-amount"
                type="text"
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => set({ amount: e.target.value })}
                placeholder="0,00"
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-date" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Data <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <input
                id="te-date"
                type="date"
                value={form.occurred_on}
                onChange={(e) => set({ occurred_on: e.target.value })}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {/* Conta de origem */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label htmlFor="te-account" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {form.kind === 'transfer' ? 'Conta de origem' : 'Conta'} <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <select
              id="te-account"
              value={form.account_id}
              onChange={(e) => set({ account_id: e.target.value })}
              style={{ width: '100%' }}
            >
              <option value="">Selecione uma conta válida na data</option>
              {originAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}{a.source_name ? ` — ${a.source_name}` : ''}
                </option>
              ))}
            </select>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
              {accounts.length === 0
                ? 'Nenhuma conta ativa para esta data neste perfil.'
                : `${accounts.length} conta(s) ativa(s) em ${form.occurred_on || '—'} no perfil ${profileCode === 'business' ? 'Negócio' : 'Pessoal'}.`}
            </span>
          </div>

          {/* Conta de destino (transferência) */}
          {form.kind === 'transfer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-to-account" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Conta de destino <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <select
                id="te-to-account"
                value={form.to_account_id}
                onChange={(e) => set({ to_account_id: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="">Selecione a conta de destino</option>
                {destAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}{a.source_name ? ` — ${a.source_name}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Categoria */}
          {form.kind !== 'transfer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-category" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Categoria canônica
              </label>
              {loadingCats ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 2px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                  <RefreshCw size={15} className="spin-animation" />
                  Carregando categorias...
                </div>
              ) : (
                <select
                  id="te-category"
                  value={form.category_id}
                  onChange={(e) => set({ category_id: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">Sem categoria (opcional)</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.canonical_path || c.display_name}
                    </option>
                  ))}
                </select>
              )}
              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                Apenas categorias ativas de {KIND_LABEL[form.kind].toLowerCase()} no perfil atual.
              </span>
            </div>
          )}

          {form.kind === 'transfer' && (
            <div style={{
              backgroundColor: 'rgba(6, 182, 212, 0.08)',
              border: '1px solid rgba(6, 182, 212, 0.15)',
              borderRadius: '8px', padding: '12px 14px',
              color: 'var(--color-secondary)', fontSize: '12px',
              display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
            }}>
              <ArrowLeftRight size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
              <div>
                Uma transferência cria <strong>duas transações vinculadas</strong> (saída e entrada) mais o vínculo em transfer_links, com auditoria nas duas pontas.
              </div>
            </div>
          )}

          {/* Status (STATUS-P0): somente Pago/Não pago, e somente a partir do cutoff.
              Antes do cutoff o controle fica oculto e o status original é preservado. */}
          {isStatusEditable(form.occurred_on) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-status" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Status
              </label>
              <select
                id="te-status"
                value={statusEdited ? form.status : displayStatusValue(form.status)}
                onChange={(e) => {
                  set({ status: e.target.value as TxStatus });
                  setStatusEdited(true);
                }}
                style={{ width: '100%' }}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {isEdit && form.status !== 'posted' && form.status !== 'pending' && !statusEdited && (
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                  Status original preservado nesta edição. Escolha Pago ou Não pago apenas se quiser alterá-lo.
                </span>
              )}
            </div>
          )}

          {/* Observação */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label htmlFor="te-memo" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Observação (memo)
            </label>
            <textarea
              id="te-memo"
              value={form.memo}
              onChange={(e) => set({ memo: e.target.value })}
              placeholder="Anotações livres sobre esta transação"
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '14px', backgroundColor: 'rgba(13, 18, 34, 0.8)', border: '1px solid var(--border-card)', borderRadius: '8px', color: '#f8fafc', padding: '10px 14px', outline: 'none', transition: 'all 0.2s ease' }}
            />
          </div>

          {conflict && (
            <div style={{ fontSize: '12px', color: 'var(--color-warning)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <Info size={14} />
              Recarregue a lista para obter o estado mais recente antes de salvar novamente.
            </div>
          )}

          {confirmDelete && (
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: '8px', padding: '12px 14px',
              display: 'flex', flexDirection: 'column', gap: '10px',
              fontSize: '13px', color: 'var(--color-danger)',
            }}>
              {form.kind === 'transfer' ? (
                <>
                  <span><strong>Transferência:</strong> ambas as pontas (saída e entrada) e o vínculo serão excluídos.</span>
                  <span>Tem certeza que deseja excluir esta transferência? Esta ação não pode ser desfeita.</span>
                </>
              ) : (
                <span>Tem certeza que deseja excluir esta transação? Esta ação não pode ser desfeita.</span>
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setConfirmDelete(false)}
                  style={{ flex: 1, padding: '8px' }}
                  disabled={deleting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={doDelete}
                  style={{ flex: 1, padding: '8px', backgroundColor: 'var(--color-danger)', border: 'none' }}
                  disabled={deleting}
                >
                  {deleting ? <><RefreshCw size={14} className="spin-animation" /> Excluindo...</> : <><Trash2 size={14} /> Confirmar exclusão</>}
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', marginTop: '4px', alignItems: 'center' }}>
            {isEdit && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--color-danger)',
                  padding: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                  fontSize: '13px', opacity: 0.7,
                }}
                title="Excluir transação"
                disabled={saving || deleting}
              >
                <Trash2 size={16} />
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              style={{ flex: 1, padding: '12px' }}
              disabled={saving || deleting}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={doSave}
              style={{ flex: 1, padding: '12px' }}
              disabled={!canSave || saving || deleting}
            >
              {saving ? (
                <>
                  <RefreshCw size={16} className="spin-animation" />
                  Salvando...
                </>
              ) : (
                <>
                  <Check size={16} />
                  {isEdit ? 'Salvar Alterações' : 'Criar Transação'}
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export function formatAmountForInput(amount: string): string {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return amount || '';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
