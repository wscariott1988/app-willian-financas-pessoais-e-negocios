import { describe, it, expect } from 'vitest';
import { accountDisplayLabel } from '../lib/accountCrud';

describe('F-02 — nunca expor UUID/identificador técnico de conta', () => {
  it('retorna o display_name quando presente', () => {
    expect(accountDisplayLabel({ display_name: 'Nubank' })).toBe('Nubank');
    expect(accountDisplayLabel({ display_name: 'Itaú' })).toBe('Itaú');
  });

  it('retorna placeholder amigável quando a conta é nula/indefinida', () => {
    expect(accountDisplayLabel(null)).toBe('Conta indisponível');
    expect(accountDisplayLabel(undefined)).toBe('Conta indisponível');
  });

  it('retorna placeholder amigável quando display_name é vazio ou só espaços', () => {
    expect(accountDisplayLabel({ display_name: '' })).toBe('Conta indisponível');
    expect(accountDisplayLabel({ display_name: '   ' })).toBe('Conta indisponível');
  });

  it('join com nome null/undefined => fallback (não expõe id)', () => {
    expect(accountDisplayLabel({ display_name: null })).toBe('Conta indisponível');
    expect(accountDisplayLabel({ display_name: undefined })).toBe('Conta indisponível');
  });

  it('aceita fallback customizado', () => {
    expect(accountDisplayLabel(null, 'Conta não encontrada')).toBe('Conta não encontrada');
  });

  it('nunca devolve fragmento de UUID (não deriva do id do chamador)', () => {
    // O helper não recebe account_id; garante que nenhum valor parecido com
    // UUID ou slice técnico é produzido.
    const result = accountDisplayLabel(null);
    expect(result).not.toMatch(/^[0-9a-f]{8}/i);
    expect(result).not.toMatch(/-/);
  });
});
