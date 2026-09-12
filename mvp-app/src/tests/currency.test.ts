import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import {
  CURRENCY_MAX_DIGITS,
  appendDigit,
  decimalToCents,
  digitsToCents,
  formatCurrencyBRL,
  formatCurrencyBRLWithSymbol,
  pasteToDigits,
  removeLastDigit,
  valueToDigits,
} from '../lib/currency';
import { CurrencyInput } from '../components/CurrencyInput';
import { parseAmount } from '../components/TransactionEditor';

vi.mock('../supabaseClient', () => ({ supabase: {} }));

describe('currency — valueToDigits', () => {
  it('remove símbolo e separadores, mantendo apenas dígitos', () => {
    expect(valueToDigits('R$ 1.234,56')).toBe('123456');
    expect(valueToDigits('49,84')).toBe('4984');
    expect(valueToDigits('0,00')).toBe('000');
    expect(valueToDigits('')).toBe('');
    expect(valueToDigits('abc')).toBe('');
  });
});

describe('currency — entrada bancária (centavos automáticos)', () => {
  it('appendDigit: algarismos fluem como centavos', () => {
    expect(appendDigit('', '1')).toBe('1');
    expect(appendDigit('1', '2')).toBe('12');
    expect(appendDigit('12', '3')).toBe('123');
  });

  it('appendDigit ignora não-dígitos', () => {
    expect(appendDigit('12', 'a')).toBe('12');
    expect(appendDigit('12', ',')).toBe('12');
    expect(appendDigit('12', '')).toBe('12');
  });

  it('removeLastDigit apaga o último algarismo', () => {
    expect(removeLastDigit('123')).toBe('12');
    expect(removeLastDigit('1')).toBe('');
    expect(removeLastDigit('')).toBe('');
  });

  it('respeita o teto de dígitos (CURRENCY_MAX_DIGITS)', () => {
    const long = '1'.repeat(CURRENCY_MAX_DIGITS + 5);
    expect(pasteToDigits(long).length).toBe(CURRENCY_MAX_DIGITS);
    expect(appendDigit('1'.repeat(CURRENCY_MAX_DIGITS), '9').length).toBe(CURRENCY_MAX_DIGITS);
  });

  it('pasteToDigits normaliza colagens com símbolo e separadores', () => {
    expect(pasteToDigits('R$ 250,50')).toBe('25050');
    expect(pasteToDigits('12.345,67')).toBe('1234567');
  });
});

describe('currency — conversões e formatação', () => {
  it('digitsToCents: dígitos -> centavos inteiros', () => {
    expect(digitsToCents('')).toBe(0);
    expect(digitsToCents('0012')).toBe(12);
    expect(digitsToCents('123456')).toBe(123456);
  });

  it('decimalToCents arredonda de forma determinística', () => {
    expect(decimalToCents(49.836)).toBe(4984);
    expect(decimalToCents(0.1)).toBe(10);
    expect(decimalToCents(NaN)).toBe(0);
  });

  it('formatCurrencyBRL: centavos -> texto pt-BR sem símbolo', () => {
    expect(formatCurrencyBRL(4984)).toBe('49,84');
    expect(formatCurrencyBRL(123456)).toBe('1.234,56');
    expect(formatCurrencyBRL(1)).toBe('0,01');
    expect(formatCurrencyBRL(0)).toBe('0,00');
  });

  it('formatCurrencyBRLWithSymbol: exibição bancária completa', () => {
    expect(formatCurrencyBRLWithSymbol(4984)).toBe('R$ 49,84');
    expect(formatCurrencyBRLWithSymbol(123456)).toBe('R$ 1.234,56');
  });

  it('saída emitida é compatível com parseAmount (TransactionEditor)', () => {
    const emitted = formatCurrencyBRL(digitsToCents(pasteToDigits('R$ 49,84')));
    expect(emitted).toBe('49,84');
    expect(parseAmount(emitted)).toBe(49.84);
  });
});

describe('CurrencyInput (SSR)', () => {
  it('renderiza o valor formatado com símbolo e o id preservado', () => {
    const html = renderToString(
      h(CurrencyInput, {
        id: 'te-amount',
        value: '49,84',
        onValueChange: () => {},
      }),
    );
    expect(html).toContain('id="te-amount"');
    expect(html).toContain('value="R$ 49,84"');
    expect(html).toContain('inputMode="numeric"');
  });

  it('disabled=true marca o campo como desabilitado (valor bloqueado em parcelas)', () => {
    const html = renderToString(
      h(CurrencyInput, {
        id: 'te-amount',
        value: '49,84',
        onValueChange: () => {},
        disabled: true,
      }),
    );
    expect(html).toContain('disabled');
    expect(html).toContain('value="R$ 49,84"');
  });
});

// A mesma cadeia que o CurrencyInput usa em `shown`/`onValueChange`:
//   shown  = formatCurrencyBRLWithSymbol(digitsToCents(valueToDigits(value)))
//   emitir = formatCurrencyBRL(digitsToCents(valueToDigits(next)))
describe('PESSOAL-10 — CurrencyInput (entrada bancária ponta a ponta)', () => {
  const shown = (value: string) => formatCurrencyBRLWithSymbol(digitsToCents(valueToDigits(value)));
  const emit = (value: string) => formatCurrencyBRL(digitsToCents(valueToDigits(value)));

  it('sequência de algarismos fluem como centavos na exibição', () => {
    expect(shown('1')).toBe('R$ 0,01');
    expect(shown('10')).toBe('R$ 0,10');
    expect(shown('100')).toBe('R$ 1,00');
    expect(shown('1000')).toBe('R$ 10,00');
    expect(shown('123456')).toBe('R$ 1.234,56');
  });

  it('backspace desloca centavos corretamente', () => {
    expect(shown(removeLastDigit('123456'))).toBe('R$ 123,45');
    expect(shown(removeLastDigit('10'))).toBe('R$ 0,01');
    expect(shown(removeLastDigit('1'))).toBe('R$ 0,00');
    expect(removeLastDigit('')).toBe('');
  });

  it('valor existente "49,84" abre como R$ 49,84', () => {
    expect(shown('49,84')).toBe('R$ 49,84');
    expect(shown('')) .toBe('R$ 0,00');
  });

  it('o valor enviado a parseAmount continua correto', () => {
    expect(parseAmount(emit('R$ 49,84'))).toBe(49.84);
    expect(parseAmount(emit('R$ 1.234,56'))).toBe(1234.56);
    expect(parseAmount(emit('R$ 0,01'))).toBe(0.01);
  });
});