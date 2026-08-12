import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { Login } from './components/Login';
import { ProfileSwitcher } from './components/ProfileSwitcher';
import { Dashboard } from './components/Dashboard';
import './index.css';

interface Session {
  access_token: string;
  user: {
    id: string;
    email: string;
    user_metadata: {
      profile_code: 'personal' | 'business';
      profile_id: string;
    };
  };
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check existing session on mount
    const checkSession = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (data?.session) {
          setSession(data.session as any);
        }
      } catch (err) {
        console.error('Error checking session:', err);
      } finally {
        setLoading(false);
      }
    };

    checkSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession as any);
      if (!newSession) setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLoginSuccess = (newSession: Session) => {
    setSession(newSession);
  };

  const handleLogout = () => {
    setSession(null);
  };

  const handleProfileSwitch = (newSession: Session) => {
    setSession(newSession);
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        flexDirection: 'column',
        gap: '16px',
        color: 'var(--color-text-muted)'
      }}>
        <div style={{
          width: '40px',
          height: '40px',
          border: '3px solid rgba(99, 102, 241, 0.15)',
          borderTop: '3px solid var(--color-primary)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ fontSize: '14px' }}>Verificando sessão...</span>
      </div>
    );
  }

  if (!session) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  const profileCode = session.user?.user_metadata?.profile_code || 'personal';
  const profileId = session.user?.user_metadata?.profile_id || '';
  const userEmail = session.user?.email || '';

  return (
    <div style={{ minHeight: '100vh' }}>
      <ProfileSwitcher
        currentProfileCode={profileCode}
        userEmail={userEmail}
        onProfileSwitch={handleProfileSwitch}
        onLogout={handleLogout}
      />
      <Dashboard key={profileId} profileId={profileId} profileCode={profileCode} />
    </div>
  );
}

export default App;
