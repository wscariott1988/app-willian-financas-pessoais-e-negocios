import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { displayStatusValue, isStatusEditable, STATUS_OPTIONS } from '../lib/status';
import { isAccountOpenOn } from '../lib/accountCrud';
import {
  Check, AlertCircle, RefreshCw, Pencil, Plus, X, ArrowLeftRight, Info, Trash2, Repeat, CalendarRange,
} from 'lucide-react';
import {
  buildSeriesPreview,
  previewLine,
  previewSummary,
  seriesOccurrenceStatus,
  SERIES_FREQUENCY_LABELS,
  SERIES_KIND_LABELS,
  type PreviewRow,
  type SeriesFrequency,
  type SeriesKind,
  type SeriesScope,
  SERIES_SCOPE_LABELS,
} from '../lib/series';

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

export type EntryType = 'single' | 'installment' | 'recurring';
export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  single: 'Única',
  installment: 'Parcelada',
  recurring: 'Recorrente',
};

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
  // ---- Package 015: série (somente criação) e escopo de série (edição/exclusão)
  const [entryType, setEntryType] = useState<EntryType>('single');
  const [seriesTotal, setSeriesTotal] = useState<string>('12');
  const [seriesFrequency, setSeriesFrequency] = useState<SeriesFrequency>('monthly');
  const [seriesScope, setSeriesScope] = useState<SeriesScope | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [seriesInfo, setSeriesInfo] = useState<{ series_id: string; occurrence_index: number; total: number | null; kind: string } | null>(null);
  const [extending, setExtending] = useState(false);
  const [extendMsg, setExtendMsg] = useState<string | null>(null);
  const [confirmPast, setConfirmPast] = useState(false);
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

  const accountsForDate = useCallback((requireOpen: boolean): Account[] => {
    const seen = new Map<string, Account>();
    for (const p of periods) {
      // Novo lançamento: conta precisa estar ABERTA no perfil (desativada não
      // recebe lançamento novo, nem no dia do fechamento). Edição histórica:
      // intervalo inclusivo — a conta continua representável na data histórica.
      const ok = requireOpen
        ? isAccountOpenOn(periods, p.account_id, form.occurred_on)
        : isAccountValidForDate(p.account_id, form.occurred_on, periods);
      if (!ok) continue;
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

  const accounts = accountsForDate(isEdit ? false : true);
  const originAccounts = accounts.filter((a) => a.id !== form.to_account_id);
  const destAccounts = accounts.filter((a) => a.id !== form.account_id);

  // Edição histórica: se a categoria atribuída não está na lista de ativas
  // (arquivada), mantê-la representável no seletor — sem alterar category_id.
  const historicCategory =
    isEdit && form.category_id && !categories.some((c) => c.id === form.category_id)
      ? { id: form.category_id, label: transaction?.categories?.display_name || 'Categoria arquivada' }
      : null;

  // ---- Load detail on edit ----
  useEffect(() => {
    if (!editId) {
      setForm((f) => ({ ...EMPTY_FORM, kind: f.kind, status: f.status, occurred_on: f.occurred_on || localDateISO(new Date()) }));
      setStatusEdited(false);
      setExpectedUpdatedAt(null);
      setDetailTxId(null);
      setError(null);
      setConflict(false);
      setSeriesInfo(null);
      setSeriesScope(null);
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
        // Package 015: se a transação pertence a uma série, descobre o escopo
        try {
          const { data: occ, error: occErr } = await supabase
            .from('transaction_series_occurrences')
            .select('series_id, occurrence_index, occurred_on, transaction_series(total_occurrences)')
            .eq('transaction_id', editId)
            .maybeSingle();
          if (occErr) throw occErr;
          if (occ?.series_id) {
            const ser = occ.transaction_series as unknown as { total_occurrences: number | null; kind: string | null } | null;
            setSeriesInfo({ series_id: occ.series_id, occurrence_index: occ.occurrence_index, total: ser?.total_occurrences ?? null, kind: ser?.kind ?? 'recurring' });
          } else {
            setSeriesInfo(null);
          }
        } catch {
          setSeriesInfo(null);
        }
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

  // ---- Package 015: preview local (nenhum write) ----
  const seriesValid = entryType === 'single' || (form.kind !== 'transfer' && !!form.account_id && !!form.occurred_on && amountValue !== null && (entryType === 'installment' ? (Number(seriesTotal) >= 1 && Number(seriesTotal) <= 120) : true));

  useEffect(() => {
    if (entryType === 'single' || !seriesValid || !form.account_id) {
      setPreview(null);
      setSeriesError(null);
      return;
    }
    const total = entryType === 'installment' ? Math.max(1, Number(seriesTotal) || 1) : null;
    const catOk = form.kind === 'transfer' || form.category_id === '' || categories.some((c) => c.id === form.category_id);
    const p = buildSeriesPreview(
      form.kind === 'income' ? 'income' : 'expense',
      entryType === 'installment' ? 'installment' : 'recurring',
      seriesFrequency,
      amountValue as number,
      total,
      form.occurred_on,
      (date) => isAccountValidForDate(form.account_id, date, periods),
      catOk,
    );
    const badAccount = p.rows.filter((r) => !r.account_valid);
    const badCategory = p.rows.filter((r) => !r.category_valid);
    if (badAccount.length > 0) {
      setSeriesError(`A conta escolhida não é válida para o perfil em ${badAccount.length} ocorrência(s) (ex.: ${previewLine(badAccount[0])}). Ajuste a conta ou a data inicial.`);
    } else if (badCategory.length > 0) {
      setSeriesError('A categoria escolhida não é válida (inativa, arquivada ou de outro perfil) para todas as ocorrências.');
    } else {
      setSeriesError(null);
    }
    setPreview(p.rows);
  }, [entryType, seriesValid, seriesTotal, seriesFrequency, form.account_id, form.occurred_on, amountValue, form.kind, form.category_id, categories, periods]);

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
        if (seriesInfo) {
          // Package 015: edição com escopo de série (this | this_and_next | whole)
          const scope = seriesScope ?? 'this';
          const res = await supabase.rpc('transaction_series_edit', {
            p_series_id: seriesInfo.series_id,
            p_from_occurrence: seriesInfo.occurrence_index,
            p_scope: scope,
            p_expected_updated_at: expectedUpdatedAt,
            p_display_name: payload.description || null,
            p_account_id: payload.account_id || null,
            p_category_id: payload.category_id || null,
            p_status: payload.status || null,
            p_memo: payload.memo || null,
            p_confirm_past: scope === 'whole' ? confirmPast : false,
          });
          data = res.data;
          rpcError = res.error;
        } else {
          const res = await supabase.rpc('transaction_update', {
            ...payload,
            transaction_id: editId,
            expected_updated_at: expectedUpdatedAt,
          });
          data = res.data;
          rpcError = res.error;
        }
      } else if (entryType !== 'single') {
        // Package 015: criação em série (parcelada/recorrente) — RPC atômico
        const res = await supabase.rpc('transaction_series_create', {
          p_idempotency_key: crypto.randomUUID(),
          p_direction: form.kind === 'income' ? 'income' : 'expense',
          p_kind: entryType === 'installment' ? 'installment' : 'recurring',
          p_frequency: seriesFrequency,
          p_display_name: payload.description,
          p_amount: payload.amount,
          p_total_occurrences: entryType === 'installment' ? Number(seriesTotal) : null,
          p_starts_on: payload.occurred_on,
          p_account_id: payload.account_id,
          p_category_id: payload.category_id || null,
          p_status: payload.status || 'posted',
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

      const actionLabel = isEdit ? 'atualizada' : entryType === 'single' ? 'criada' : 'criada em série';
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

  const doExtendSeries = async () => {
    if (!seriesInfo || extending) return;
    setExtending(true);
    setExtendMsg(null);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('transaction_series_materialize', {
        p_series_id: seriesInfo.series_id,
      });
      if (rpcError) {
        setError(String(rpcError.message || rpcError));
        return;
      }
      const n = data?.created ?? 0;
      setExtendMsg(n > 0 ? `Mais ${n} ocorrências geradas.` : 'Todas as ocorrências já foram geradas até agora.');
    } catch (err: any) {
      setError(String(err.message || 'Erro ao gerar próximas ocorrências.'));
    } finally {
      if (mounted.current) setExtending(false);
    }
  };

  const doDelete = async () => {
    if (!isEdit || !editId || !expectedUpdatedAt) return;
    setDeleting(true);
    setError(null);
    try {
      let data: any;
      let rpcError: any;
      if (seriesInfo) {
        // Package 015: exclusão com escopo de série (this | this_and_next | whole)
        const res = await supabase.rpc('transaction_series_delete', {
          p_series_id: seriesInfo.series_id,
          p_from_occurrence: seriesInfo.occurrence_index,
          p_scope: seriesScope ?? 'this',
          p_expected_updated_at: expectedUpdatedAt,
          p_confirm_past: (seriesScope ?? 'this') === 'whole' ? confirmPast : false,
        });
        data = res.data;
        rpcError = res.error;
      } else {
        const res = await supabase.rpc('transaction_delete', {
          p_transaction_id: editId,
          p_expected_updated_at: expectedUpdatedAt,
        });
        data = res.data;
        rpcError = res.error;
      }
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

          {/* Package 015: tipo de entrada (somente criação; transferências nunca em série) */}
          {!isEdit && form.kind !== 'transfer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-entry-type" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Entrada
              </label>
              <div id="te-entry-type" role="group" aria-label="Tipo de entrada" style={{ display: 'flex', gap: '8px' }}>
                {(['single', 'installment', 'recurring'] as EntryType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={entryType === t}
                    onClick={() => setEntryType(t)}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '8px', border: entryType === t ? '1px solid var(--color-primary)' : '1px solid var(--border-card)',
                      backgroundColor: entryType === t ? 'rgba(14, 165, 233, 0.1)' : 'rgba(13, 18, 34, 0.6)',
                      color: entryType === t ? 'var(--color-primary)' : 'var(--color-text-muted)',
                      fontWeight: entryType === t ? 700 : 500, fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                    }}
                  >
                    {t === 'recurring' ? <Repeat size={14} /> : t === 'installment' ? <CalendarRange size={14} /> : <Plus size={14} />}
                    {ENTRY_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Package 015: campos de série (criação) */}
          {!isEdit && entryType !== 'single' && form.kind !== 'transfer' && (
            <div style={{
              backgroundColor: 'rgba(13, 18, 34, 0.6)', border: '1px solid var(--border-card)',
              borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px',
            }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {entryType === 'installment' ? 'Parcelamento' : 'Recorrência'}
              </span>
              {entryType === 'installment' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label htmlFor="te-series-total" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                    Quantidade de parcelas
                  </label>
                  <input
                    id="te-series-total"
                    type="number"
                    min={1}
                    max={120}
                    value={seriesTotal}
                    onChange={(e) => setSeriesTotal(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                    O valor informado acima é o <strong>total</strong>; cada parcela recebe a divisão exata (a última ajusta os centavos).
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label htmlFor="te-series-freq" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                    Frequência
                  </label>
                  <select
                    id="te-series-freq"
                    value={seriesFrequency}
                    onChange={(e) => setSeriesFrequency(e.target.value as SeriesFrequency)}
                    style={{ width: '100%' }}
                  >
                    {Object.entries(SERIES_FREQUENCY_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                    Recorrência aberta: cria até 24 ocorrências à frente (horizonte controlado, nunca infinito). Ocorrências futuras nascem como "Não pago (agendado)".
                  </span>
                </div>
              )}

              {preview && preview.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{previewSummary(preview)}</span>
                  {preview.slice(0, entryType === 'recurring' ? 8 : 12).map((r) => (
                    <span key={r.index} style={{ fontSize: '12px', color: r.account_valid && r.category_valid ? 'var(--color-text)' : 'var(--color-danger)', fontVariantNumeric: 'tabular-nums' }}>
                      {previewLine(r)}
                    </span>
                  ))}
                  {entryType === 'recurring' && preview.length > 8 && (
                    <span style={{ fontSize: '11px', color: 'var(--color-text-faint)' }}>
                      … e mais {preview.length - 8} ocorrências futuras
                    </span>
                  )}
                </div>
              )}
              {seriesError && (
                <span style={{ fontSize: '12px', color: 'var(--color-danger)', display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                  <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
                  {seriesError}
                </span>
              )}
            </div>
          )}

          {/* Package 015: escopo de série (edição/exclusão) */}
          {isEdit && seriesInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="te-series-scope" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Aplicar a
              </label>
              <select
                id="te-series-scope"
                value={seriesScope ?? 'this'}
                onChange={(e) => { setSeriesScope(e.target.value as SeriesScope); setConfirmPast(false); }}
                style={{ width: '100%' }}
              >
                {Object.entries(SERIES_SCOPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              {seriesScope === 'whole' && (
                <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--color-warning)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={confirmPast}
                    onChange={(e) => setConfirmPast(e.target.checked)}
                    style={{ marginTop: '1px' }}
                  />
                  <span>
                    Confirmo que desejo alterar também ocorrências passadas. Ocorrências editadas individualmente são preservadas.
                  </span>
                </label>
              )}
              {seriesScope !== 'whole' && (
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                  "Esta e as próximas" nunca altera ocorrências anteriores.
                </span>
              )}

              {/* Recorrência aberta: extensão explícita (nunca automática) */}
              {seriesInfo.kind === 'recurring' && seriesInfo.total === null && !confirmDelete && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={doExtendSeries}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                    disabled={extending || saving || deleting}
                  >
                    {extending ? <RefreshCw size={14} className="spin-animation" /> : <CalendarRange size={14} />}
                    Gerar próximas ocorrências
                  </button>
                  {extendMsg && <span style={{ fontSize: '12px', color: 'var(--color-success)' }}>{extendMsg}</span>}
                </div>
              )}
            </div>
          )}

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
                  {historicCategory && (
                    <option key={historicCategory.id} value={historicCategory.id}>
                      {historicCategory.label} (arquivada)
                    </option>
                  )}
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
              ) : seriesInfo ? (
                <>
                  <span><strong>Este lançamento pertence a uma série.</strong> A exclusão será aplicada a: <strong>{SERIES_SCOPE_LABELS[seriesScope ?? 'this'].toLowerCase()}</strong>.</span>
                  {seriesScope === 'whole' && (
                    <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--color-warning)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={confirmPast} onChange={(e) => setConfirmPast(e.target.checked)} style={{ marginTop: '1px' }} />
                      <span>Confirmo que desejo excluir também ocorrências passadas.</span>
                    </label>
                  )}
                  <span>Tem certeza que deseja excluir? Esta ação não pode ser desfeita.</span>
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
