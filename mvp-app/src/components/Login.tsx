import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { LogIn, User, Briefcase, Key } from 'lucide-react';

interface LoginProps {
  onLoginSuccess: (session: any) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) throw authError;
      if (data?.session) {
        onLoginSuccess(data.session);
      }
    } catch (err: any) {
      setError(err.message || 'Erro ao realizar login');
    } finally {
      setLoading(false);
    }
  };

  const loginWithSeed = async (profileType: 'pessoal' | 'negocio') => {
    if (import.meta.env.PROD) return; // Seed credentials only in local development
    setLoading(true);
    setError(null);

    const seedEmail = profileType === 'pessoal'
      ? import.meta.env.VITE_SEED_USER_PESSOAL_EMAIL || ''
      : import.meta.env.VITE_SEED_USER_NEGOCIO_EMAIL || '';
    const seedPassword = profileType === 'pessoal'
      ? import.meta.env.VITE_SEED_USER_PESSOAL_PASSWORD || ''
      : import.meta.env.VITE_SEED_USER_NEGOCIO_PASSWORD || '';

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: seedEmail,
        password: seedPassword,
      });

      if (authError) throw authError;
      if (data?.session) {
        onLoginSuccess(data.session);
      }
    } catch (err: any) {
      setError(err.message || 'Erro ao realizar login com credenciais de seed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '80vh',
      padding: '20px'
    }}>
      <div className="glass animate-fade-in" style={{
        maxWidth: '480px',
        width: '100%',
        padding: '40px',
        border: '1px solid rgba(255,255,255,0.08)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
            width: '64px',
            height: '64px',
            borderRadius: '16px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '16px',
            boxShadow: 'var(--shadow-glow)'
          }}>
            <LogIn size={32} color="white" />
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '8px' }}>
            Finanças Pessoais
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>
            Acesse o painel de conciliação e recategorização
          </p>
        </div>

        {error && (
          <div style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            color: 'var(--color-danger)',
            padding: '12px 16px',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: 500,
            marginBottom: '24px',
            textAlign: 'center'
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)' }}>Email</label>
            <input
              type="email"
              placeholder="seuemail@exemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)' }}>Senha</label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '8px' }} disabled={loading}>
            {loading ? 'Acessando...' : 'Entrar'}
          </button>
        </form>

        {import.meta.env.DEV && (
          <>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              margin: '24px 0',
              color: 'var(--color-text-muted)',
              fontSize: '12px'
            }}>
              <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-card)' }}></div>
              <span>ACESSO RÁPIDO (SEED) — SOMENTE DEV</span>
              <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-card)' }}></div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div
                className="glass glass-interactive"
                style={{
                  padding: '16px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.05)'
                }}
                onClick={() => !loading && loginWithSeed('pessoal')}
              >
                <User size={20} style={{ color: 'var(--color-primary)', marginBottom: '8px' }} />
                <div style={{ fontSize: '13px', fontWeight: 700 }}>Pessoal</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>Perfil pessoal (seed local)</div>
              </div>

              <div
                className="glass glass-interactive"
                style={{
                  padding: '16px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.05)'
                }}
                onClick={() => !loading && loginWithSeed('negocio')}
              >
                <Briefcase size={20} style={{ color: 'var(--color-secondary)', marginBottom: '8px' }} />
                <div style={{ fontSize: '13px', fontWeight: 700 }}>Negócio</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>Perfil de negócio (seed local)</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
