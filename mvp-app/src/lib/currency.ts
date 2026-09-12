// currency.ts — Utilitários de moeda para campos monetários (PESSOAL-10).
// Convenção de entrada bancária: o usuário digita algarismos que "fluem" como
// centavos (teclar "1" -> R$ 0,01; "23" -> R$ 0,23; "456" -> R$ 4,56).
// A saída emitida é sempre o texto pt-BR sem símbolo ("49,84" / "1.234,56"),
// compatível com parseAmount do TransactionEditor.

export const CURRENCY_MAX_DIGITS = 13;

/** Remove tudo que não for dígito. "R$ 1.234,56" -> "123456"; vazio -> "". */
export function valueToDigits(value: string): string {
  if (!value) return '';
  return String(value).replace(/\D/g, '');
}

/** Normaliza uma colagem arbitrária de texto em dígitos (com teto). */
export function pasteToDigits(text: string): string {
  return valueToDigits(text).slice(0, CURRENCY_MAX_DIGITS);
}

/** Acrescenta um algarismo (apenas char dígito), respeitando o teto. */
export function appendDigit(digits: string, ch: string): string {
  if (!/^\d$/.test(ch)) return digits;
  return valueToDigits(digits + ch).slice(0, CURRENCY_MAX_DIGITS);
}

/** Remove o último algarismo ("" -> ""). */
export function removeLastDigit(digits: string): string {
  return digits.slice(0, -1);
}

/**
 * Inteiro de centavos a partir de uma string de dígitos.
 * "" -> 0; "0012" -> 12 (R$ 0,12); "123456" -> 123456 (R$ 1.234,56).
 */
export function digitsToCents(digits: string): number {
  const d = valueToDigits(digits);
  if (!d) return 0;
  return Number(d) || 0;
}

/** De um número real para centavos inteiros (arredondamento determinístico). */
export function decimalToCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** Centavos -> texto pt-BR SEM símbolo ("49,84" / "1.234,56"). */
export function formatCurrencyBRL(cents: number): string {
  const real = cents / 100;
  return real.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Centavos -> texto completo de exibição bancária ("R$ 49,84"). */
export function formatCurrencyBRLWithSymbol(cents: number): string {
  return `R$ ${formatCurrencyBRL(cents)}`;
}