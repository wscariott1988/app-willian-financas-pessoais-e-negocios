// @vitest-environment jsdom

// pessoal13c4aE10fConfirmations.ui.test.tsx — E10F (gate 3.5)
// Confirmações de série (p_confirm_past/posted/edited) vêm EXCLUSIVAMENTE do
// aceite explícito do usuário, em TODOS os escopos (inclusive 'this').
// requiredConfirms(impact) fica na UI: decide O QUE precisa ser confirmado,
// nunca concede confirmação. Estes testes provam, com os componentes MONTADOS
// (jsdom + Testing Library), que:
//   a. edição em 'this' exigindo confirmação: sem aceite, o RPC NÃO é chamado
//      (botão desabilitado); com o checkbox marcado, as flags são enviadas;
//   b. sem exigência, não há confirmação desnecessária (nenhum checkbox, flags
//      false) e o save continua liberado;
//   c. troca de escopo invalida os aceites (checkboxes desmarcados, botão
//      re-bloqueado);
//   d. escopos coletivos continuam funcionando (confirmações plurais + flags);
//   e. falha da prévia mostra erro e bloqueia a mutação (save e delete).
//   f. exclusão em 'this': identico ao item (a) no fluxo de delete.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TransactionEditor } from '../components/TransactionEditor';
import { DeleteConfirmation } from '../components/DeleteConfirmation';
import { supabase } from '../supabaseClient';
import { useTransactionDetail } from '../hooks/useTransactionDetail';

vi.mock('../supabaseClient', () => {
  const rpc = vi.fn();
  const from = vi.fn();
  return { supabase: { rpc, from } };
});

vi.mock('../hooks/useTransactionDetail', () => ({
  useTransactionDetail: vi.fn(),
}));

// Fluência PostgREST: todos os métodos de query devolvem o MESMO objeto, que é
// thenable e resolve sempre com { data, error }. maybeSingle() também é
// thenable, então `await supabase.from(...).maybeSingle()` e
// `.from(...).maybeSingle().then(cb)` funcionam.
const queryBuilder = (value: unknown) => {
  const q: any = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    gte: () => q,
    lt: () => q,
    abortSignal: () => q,
    maybeSingle: () => q,
    then(res?: (v: unknown) => unknown) {
      return Promise.resolve(value).then(res);
    },
  };
  return q;
};

const mockSupabase = supabase as unknown as {
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
};

const origin = 's-1';

const impactPayload = (over: Record<string, unknown> = {}) => ({
  series_id: origin,
  kind: 'recurring',
  scope: 'this',
  from_occurrence: 0,
  total_no_escopo: 1,
  ativas: 1,
  ja_excluidas: 0,
  passadas: 0,
  futuras: 1,
  pagas: 0,
  posted: 0,
  pending: 1,
  scheduled: 0,
  editadas: 0,
  indices_editados: [],
  indices_ja_excluidos: [],
  primeira_data: null,
  ultima_data: null,
  requer_confirmacao_passado: false,
  requer_confirmacao_pago: false,
  requer_confirmacao_editada: false,
  valor_coletivo_bloqueado: false,
  status_propagado: false,
  ...over,
});

const impactPosted = { pagas: 1, posted: 1, requer_confirmacao_pago: true };
const impactPast = { passadas: 1, requer_confirmacao_passado: true };
const impactEdited = { editadas: 1, requer_confirmacao_editada: true };
const impactClean = { futuras: 2, pendings: 0 };

// maybeSingle() do supabase resolve { data, error }; a UI desestrutura os dois.
const seriesOccurrence = (over: Record<string, unknown> = {}) => ({
  data: {
    series_id: origin,
    occurrence_index: 0,
    occurred_on: '2026-06-15',
    transaction_series: { total_occurrences: 12, kind: 'installment', updated_at: 'series-ts' },
    ...over,
  },
  error: null,
});

const editedTransaction = {
  id: 'tx-1',
  profile_id: 'profile-1',
  account_id: 'acc-1',
  category_id: 'cat-1',
  transaction_kind: 'expense',
  amount: '12.50',
  occurred_on: '2026-06-15',
  raw_description: 'Parcela do curso',
  normalized_description: 'parcela do curso',
  category_raw: null,
  status: 'posted' as const,
  categories: null,
  accounts: null,
};

const detailFor = (status: string) => ({
  transaction: {
    id: 'tx-1',
    transaction_kind: 'expense',
    raw_description: 'Parcela do curso',
    amount: '12.50',
    occurred_on: '2026-06-15',
    account_id: 'acc-1',
    category_id: 'cat-1',
    status,
    memo: null,
    updated_at: 'tx-ts',
  },
});

