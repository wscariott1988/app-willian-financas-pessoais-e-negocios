import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { User, Briefcase, LogOut, RefreshCw } from 'lucide-react';

interface ProfileSwitcherProps {
  currentProfileCode: 'personal' | 'business';
  userEmail: string;
  onProfileSwitch: (session: any) => void;
  onLogout: () => void;
}

export const ProfileSwitcher: React.FC<ProfileSwitcherProps> = ({
  currentProfileCode,
  userEmail,
  onProfileSwitch,
  onLogout
}) => {
  const [switching, setSwitching] = useState(false);

  const handleSwitch = async () => {
    if (import.meta.env.PROD) return; // Auto-switch uses local seed accounts; not available in production
    setSwitching(true);
    const targetProfile = currentProfileCode === 'personal' ? 'negocio' : 'pessoal';
    
    const seedEmail = targetProfile === 'pessoal'
      ? import.meta.env.VITE_SEED_USER_PESSOAL_EMAIL || ''
      : import.meta.env.VITE_SEED_USER_NEGOCIO_EMAIL || '';
    
    const seedPassword = targetProfile === 'pessoal'
      ? import.meta.env.VITE_SEED_USER_PESSOAL_PASSWORD || ''
      : import.meta.env.VITE_SEED_USER_NEGOCIO_PASSWORD || '';

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: seedEmail,
        password: seedPassword
      });

      if (error) throw error;
      if (data?.session) {
        onProfileSwitch(data.session);
      }
    } catch (err) {
      console.error('Erro ao alternar de perfil:', err);
      alert('Falha ao alternar perfil automático.');
    } finally {
      setSwitching(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    onLogout();
  };

  return (
    <header className="glass" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '16px 24px',
      borderRadius: '0 0 16px 16px',
      borderTop: 'none',
      marginBottom: '30px',
      boxShadow: '0 4px 30px rgba(0, 0, 0, 0.4)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          background: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
          width: '38px',
          height: '38px',
          borderRadius: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'var(--shadow-glow)'
        }}>
          <span style={{ fontSize: '18px', fontWeight: 800, color: 'white' }}>FP</span>
        </div>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, letterSpacing: '-0.01em' }}>Finanças Pessoais</h2>
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
            {import.meta.env.DEV ? 'Fase 4B — Supabase Local' : 'Painel de recategorização e conciliação'}
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid var(--border-card)',
          borderRadius: '8px',
          padding: '6px 12px',
          fontSize: '13px'
        }}>
          {currentProfileCode === 'personal' ? (
            <User size={16} style={{ color: 'var(--color-primary)' }} />
          ) : (
            <Briefcase size={16} style={{ color: 'var(--color-secondary)' }} />
          )}
          <span style={{ fontWeight: 600 }}>
            Perfil: {currentProfileCode === 'personal' ? 'Pessoal' : 'Negócio'}
          </span>
          <span style={{ color: 'rgba(255,255,255,0.15)' }}>|</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>{userEmail}</span>
        </div>

        {import.meta.env.DEV && (
          <button
            className="btn-secondary"
            onClick={handleSwitch}
            disabled={switching}
            style={{ padding: '8px 12px', height: '36px', fontSize: '13px' }}
            title="Alterna entre as contas seed locais (somente desenvolvimento)"
          >
            <RefreshCw size={14} className={switching ? 'spin-animation' : ''} />
            {switching ? 'Alternando...' : `Ir p/ ${currentProfileCode === 'personal' ? 'Negócio' : 'Pessoal'}`}
          </button>
        )}

        <button 
          onClick={handleSignOut}
          style={{
            padding: '8px',
            height: '36px',
            width: '36px',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            color: 'var(--color-danger)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '8px'
          }}
          title="Fazer Logout"
        >
          <LogOut size={16} />
        </button>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin-animation {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </header>
  );
};
