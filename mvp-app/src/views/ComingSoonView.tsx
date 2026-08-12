import React from 'react';

interface ComingSoonViewProps {
  title: string;
  description: string;
  icon: React.ComponentType<{ size?: number }>;
}

export const ComingSoonView: React.FC<ComingSoonViewProps> = ({ title, description, icon: Icon }) => {
  return (
    <div className="glass coming-soon">
      <div className="coming-soon-icon">
        <Icon size={36} />
      </div>
      <h1 style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.01em', marginBottom: '8px' }}>
        {title}
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--color-text-muted)', maxWidth: '420px', textAlign: 'center', lineHeight: 1.6 }}>
        {description}
      </p>
      <span className="badge badge-pending" style={{ marginTop: '16px' }}>
        Programado para a próxima etapa
      </span>
    </div>
  );
};
