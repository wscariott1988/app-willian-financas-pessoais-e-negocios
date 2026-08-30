import React, { useEffect, useRef } from 'react';
import { AccountsSection } from '../settings/AccountsSection';
import { CategoriesSection } from '../settings/CategoriesSection';
import { HistorySection } from '../settings/HistorySection';

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
  /** Quando informado, destaca/rola a seção correspondente (ex.: navegação "Contas"). */
  focusSection?: 'accounts';
}

export const SettingsView: React.FC<SettingsViewProps> = ({ profileId, focusSection }) => {
  const accountsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusSection === 'accounts' && accountsRef.current) {
      accountsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusSection, profileId]);

  return (
    <div className="settings-view">
      <div className="settings-view-header">
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '4px' }}>
          {focusSection === 'accounts' ? 'Contas' : 'Configurações'}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
          {focusSection === 'accounts'
            ? 'Gestão de contas, cartões e vínculos por perfil'
            : 'Contas, categorias e preferências do perfil ativo'}
        </p>
      </div>
      <div ref={accountsRef} id="settings-accounts" className={focusSection === 'accounts' ? 'settings-section-focus' : undefined}>
        <AccountsSection profileId={profileId} />
      </div>
      <CategoriesSection profileId={profileId} />
      <HistorySection profileId={profileId} />
    </div>
  );
};