// periodController.ts — Estado de período por contexto (tela).
// PESSOAL-12: cada aba (Início / Transações / Análises) mantém a própria
// seleção e o próprio modo de período, com um default por contexto. Nada é
// compartilhado entre telas — trocar o período em uma nunca afeta as demais.
import {
  selectionFromDate,
  type PeriodMode,
  type PeriodRange,
  type PeriodSelection,
} from './period';

export type PeriodContextId = 'inicio' | 'transacoes' | 'analises';

// Default de período por aba (regra de produto PESSOAL-12):
// - Início: continua abrindo em "Até hoje" (comportamento histórico preservado);
// - Transações: ao entrar/clicar na aba, abre inicialmente em "Mês todo";
// - Análises: ao entrar/clicar na aba, abre inicialmente em "Mês todo".
// "Mês todo" significa 01/MM/AAAA → último dia do mês selecionado.
export const PERIOD_DEFAULT_MODES: Readonly<Record<PeriodContextId, PeriodMode>> = {
  inicio: 'up_to_today',
  transacoes: 'full_month',
  analises: 'full_month',
};

export interface PeriodController {
  selection: PeriodSelection;
  mode: PeriodMode;
  range: PeriodRange;
  onSelectionChange: (sel: PeriodSelection) => void;
  onModeChange: (mode: PeriodMode) => void;
  onCustomApply: (start: string, end: string) => void;
  onCustomReset: () => void;
  onPickerOpen: () => void;
}

export interface PeriodState {
  selection: PeriodSelection;
  mode: PeriodMode;
  customStart: string;
  customEnd: string;
  pickerOpen: boolean;
}

export type PeriodAction =
  | { type: 'selection_change'; selection: PeriodSelection }
  | { type: 'mode_change'; mode: PeriodMode }
  | { type: 'custom_apply'; start: string; end: string }
  | { type: 'custom_reset' }
  | { type: 'picker_open' }
  | { type: 'picker_close' };

export function createPeriodState(defaultMode: PeriodMode, today: Date = new Date()): PeriodState {
  return {
    selection: selectionFromDate(today),
    mode: defaultMode,
    customStart: '',
    customEnd: '',
    pickerOpen: false,
  };
}

export function periodReducer(state: PeriodState, action: PeriodAction): PeriodState {
  switch (action.type) {
    case 'selection_change':
      return { ...state, selection: action.selection };
    case 'mode_change':
      return { ...state, mode: action.mode };
    case 'custom_apply':
      return { ...state, customStart: action.start, customEnd: action.end, mode: 'custom', pickerOpen: false };
    case 'custom_reset':
      // Mesmo contrato histórico do AppShell: volta ao mês atual em "Até hoje".
      return { ...state, selection: selectionFromDate(new Date()), mode: 'up_to_today', pickerOpen: false };
    case 'picker_open':
      return { ...state, pickerOpen: true };
    case 'picker_close':
      return { ...state, pickerOpen: false };
    default:
      return state;
  }
}