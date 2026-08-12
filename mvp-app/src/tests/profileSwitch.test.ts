import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  targetProfileLabel,
  switchButtonLabel,
  loginNoticeMessage,
  signOutAndReturn,
  type AuthLike,
} from '../lib/profileSwitch';

const here = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

describe('botão de troca de perfil', () => {
  it('1) texto do botão conforme o perfil ativo', () => {
    expect(switchButtonLabel('personal')).toBe('Trocar para Negócio');
    expect(switchButtonLabel('business')).toBe('Trocar para Pessoal');
    expect(targetProfileLabel('personal')).toBe('Negócio');
    expect(targetProfileLabel('business')).toBe('Pessoal');
  });

  it('2) troca chama signOut oficial e retorna ao login (onDone)', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    const auth: AuthLike = { signOut };
    const onDone = vi.fn();

    await signOutAndReturn(auth, onDone);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('2b) erro no signOut propaga e não retorna ao login', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('falha no signOut'));
    const auth: AuthLike = { signOut };
    const onDone = vi.fn();

    await expect(signOutAndReturn(auth, onDone)).rejects.toThrow('falha no signOut');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('3) nenhuma senha ou token é armazenado (sem storage no código de troca)', () => {
    const switcherSource = readSource('components/ProfileSwitcher.tsx');
    const libSource = readSource('lib/profileSwitch.ts');
    const appSource = readSource('App.tsx');

    for (const source of [switcherSource, libSource, appSource]) {
      expect(source).not.toMatch(/localStorage\.(set|remove)Item/);
      expect(source).not.toMatch(/sessionStorage\.(set|remove)Item/);
      expect(source).not.toMatch(/document\.cookie/);
    }
  });

  it('4) mensagem indica qual perfil deve ser usado no próximo login', () => {
    expect(loginNoticeMessage('personal')).toBe('Entre com o usuário do perfil Negócio');
    expect(loginNoticeMessage('business')).toBe('Entre com o usuário do perfil Pessoal');
  });
});

describe('sem credenciais de produção no bundle de troca', () => {
  it('emails e senhas fixos permanecem exclusivos de DEV', () => {
    const switcherSource = readSource('components/ProfileSwitcher.tsx');
    const loginSource = readSource('components/Login.tsx');
    const switchLibSource = readSource('lib/profileSwitch.ts');

    // Credenciais de seed só existem atrás de import.meta.env.DEV
    for (const source of [switcherSource, loginSource]) {
      expect(source).toMatch(/import\.meta\.env\.DEV/);
    }

    // Nenhum email com domínio real em texto puro (placeholders como
    // seuemail@exemplo.com são permitidos)
    const emailRe = /[\w.+-]+@[\w-]+\.(com|br|net|org|io)(\.br)?/g;
    for (const source of [switcherSource, loginSource]) {
      const emails = (source.match(emailRe) ?? []).filter((e) => !e.includes('exemplo.com'));
      expect(emails).toEqual([]);
    }

    // Nenhuma senha literal
    for (const source of [switcherSource, loginSource]) {
      expect(source).not.toMatch(/password\s*[:=]\s*['"][^'"]+/i);
      expect(source).not.toMatch(/senha\s*[:=]\s*['"][^'"]+/i);
    }

    // O fluxo de troca em produção (módulo puro) não autentica ninguém
    expect(switchLibSource).not.toMatch(/signInWithPassword|service_role|access_token/);
  });
});
