// server/auth/profileIdentity.ts — Identidade de perfil SERVER-side (PESSOAL-13C2A.1).
// Segue o MESMO padrão canônico do browser (src/lib/profileIdentity.ts), sem a
// dependência de build (import.meta.env):
//   - em PRODUÇÃO aceita APENAS app_metadata.profile_id (fonte confiável
//     gravada pelo trigger handle_new_user — 007_cloud_compat);
//   - o fallback legado (user_metadata, controlável pelo usuário) é aceito
//     somente FORA de produção (gateway local da fase 4B) e é IMPOSSÍVEL no
//     build/runtime Vercel, pois lá NODE_ENV=production (ou VERCEL=1) sempre
//     existem;
//   - identidade ausente/inválida → null (o chamador decide 401/403). NUNCA
//     um perfil padrão é escolhido por aqui.

export interface AuthUserLike {
  id?: string;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * true = ambiente estrito (Vercel — incluindo preview — ou qualquer build Node
 * em produção). O fallback legado fica inalcançável nessas condições.
 */
export function isProdServerEnv(env: Record<string, string | undefined>): boolean {
  return (
    env.VERCEL === '1' ||
    env.VERCEL_ENV === 'production' ||
    env.NODE_ENV === 'production'
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidProfileId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Resolve o profile_id confiável de um usuário autenticado. `allowLegacy`
 * habilita o fallback user_metadata apenas em desenvolvimento local; em
 * produção o parâmetro deve ser false (isProdServerEnv).
 */
export function profileIdFromAuthUser(
  user: AuthUserLike | null | undefined,
  opts: { allowLegacy: boolean },
): string | null {
  if (!user) return null;
  const appId = user.app_metadata?.profile_id;
  if (isValidProfileId(appId)) return appId;
  if (opts.allowLegacy) {
    const legacyId = user.user_metadata?.profile_id;
    if (isValidProfileId(legacyId)) return legacyId;
  }
  return null;
}