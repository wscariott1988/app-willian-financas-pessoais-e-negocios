import React from 'react';
import { CURRENCY_MAX_DIGITS, digitsToCents, formatCurrencyBRL, formatCurrencyBRLWithSymbol, valueToDigits } from '../lib/currency';

interface CurrencyInputProps {
  id?: string;
  /** Texto pt-BR sem símbolo, formatado pelo componente pai ("49,84" / "1.234,56"). */
  value: string;
  /** Emite o texto pt-BR sem símbolo compatível com parseAmount. */
  onValueChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

/**
 * Campo monetário com centavos automáticos (entrada bancária): o usuário digita
 * algarismos que fluem como centavos; a exibição é sempre "R$ 1.234,56" e a
 * saída (onValueChange) é o mesmo valor em texto pt-BR sem símbolo.
 */
export const CurrencyInput: React.FC<CurrencyInputProps> = ({ id, value, onValueChange, placeholder, disabled, style }) => {
  const shown = formatCurrencyBRLWithSymbol(digitsToCents(valueToDigits(value)));

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = valueToDigits(e.target.value).slice(0, CURRENCY_MAX_DIGITS);
    onValueChange(formatCurrencyBRL(digitsToCents(next)));
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={shown}
      onChange={handleChange}
      disabled={disabled}
      placeholder={placeholder ?? '0,00'}
      style={style}
    />
  );
};