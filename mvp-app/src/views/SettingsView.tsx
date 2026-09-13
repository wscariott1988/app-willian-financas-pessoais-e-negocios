import React, { useEffect, useRef, useState } from 'react';
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

type SettingsTab = 'accounts' | 'categories' | 'history';

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'accounts', label: 'Contas' },
  { id: 'categories', label: 'Categorias' },
  { id: 'history', label: 'Histórico' },
];

export const SettingsView: React.FC<SettingsViewProps> = ({ profileId, focusSection }) => {
  const accountsRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('accounts');

  useEffect(() => {
    if (focusSection === 'accounts' && accountsRef.current) {
      accountsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusSection, profileId]);

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = SETTINGS_TABS.findIndex((t) => t.id === activeTab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
      event.preventDefault();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
      event.preventDefault();
    } else if (event.key === 'Home') {
      nextIndex = 0;
      event.preventDefault();
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_TABS.length - 1;
      event.preventDefault();
    } else {
      return;
    }
    setActiveTab(SETTINGS_TABS[nextIndex].id);
  };

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

      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Seções de Configurações"
        onKeyDown={handleTabKeyDown}
      >
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`settings-tab ${activeTab === tab.id ? 'settings-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        ref={accountsRef}
        id="settings-accounts"
        className={focusSection === 'accounts' && activeTab === 'accounts' ? 'settings-section-focus' : undefined}
      >
        <section
          id="settings-panel-accounts"
          role="tabpanel"
          aria-labelledby="settings-tab-accounts"
          aria-hidden={activeTab !== 'accounts'}
          hidden={activeTab !== 'accounts'}
        >
          <AccountsSection profileId={profileId} />
        </section>
      </div>

      <section
        id="settings-panel-categories"
        role="tabpanel"
        aria-labelledby="settings-tab-categories"
        aria-hidden={activeTab !== 'categories'}
        hidden={activeTab !== 'categories'}
      >
        <CategoriesSection profileId={profileId} />
      </section>

      <section
        id="settings-panel-history"
        role="tabpanel"
        aria-labelledby="settings-tab-history"
        aria-hidden={activeTab !== 'history'}
        hidden={activeTab !== 'history'}
      >
        <HistorySection profileId={profileId} />
      </section>
    </div>
  );
};