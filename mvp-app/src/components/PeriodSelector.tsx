import React from 'react';
import { ChevronLeft, ChevronRight, CalendarRange } from 'lucide-react';
import {
  type PeriodMode,
  type PeriodRange,
  type PeriodSelection,
  addMonths,
  formatMonthLabel,
  formatShortDate,
  selectionFromDate,
} from '../lib/period';

interface PeriodSelectorProps {
  selection: PeriodSelection;
  mode: PeriodMode;
  range: PeriodRange;
  onSelectionChange: (sel: PeriodSelection) => void;
  onModeChange: (mode: PeriodMode) => void;
  onPickerOpen?: () => void;
  onCustomReset?: () => void;
}

const MODE_LABELS: Record<PeriodMode, string> = {
  up_to_today: 'Até hoje',
  today_to_end: 'Até o fim do mês',
  full_month: 'Mês todo',
};

export const PeriodSelector: React.FC<PeriodSelectorProps> = ({
  selection,
  mode,
  range,
  onSelectionChange,
  onModeChange,
  onPickerOpen,
  onCustomReset,
}) => {
  const today = new Date();
  const isCurrentMonth = (() => {
    const now = selectionFromDate(today);
    return now.year === selection.year && now.month === selection.month;
  })();
  const isCustom = mode === 'custom';

  const modes: PeriodMode[] = ['up_to_today', 'today_to_end', 'full_month'];

  const handleArrowClick = (delta: number) => {
    if (isCustom) onCustomReset?.();
    onSelectionChange(addMonths(selection, delta));
  };

  const handleMonthActual = () => {
    if (isCustom) onCustomReset?.();
    onSelectionChange(selectionFromDate(today));
  };

  const handleModeChange = (m: PeriodMode) => {
    if (isCustom) onCustomReset?.();
    onModeChange(m);
  };

  return (
    <div className="period-selector">
      <div className="period-nav">
        <button
          type="button"
          className="period-nav-btn"
          onClick={() => handleArrowClick(-1)}
          title="Mês anterior"
          aria-label="Mês anterior"
        >
          <ChevronLeft size={20} />
        </button>

        <span className="period-month-label">{formatMonthLabel(selection)}</span>

        <button
          type="button"
          className="period-nav-btn"
          onClick={() => handleArrowClick(1)}
          title="Mês seguinte"
          aria-label="Mês seguinte"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      <div className="period-today-row">
        <button
          type="button"
          className="period-today-btn"
          onClick={handleMonthActual}
          disabled={!isCustom && isCurrentMonth}
          title="Voltar ao mês atual"
        >
          Mês atual
        </button>
      </div>

      <div className="period-modes" role="group" aria-label="Modo de período">
        {modes.map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              className={`period-mode-btn ${active ? 'active' : ''}`}
              aria-pressed={active}
              onClick={() => handleModeChange(m)}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}
      </div>

      {onPickerOpen ? (
        <button
          type="button"
          className={`period-range-applied ${isCustom ? 'period-range-custom' : ''}`}
          onClick={onPickerOpen}
          aria-label="Escolher período personalizado"
        >
          <CalendarRange size={14} style={{ color: 'var(--color-primary)' }} />
          <span className="period-range-title">
            {isCustom ? 'Período personalizado' : 'Período aplicado'}
          </span>
          <span className="period-range-dates">
            {formatShortDate(range.start)} → {formatShortDate(range.end)}
          </span>
        </button>
      ) : (
        <div className="period-range-applied">
          <CalendarRange size={14} style={{ color: 'var(--color-primary)' }} />
          <span className="period-range-title">Período aplicado</span>
          <span className="period-range-dates">
            {formatShortDate(range.start)} → {formatShortDate(range.end)}
          </span>
        </div>
      )}
    </div>
  );
};