const renderEditor = () =>
  render(
    <TransactionEditor
      profileId="profile-1"
      profileCode="personal"
      transaction={editedTransaction as any}
      creating={false}
      onSuccess={() => {}}
      onClose={() => {}}
    />,
  );

const setupImpact = (impacts: Record<string, Record<string, unknown>>) => {
  mockSupabase.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === 'series_scope_impact') {
      const scope = String(args.p_scope ?? 'this');
      return { data: impactPayload({ scope, ...(impacts[scope] ?? impactClean) }), error: null };
    }
    if (name === 'account_usage_stats') return { data: [], error: null };
    if (name === 'transaction_get_detail') return { data: detailFor('pending'), error: null };
    if (name === 'transaction_series_edit' || name === 'transaction_series_delete' || name === 'transaction_update' || name === 'transaction_delete') {
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'RPC inesperado: ' + name } };
  });
};

const setupSeries = (occ: unknown, impact: Record<string, Record<string, unknown>>) => {
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'transaction_series_occurrences') return queryBuilder(occ);
    return queryBuilder({ data: [], error: null });
  });
  setupImpact(impact);
};

let originalActEnv: unknown;

beforeAll(() => {
  originalActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (originalActEnv === undefined) {
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  } else {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useTransactionDetail).mockReturnValue({
    data: detailFor('posted') as any,
    loading: false,
    error: null,
    retry: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});

describe('E10F — edição em "this": confirmação vem SÓ do aceite explícito', () => {
  it('a. sem aceite: botão desabilitado e transaction_series_edit NÃO é chamado', async () => {
    setupSeries(seriesOccurrence(), { this: impactPosted });
    renderEditor();
    const save = screen.getByRole('button', { name: /Salvar Alterações/ }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByTestId('series-impact-preview')).toBeTruthy());
    await waitFor(() => expect(save.disabled).toBe(true));
    fireEvent.click(save);
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('transaction_series_edit', expect.anything());
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('transaction_update', expect.anything());
  });

  it('a. existe checkbox com texto de ocorrência única em "this" e SEM pré-marcação', async () => {
    setupSeries(seriesOccurrence(), { this: impactPosted });
    renderEditor();
    await waitFor(() =>
      expect(screen.getByText('Confirmo que desejo alterar esta ocorrência com status posted (paga/postada).')).toBeTruthy(),
    );
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('b. com o checkbox marcado, as flags do aceite são enviadas', async () => {
    setupSeries(seriesOccurrence(), { this: impactPosted });
    renderEditor();
    const save = screen.getByRole('button', { name: /Salvar Alterações/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    fireEvent.click(await waitFor(() => screen.getByRole('checkbox')));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'transaction_series_edit',
        expect.objectContaining({ p_confirm_posted: true, p_confirm_past: false, p_confirm_edited: false }),
      ),
    );
  });

  it('b. sem exigência: nenhum checkbox, flags false e save liberado sem confirmação desnecessária', async () => {
    setupSeries(seriesOccurrence(), { this: {} });
    renderEditor();
    const save = screen.getByRole('button', { name: /Salvar Alterações/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(save);
    await waitFor(() =>
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'transaction_series_edit',
        expect.objectContaining({ p_confirm_posted: false, p_confirm_past: false, p_confirm_edited: false }),
      ),
    );
  });

  it('c. troca de escopo invalida os aceites (checkboxes voltam a false)', async () => {
    setupSeries(seriesOccurrence(), { this: impactPosted, this_and_next: impactPosted });
    renderEditor();
    const save = screen.getByRole('button', { name: /Salvar Alterações/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    fireEvent.click(await waitFor(() => screen.getByRole('checkbox')));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Aplicar a'), { target: { value: 'this_and_next' } });
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(save.disabled).toBe(true);
  });

  it('d. coletivo este_and_next: continua exigindo marcação explícita e envia as flags', async () => {
    setupSeries(seriesOccurrence(), { this_and_next: { ...impactPast, ...impactPosted } });
    renderEditor();
    const save = screen.getByRole('button', { name: /Salvar Alterações/ }) as HTMLButtonElement;
    fireEvent.change(await waitFor(() => screen.getByLabelText('Aplicar a')), { target: { value: 'this_and_next' } });
    await waitFor(() => expect(save.disabled).toBe(true));
    const boxes = await waitFor(() => screen.getAllByRole('checkbox'));
    expect(boxes).toHaveLength(2);
    expect(await waitFor(() => screen.getByText('Confirmo que desejo alterar também ocorrências passadas. Ocorrências editadas individualmente entram na operação e são informadas na prévia.'))).toBeTruthy();
    boxes.forEach((b) => fireEvent.click(b));
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'transaction_series_edit',
        expect.objectContaining({ p_confirm_posted: true, p_confirm_past: true, p_confirm_edited: false }),
      ),
    );
  });

  it('e. prévia com erro: mostra erro e bloqueia o save (nenhum RPC de edição)', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'transaction_series_occurrences') return queryBuilder(seriesOccurrence());
      return queryBuilder({ data: [], error: null });
    });
    mockSupabase.rpc.mockImplementation(async (name: string) => {
      if (name === 'series_scope_impact') return { data: null, error: { message: 'falha simulada' } };
      if (name === 'account_usage_stats') return { data: [], error: null };
      if (name === 'transaction_get_detail') return { data: detailFor('posted'), error: null };
      return { data: null, error: { message: 'RPC inesperado: ' + name } };
    });
    renderEditor();
    const save = screen.getByRole('button', { name: /Salvar Alterações/ }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/Não foi possível calcular o impacto desta operação/)).toBeTruthy());
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('transaction_series_edit', expect.anything());
  });
});

