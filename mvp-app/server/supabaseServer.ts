// supabaseServer.ts — Cliente Supabase server-side (PESSOAL-13B1).
// Usa apenas URL/anônimo públicos + JWT do usuário autenticado em
// Authorization. Nunca utiliza SUPABASE_SERVICE_ROLE_KEY: todas as consultas
// financeiras continuam isoladas pela RLS e por app.jwt_profile_id().

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface ServerSupabaseEnv {
  url: string;
  anonKey: string;
}

export function resolveSupabaseEnv(env: Record<string, string | undefined>): ServerSupabaseEnv {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Configuração do Supabase ausente no servidor.');
  }
  return { url, anonKey };
}

/**
 * Cria um cliente Supabase anônimo já autenticado com o JWT do usuário.
 * Primeiro valida o token com auth.getUser(); depois anexa o mesmo JWT para que
 * a RLS continue responsável pelo isolamento Pessoal/Negócio.
 */
export async function createUserSupabaseClient(
  env: Record<string, string | undefined>,
  accessToken: string,
): Promise<{
  client: SupabaseClient;
  userId: string;
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']> | null;
}> {
  const { url, anonKey } = resolveSupabaseEnv(env);
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new AuthTokenError();
  }
  return { client, userId: data.user.id, user: data.user };
}

export class AuthTokenError extends Error {
  constructor() {
    super('Token de autenticação inválido ou expirado.');
    this.name = 'AuthTokenError';
  }
}
