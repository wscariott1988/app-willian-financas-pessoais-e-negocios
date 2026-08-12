import React from 'react';
import { ChevronLeft, ChevronRight, CalendarRange, CalendarCheck } from 'lucide-react';
import {
  type PeriodMode,
  type PeriodRange,
  type PeriodSelection,
  PERIOD_MODES,
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
}

export const PeriodSelector: React.FC<PeriodSelectorProps> = ({
  selection,
  mode,
  range,
  onSelectionChange,
  onModeChange,
}) => {
  const isCurrentMonth = (() => {
    const now = selectionFromDate(new Date());
    return now.year === selection.year && now.month === selection.month;
  })();

  return (
    <div className="glass period-selector">
      <div className="period-selector-main">
        <div className="period-label">
          <CalendarRange size={16} style={{ color: 'var(--color-primary)' }} />
          <span className="period-label-text">Período</span>
        </div>

        <div className="period-nav">
          <button
            className="btn-secondary period-nav-btn"
            onClick={() => onSelectionChange(addMonths(selection, -1))}
            title="Mês anterior"
            aria-label="Mês anterior"
          >
            <ChevronLeft size={16} />
          </button>

          <span className="period-month-label">{formatMonthLabel(selection)}</span>

          <button
            className="btn-secondary period-nav-btn"
            onClick={() => onSelectionChange(addMonths(selection, 1))}
            title="Mês seguinte"
            aria-label="Mês seguinte"
          >
            <ChevronRight size={16} />
          </button>

          <button
            className="btn-secondary period-today-btn"
            onClick={() => onSelectionChange(selectionFromDate(new Date()))}
            disabled={isCurrentMonth}
            title="Voltar ao mês atual"
          >
            <CalendarCheck size={14} />
            Mês atual
          </button>
        </div>

        <div className="period-modes" role="group" aria-label="Modo de período">
          {PERIOD_MODES.map((m) => (
            <button
              key={m.id}
              className={`period-mode-btn ${mode === m.id ? 'active' : ''}`}
              onClick={() => onModeChange(m.id)}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="period-range-applied">
        <span className="period-range-title">Datas aplicadas</span>
        <span className="period-range-dates">
          {formatShortDate(range.start)} → {formatShortDate(range.end)}
        </span>
      </div>
    </div>
  );
};
