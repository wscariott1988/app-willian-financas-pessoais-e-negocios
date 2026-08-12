import { createClient } from '@supabase/supabase-js';

const isProd = import.meta.env.PROD;

function resolveEnvUrl(): string {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!url) {
    throw new Error(
      isProd
        ? 'VITE_SUPABASE_URL não definida. Configure a URL do projeto Supabase (https) na Vercel.'
        : 'VITE_SUPABASE_URL não definida. Copie mvp-app/.env.example para mvp-app/.env.'
    );
  }
  if (isProd && !/^https:\/\//.test(url)) {
    throw new Error('VITE_SUPABASE_URL deve ser HTTPS em produção.');
  }
  return url;
}

function resolveEnvAnonKey(): string {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!key) {
    throw new Error(
      isProd
        ? 'VITE_SUPABASE_ANON_KEY não definida. Configure a chave pública (publishable) na Vercel.'
        : 'VITE_SUPABASE_ANON_KEY não definida. Copie mvp-app/.env.example para mvp-app/.env.'
    );
  }
  return key;
}

export const supabase = createClient(resolveEnvUrl(), resolveEnvAnonKey(), {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
