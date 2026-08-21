import React from 'react';

interface SettingsViewProps {
  profileId: string;
  refreshTrigger?: number;
}

export const SettingsView: React.FC<SettingsViewProps> = () => {
  return (
    <div className="settings-view">
      <div className="settings-view-header">
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
          Configurações
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
          Preferências do perfil ativo
        </p>
      </div>
    </div>
  );
};
