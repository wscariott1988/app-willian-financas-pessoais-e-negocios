// usePeriodController.ts — Hook de período isolado por contexto (tela).
// Cada instância tem a própria seleção/modo/período personalizado e nunca
// compartilha estado com outras telas (PESSOAL-12).
import { useMemo, useReducer } from 'react';
import {
  createPeriodState,
  periodReducer,
  type PeriodController,
} from '../lib/periodController';
import { computePeriodRange, type PeriodMode } from '../lib/period';

export function usePeriodController(defaultMode: PeriodMode) {
  const [state, dispatch] = useReducer(periodReducer, defaultMode, createPeriodState);
  const { selection, mode, customStart, customEnd } = state;

  const monthRange = useMemo(
    () => computePeriodRange(selection, mode, new Date()),
    [selection, mode],
  );
  // Em modo não-custom o range é o objeto memoizado (identidade estável → sem
  // re-render/refetch em cadeia); em custom, o range vem das datas escolhidas.
  const range = mode === 'custom' && customStart && customEnd
    ? { start: customStart, end: customEnd }
    : monthRange;

  const controller = useMemo<PeriodController>(
    () => ({
      selection,
      mode,
      range,
      onSelectionChange: (sel) => dispatch({ type: 'selection_change', selection: sel }),
      onModeChange: (m) => dispatch({ type: 'mode_change', mode: m }),
      onCustomApply: (start, end) => dispatch({ type: 'custom_apply', start, end }),
      onCustomReset: () => dispatch({ type: 'custom_reset' }),
      onPickerOpen: () => dispatch({ type: 'picker_open' }),
    }),
    [selection, mode, range],
  );

  return {
    controller,
    pickerOpen: state.pickerOpen,
    closePicker: () => dispatch({ type: 'picker_close' }),
    customStart,
    customEnd,
  };
}