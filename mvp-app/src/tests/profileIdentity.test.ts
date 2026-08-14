import { describe, it, expect } from 'vitest';
import { resolveProfileCode, resolveProfileId, isValidProfileId } from '../lib/profileIdentity';

const VALID = '5a57e1cb-d147-5cf6-9fde-5ba982dc716c';

describe('profileIdentity — perfil confiável (1.2A.4B.2)', () => {
  it('1) perfil vem primeiro de app_metadata', () => {
    const session = {
      user: {
        app_metadata: { profile_id: VALID, profile_code: 'personal' },
        user_metadata: { profile_id: '11111111-1111-1111-1111-111111111111', profile_code: 'business' },
      },
    };
    expect(resolveProfileId(session, { isDev: false })).toBe(VALID);
    expect(resolveProfileCode(session, { isDev: false })).toBe('personal');
  });

  it('2) user_metadata não prevalece sobre app_metadata', () => {
    const session = {
      user: {
        app_metadata: { profile_id: VALID },
        user_metadata: { profile_id: '22222222-2222-2222-2222-222222222222' },
      },
    };
    expect(resolveProfileId(session, { isDev: true })).toBe(VALID);
  });

  it('3) fallback legado (user_metadata) só funciona em DEV', () => {
    const session = {
      user: {
        app_metadata: {},
        user_metadata: { profile_id: VALID, profile_code: 'business' },
      },
    };
    expect(resolveProfileId(session, { isDev: false })).toBeNull();
    expect(resolveProfileId(session, { isDev: true })).toBe(VALID);
    expect(resolveProfileCode(session, { isDev: false })).toBeNull();
    expect(resolveProfileCode(session, { isDev: true })).toBe('business');
  });

  it('4) ausência de perfil impede a identificação', () => {
    expect(resolveProfileId(null)).toBeNull();
    expect(resolveProfileId({ user: {} })).toBeNull();
    expect(resolveProfileId({ user: { app_metadata: {} } }, { isDev: true })).toBeNull();
    expect(resolveProfileCode({ user: {} })).toBeNull();
  });

  it('5) UUID inválido impede a identificação (mesmo em DEV)', () => {
    const session = {
      user: {
        app_metadata: { profile_id: 'nao-e-um-uuid', profile_code: 'personal' },
        user_metadata: { profile_id: 'tambem-invalido' },
      },
    };
    expect(resolveProfileId(session, { isDev: true })).toBeNull();
    expect(isValidProfileId('abc')).toBe(false);
    expect(isValidProfileId(VALID)).toBe(true);
    expect(isValidProfileId(12345)).toBe(false);
  });
});
