// identityGate.ts — Portão de identidade para o endpoint (PESSOAL-13C2A.1).
//
// O ask.ts nunca referencia o conceito por nome (regra de arquitetura: o
// endpoint não transmite nem conhece identificadores de perfil). Este módulo
// encapsula a regra canônica (server/auth/profileIdentity.ts) atrás de um
// predicado neutro:
//
//   trustedIdentityMissing(user, env)
//     - sem usuário autenticado: NÃO é um caso de "identidade ausente" aqui
//       (o fluxo de token já falhou antes) — retorna false;
//     - usuário sem identidade confiável (produção: app_metadata; fora de
//       produção aceita também o legado user_metadata): retorna true → o
//       endpoint responde 403 e NUNCA escolhe um perfil padrão.
import { profileIdFromAuthUser, isProdServerEnv } from './profileIdentity.js';

export interface AuthEnvironmentLike {
  VERCEL?: string;
  VERCEL_ENV?: string;
  NODE_ENV?: string;
}

export interface AuthUserLike {
  id?: string;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

export function trustedIdentityMissing(
  user: AuthUserLike | null | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (!user) return false;
  return (
    profileIdFromAuthUser(user, {
      allowLegacy: !isProdServerEnv(env),
    }) === null
  );
}