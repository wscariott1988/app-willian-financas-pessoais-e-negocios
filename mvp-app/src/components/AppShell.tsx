import React from 'react';
import { Home, ArrowLeftRight, BarChart3, Settings, Wallet } from 'lucide-react';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Dashboard } from './Dashboard';
import { TransactionsView, type TxMode } from '../views/TransactionsView';
import { SettingsView } from '../views/SettingsView';
import { AnalyticsView } from '../views/AnalyticsView';
import { useEffect, useState } from 'react';
import { type PendingFilter } from '../lib/txList';
import { usePeriodController } from '../hooks/usePeriodController';
import { PERIOD_DEFAULT_MODES } from '../lib/periodController';
import { PeriodPicker } from './PeriodPicker';

export type ViewId = 'inicio' | 'transacoes' | 'contas' | 'analises' | 'configuracoes';

// Persistência da aba ativa por perfil na SESSÃO (PESSOAL-13C3B.12). Grava
// SOMENTE o id da view — nenhum dado financeiro. Chave por perfil: trocar de
// perfil nunca restaura uma aba incompatível.
const SESSION_VIEW_KEY_PREFIX = 'wf:active-view:';
const VALID_VIEW_IDS: ReadonlySet<string> = new Set([
  'inicio',
  'transacoes',
  'contas',
  'analises',
  'configuracoes',
]);

/**
 * Lê a aba persistida da sessão do perfil. Falha silenciosa (storage
 * indisponível/SSR) e valores inválidos caem no padrão 'inicio' via null.
 */
export function readPersistedView(profileId: string): ViewId | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${SESSION_VIEW_KEY_PREFIX}${profileId}`);
    return raw !== null && VALID_VIEW_IDS.has(raw) ? (raw as ViewId) : null;
  } catch {
    return null;
  }
}

// O contrato do seletor de período vive em lib/periodController.ts; mantemos o
// re-export para não quebrar os imports existentes (Dashboard/Views).
export type { PeriodController } from '../lib/periodController';

const NAV_ITEMS: ReadonlyArray<{ id: ViewId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'inicio', label: 'Início', icon: Home },
  { id: 'transacoes', label: 'Transações', icon: ArrowLeftRight },
  { id: 'analises', label: 'Análises', icon: BarChart3 },
  { id: 'configuracoes', label: 'Configurações', icon: Settings },
];

interface AppShellProps {
  profileId: string;
  profileCode: 'personal' | 'business';
  userEmail: string;
  onProfileSwitch: (session: any) => void;
  onLogout: () => void;
  onProfileSwitchRequest: (notice: string) => void;
  initialView?: ViewId;
}

export const AppShell: React.FC<AppShellProps> = ({
  profileId,
  profileCode,
  userEmail,
  onProfileSwitch,
  onLogout,
  onProfileSwitchRequest,
  initialView = 'inicio',
}) => {
  const [view, setView] = useState<ViewId>(initialView);
  // PESSOAL-12: um estado de período independente por aba, cada um com o seu
  // default (Início = Até hoje; Transações/Análises = Mês todo). Mudanças
  // manuais dentro de cada tela são preservadas na sessão; nada é compartilhado
  // entre telas nem resetado a cada render.
  const homePeriod = usePeriodController(PERIOD_DEFAULT_MODES.inicio);
  const txPeriod = usePeriodController(PERIOD_DEFAULT_MODES.transacoes);
  const analyticsPeriod = usePeriodController(PERIOD_DEFAULT_MODES.analises);
  // Modo da view Transações preservado durante a navegação interna (sessão ativa)
  const [txMode, setTxMode] = useState<TxMode>('period');
  const [txPendingFilter, setTxPendingFilter] = useState<PendingFilter>('all');

  // PESSOAL-13C3B.12: F5 (remount) restaura a aba ativa da sessão por perfil.
  // Só grava o id da view (nunca dados financeiros); falha silenciosa em modo
  // privado/SSR. A restauração em si acontece no App via readPersistedView.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(`${SESSION_VIEW_KEY_PREFIX}${profileId}`, view);
    } catch {
      // Storage indisponível: a navegação segue normal.
    }
  }, [profileId, view]);

  // O picker de período personalizado é único na tela; ele opera sobre o estado
  // do contexto ativo (a única view visível), respeitando o período de cada aba.
  const activePeriod =
    view === 'transacoes' ? txPeriod
    : view === 'analises' ? analyticsPeriod
    : homePeriod;

  // Cards de pendências da Início: abrem Transações na fila global filtrada.
  const handleOpenPending = (filter: 'unpaid' | 'noCategory') => {
    setTxMode('pending');
    setTxPendingFilter(filter);
    setView('transacoes');
  };

  const handleNavigateToTransactions = () => {
    setTxMode('period');
    setView('transacoes');
  };

  const switcherProps = {
    currentProfileCode: profileCode,
    userEmail,
    onProfileSwitch,
    onLogout,
    onProfileSwitchRequest,
  };

  const navItem = (item: (typeof NAV_ITEMS)[number], className: string) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        className={`${className} ${view === item.id ? 'active' : ''}`}
        onClick={() => setView(item.id)}
        aria-current={view === item.id ? 'page' : undefined}
      >
        <Icon size={20} />
        <span>{item.label}</span>
      </button>
    );
  };

  return (
    <div className="app-shell">
      {/* Cabeçalho mobile/tablet (oculto no desktop via CSS) */}
      <ProfileSwitcher variant="header" {...switcherProps} />

      <div className="app-body">
        {/* Sidebar desktop (≥1024px) */}
        <aside className="side-nav" aria-label="Navegação principal">
          <div className="side-nav-brand">
            <div className="side-nav-brand-logo">
              <Wallet size={20} />
            </div>
            <span>Willian Finanças</span>
          </div>

          <nav className="side-nav-list">
            {NAV_ITEMS.map((item) => navItem(item, 'side-nav-item'))}
          </nav>

          <ProfileSwitcher variant="sidebar" {...switcherProps} />
        </aside>

        <main className="app-main">
          {view === 'inicio' && (
            <Dashboard
              key={profileId}
              profileId={profileId}
              profileCode={profileCode}
              period={homePeriod.controller}
              onOpenPending={handleOpenPending}
              onNavigateToTransactions={handleNavigateToTransactions}
            />
          )}
          {view === 'transacoes' && (
            <TransactionsView
              key={profileId}
              profileId={profileId}
              profileCode={profileCode}
              period={txPeriod.controller}
              mode={txMode}
              onModeChange={setTxMode}
              pendingFilter={txPendingFilter}
              onPendingFilterChange={setTxPendingFilter}
            />
          )}
          {view === 'contas' && <SettingsView profileId={profileId} focusSection="accounts" />}
          {view === 'analises' && (
            <AnalyticsView
              key={profileId}
              profileId={profileId}
              profileCode={profileCode}
              period={analyticsPeriod.controller}
            />
          )}
          {view === 'configuracoes' && <SettingsView profileId={profileId} />}
        </main>
      </div>

      {/* Navegação inferior mobile/tablet (oculta no desktop via CSS) */}
      <nav className="bottom-nav" aria-label="Navegação principal">
        {NAV_ITEMS.map((item) => navItem(item, 'bottom-nav-item'))}
      </nav>

      <PeriodPicker
        open={activePeriod.pickerOpen}
        onClose={activePeriod.closePicker}
        onApply={activePeriod.controller.onCustomApply}
        currentStart={activePeriod.controller.mode === 'custom' ? activePeriod.customStart : undefined}
        currentEnd={activePeriod.controller.mode === 'custom' ? activePeriod.customEnd : undefined}
      />
    </div>
  );
};