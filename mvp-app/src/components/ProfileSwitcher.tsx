import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { User, Briefcase, LogOut, ArrowLeftRight, RefreshCw } from 'lucide-react';
import {
  loginNoticeMessage,
  signOutAndReturn,
  type ProfileCode,
} from '../lib/profileSwitch';

interface ProfileSwitcherProps {
  variant: 'header' | 'sidebar';
  currentProfileCode: 'personal' | 'business';
  userEmail: string;
  onProfileSwitch: (session: any) => void;
  onLogout: () => void;
  onProfileSwitchRequest: (notice: string) => void;
}

export const ProfileSwitcher: React.FC<ProfileSwitcherProps> = ({
  variant,
  currentProfileCode,
  userEmail,
  onProfileSwitch,
  onLogout,
  onProfileSwitchRequest,
}) => {
  const [switching, setSwitching] = useState(false);

  const isPersonal = currentProfileCode === 'personal';
  const profileLabel = isPersonal ? 'Perfil Pessoal' : 'Perfil Negócio';

  // Logout oficial (API do Supabase limpa a sessão) e retorno ao login.
  const doLogout = async () => {
    setSwitching(true);
    try {
      await signOutAndReturn(supabase.auth, onLogout);
    } catch (err) {
      console.error('Erro no logout:', err);
      alert('Falha ao sair. Tente novamente.');
    } finally {
      setSwitching(false);
    }
  };

  const handleSwitch = async () => {
    setSwitching(true);

    // Somente desenvolvimento: credenciais de seed locais para login automático.
    if (import.meta.env.DEV) {
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
          password: seedPassword,
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
      return;
    }

    // Produção: perfis são usuários diferentes; exige novo login.
    try {
      await signOutAndReturn(supabase.auth, () => {
        onProfileSwitchRequest(loginNoticeMessage(currentProfileCode));
        onLogout();
      });
    } catch (err) {
      console.error('Erro ao sair para trocar de perfil:', err);
      alert('Falha ao encerrar a sessão. Tente novamente.');
    } finally {
      setSwitching(false);
    }
  };

  if (variant === 'sidebar') {
    return (
      <div className="side-nav-profile">
        <div className="sidebar-user-row">
          <div className="sidebar-avatar">
            {isPersonal ? <User size={20} /> : <Briefcase size={20} />}
          </div>
          <div className="sidebar-user">
            <span className="sidebar-email" title={userEmail}>{userEmail}</span>
            <span className={`profile-chip ${isPersonal ? '' : 'business'}`}>
              {profileLabel}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="sidebar-switch-btn"
          onClick={handleSwitch}
          disabled={switching}
          title={
            import.meta.env.DEV
              ? 'Alterna entre as contas seed locais (somente desenvolvimento)'
              : 'Encerra a sessão e pede login com o outro perfil'
          }
        >
          <ArrowLeftRight size={16} className={switching ? 'spin-animation' : ''} />
          {switching ? 'Aguarde...' : 'Trocar perfil'}
        </button>

        <button
          type="button"
          className="sidebar-logout-btn"
          onClick={doLogout}
          disabled={switching}
        >
          <LogOut size={16} />
          Sair
        </button>
      </div>
    );
  }

  return (
    <header className="app-header">
      <div className="app-header-top">
        <div className="app-header-brand">
          <div className="app-header-logo">
            <span>FP</span>
          </div>
          <div className="app-header-titles">
            <h2>Finanças Pessoais</h2>
          </div>
        </div>

        <button
          type="button"
          className="app-header-logout"
          onClick={doLogout}
          disabled={switching}
          aria-label="Sair da conta"
          title="Sair"
        >
          <LogOut size={16} />
        </button>
      </div>

      <div className="app-header-bottom">
        <span className={`profile-chip ${isPersonal ? '' : 'business'}`} title={userEmail}>
          {isPersonal ? <User size={13} /> : <Briefcase size={13} />}
          {profileLabel}
        </span>

        <button
          type="button"
          className="app-header-switch"
          onClick={handleSwitch}
          disabled={switching}
          title={
            import.meta.env.DEV
              ? 'Alterna entre as contas seed locais (somente desenvolvimento)'
              : `Encerra a sessão e pede login com o perfil ${isPersonal ? 'Negócio' : 'Pessoal'}`
          }
        >
          <ArrowLeftRight size={14} className={switching ? 'spin-animation' : ''} />
          {switching ? 'Aguarde...' : 'Trocar perfil'}
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
