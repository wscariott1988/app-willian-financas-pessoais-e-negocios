import React from 'react';
import { AccountsSection } from '../settings/AccountsSection';
import { CategoriesSection } from '../settings/CategoriesSection';

// Re-export de helpers/tipos (testes e consumidores externos importam da view).
export {
  buildCategoryTree,
  groupCategoriesByDirection,
  categoryStatusLabel,
  DIRECTION_LABELS,
  CATEGORY_STATUS_LABELS,
} from '../settings/CategoriesSection';
export type { SettingsCategory, CategoryNode } from '../settings/CategoriesSection';

interface SettingsViewProps {
  profileId: string;
  refreshTrigger?: number;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ profileId }) => {
  return (
    <div className="settings-view">
      <div className="settings-view-header">
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
          Configurações
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
          Contas, categorias e preferências do perfil ativo
        </p>
      </div>
      <AccountsSection profileId={profileId} />
      <CategoriesSection profileId={profileId} />
    </div>
  );
};