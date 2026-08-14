// profileIdentity.ts — Obtenção centralizada e confiável do perfil ativo.
// Em produção, o perfil autorizado vem de app_metadata (gravado pelo trigger
// handle_new_user — 007_cloud_compat) e NÃO de user_metadata, que é metadado
// controlável pelo usuário. O fallback legado (user_metadata) é aceito
// somente em DEV (gateway local da fase 4B).

export type ProfileCode = 'personal' | 'business';

export interface SessionLike {
  user?: {
    app_metadata?: Record<string, unknown>;
    user_metadata?: Record<string, unknown>;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidProfileId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function resolveProfileId(
  session: SessionLike | null,
  opts?: { isDev?: boolean },
): string | null {
  if (!session?.user) return null;
  const isDev = opts?.isDev ?? import.meta.env.DEV;

  const appId = session.user.app_metadata?.profile_id;
  if (isValidProfileId(appId)) return appId;

  if (isDev) {
    const legacyId = session.user.user_metadata?.profile_id;
    if (isValidProfileId(legacyId)) return legacyId;
  }

  return null;
}

export function resolveProfileCode(
  session: SessionLike | null,
  opts?: { isDev?: boolean },
): ProfileCode | null {
  if (!session?.user) return null;
  const isDev = opts?.isDev ?? import.meta.env.DEV;

  const appCode = session.user.app_metadata?.profile_code;
  if (appCode === 'personal' || appCode === 'business') return appCode;

  if (isDev) {
    const legacyCode = session.user.user_metadata?.profile_code;
    if (legacyCode === 'personal' || legacyCode === 'business') return legacyCode;
  }

  return null;
}
