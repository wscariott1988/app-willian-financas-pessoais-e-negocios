import React, { useState, useEffect, useCallback } from 'react';
import { CalendarRange, AlertCircle, RotateCcw } from 'lucide-react';
import { Modal } from './Modal';
import { validateCustomRange } from '../lib/period';

interface PeriodPickerProps {
  open: boolean;
  onClose: () => void;
  onApply: (start: string, end: string) => void;
  currentStart?: string;
  currentEnd?: string;
}

export const PeriodPicker: React.FC<PeriodPickerProps> = ({
  open,
  onClose,
  onApply,
  currentStart,
  currentEnd,
}) => {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setStart(currentStart ?? '');
      setEnd(currentEnd ?? '');
      setError('');
    }
  }, [open, currentStart, currentEnd]);

  const handleApply = useCallback(() => {
    const result = validateCustomRange(start, end);
    if (!result.valid) {
      setError(result.error!);
      return;
    }
    onApply(start, end);
  }, [start, end, onApply]);

  const handleReset = useCallback(() => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    onApply(`${y}-${m}-01`, `${y}-${m}-${d}`);
  }, [onApply]);

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Escolher período">
      <div className="period-picker">
        <div className="period-picker-header">
          <CalendarRange size={20} style={{ color: 'var(--color-primary)' }} />
          <h2>Escolher período</h2>
        </div>

        <div className="period-picker-fields">
          <label className="period-picker-label">
            <span>Data inicial</span>
            <input
              type="date"
              className="period-picker-input"
              value={start}
              onChange={(e) => { setStart(e.target.value); setError(''); }}
              aria-label="Data inicial"
              max={end || undefined}
            />
          </label>
          <label className="period-picker-label">
            <span>Data final</span>
            <input
              type="date"
              className="period-picker-input"
              value={end}
              onChange={(e) => { setEnd(e.target.value); setError(''); }}
              aria-label="Data final"
              min={start || undefined}
            />
          </label>
        </div>

        {error && (
          <div className="period-picker-error" role="alert">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="period-picker-actions">
          <button
            type="button"
            className="btn-secondary period-picker-btn"
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn-secondary period-picker-btn"
            onClick={handleReset}
            title="Restaurar do dia 1 até hoje"
          >
            <RotateCcw size={14} />
            Voltar ao mês atual
          </button>
          <button
            type="button"
            className="btn-primary period-picker-btn"
            onClick={handleApply}
          >
            Aplicar
          </button>
        </div>
      </div>
    </Modal>
  );
};