describe('E10F — exclusão em "this": confirmação vem SÓ do aceite explícito', () => {
  const renderDelete = () =>
    render(
      <DeleteConfirmation
        transaction={{
          id: 'tx-1',
          raw_description: 'Parcela do curso',
          occurred_on: '2026-06-15',
          amount: '12.50',
          transaction_kind: 'expense',
          account_id: 'acc-1',
          accounts: null,
        }}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );

  it('f. sem aceite em "this": botão desabilitado e transaction_series_delete NÃO é chamado; com aceite, envia a flag', async () => {
    setupSeries(seriesOccurrence(), { this: impactPosted });
    renderDelete();
    const del = screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement;
    await waitFor(() => expect(del.disabled).toBe(true));
    expect(await waitFor(() => screen.getByText('Confirmo que desejo excluir esta ocorrência com status posted (paga/postada).'))).toBeTruthy();
    fireEvent.click(del);
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('transaction_series_delete', expect.anything());

    fireEvent.click(await waitFor(() => screen.getByRole('checkbox')));
    await waitFor(() => expect(del.disabled).toBe(false));
    fireEvent.click(del);
    await waitFor(() =>
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'transaction_series_delete',
        expect.objectContaining({ p_scope: 'this', p_confirm_posted: true, p_confirm_past: false, p_confirm_edited: false }),
      ),
    );
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('transaction_delete', expect.anything());
  });

  it('d. coletivo whole: checkboxes plurais e flags enviadas após marcação', async () => {
    setupSeries(seriesOccurrence(), { whole: { ...impactPast, ...impactPosted, ...impactEdited } });
    renderDelete();
    const del = screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement;
    await waitFor(() => expect(del.disabled).toBe(true));
    fireEvent.change(screen.getByTestId('delete-series-scope'), { target: { value: 'whole' } });
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3));
    expect(screen.getByText('Confirmo que desejo excluir também ocorrências passadas.')).toBeTruthy();
    screen.getAllByRole('checkbox').forEach((b) => fireEvent.click(b));
    await waitFor(() => expect(del.disabled).toBe(false));
    fireEvent.click(del);
    await waitFor(() =>
      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'transaction_series_delete',
        expect.objectContaining({
          p_scope: 'whole',
          p_confirm_past: true,
          p_confirm_posted: true,
          p_confirm_edited: true,
        }),
      ),
    );
  });

  it('e. prévia com erro: bloqueia a exclusão e mostra o erro', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'transaction_series_occurrences') return queryBuilder(seriesOccurrence());
      return queryBuilder({ data: [], error: null });
    });
    mockSupabase.rpc.mockImplementation(async (name: string) => {
      if (name === 'series_scope_impact') return { data: null, error: { message: 'falha simulada' } };
      if (name === 'transaction_get_detail') return { data: { transaction: { updated_at: 'tx-ts' } }, error: null };
      return { data: null, error: { message: 'RPC inesperado: ' + name } };
    });
    renderDelete();
    const del = screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByTestId('delete-series-impact-error')).toBeTruthy());
    expect(del.disabled).toBe(true);
    fireEvent.click(del);
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('transaction_series_delete', expect.anything());
  });
});