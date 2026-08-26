// status.ts — Vocabulário público de status de transações (STATUS-P0/P0b).
// Regra de produto: a partir do cutoff, o usuário enxerga somente Pago/Não pago.
//   Pago    => posted
//   Não pago => pending
// Status legados (review/scheduled/ignored) NÃO são normalizados no banco; a UI
// os apresenta como "Não pago" visualmente e os preserva no payload a menos que
// o usuário altere explicitamente o controle.

export const STATUS_EDITABLE_FROM = '2026-08-01';

export type EditableStatus = 'posted' | 'pending';

export const STATUS_OPTIONS: ReadonlyArray<{ value: EditableStatus; label: string }> = [
  { value: 'posted', label: 'Pago' },
  { value: 'pending', label: 'Não pago' },
];

// Conjunto operacional de "não pago": todos os status ativos não-posted
// permitidos pelo CHECK do schema. Apresentação e filtros usam SOMENTE esta
// lista (nada de comparações soltas por componente).
export const NON_PAID_STATUSES: readonly string[] = ['pending', 'review', 'scheduled', 'ignored'];

export function statusOptionLabel(status: string | null | undefined): string | null {
  for (const o of STATUS_OPTIONS) {
    if (o.value === status) return o.label;
  }
  return null;
}

// Controle de status editável somente a partir do cutoff (e em data ainda não
// informada, para formulários novos). Antes do cutoff o controle fica oculto.
export function isStatusEditable(occurredOn: string): boolean {
  return !occurredOn || occurredOn >= STATUS_EDITABLE_FROM;
}

// Visibilidade operacional de status em linhas/registros: nenhum status
// operacional é exibido antes do cutoff (a data sempre existe em linhas reais).
export function isStatusOperationalVisible(occurredOn: string): boolean {
  return !!occurredOn && occurredOn >= STATUS_EDITABLE_FROM;
}

export function isPaidStatus(status: string | null | undefined): boolean {
  return status === 'posted';
}

// Rótulo único para toda a UI: Pago / Não pago a partir do cutoff; null antes
// (nenhum label operacional). Status desconhecido não-posted também é exibido
// como Não pago visualmente, mas permanece audível via NON_PAID_STATUSES/testes
// e NUNCA vira escrita automática.
export function displayPaymentStatus(status: string | null | undefined, occurredOn: string): string | null {
  if (!isStatusOperationalVisible(occurredOn)) return null;
  return isPaidStatus(status) ? 'Pago' : 'Não pago';
}

// Valor EXIBIDO no select de 2 opções: posted => Pago; qualquer outro valor
// (pending, review, scheduled, ignored, legado) exibe "Não pago" SEM alterar o
// valor real do form — a preservação do status original é garantida no payload.
export function displayStatusValue(status: string | null | undefined): EditableStatus {
  return status === 'posted' ? 'posted' : 'pending';
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}