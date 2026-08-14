import React from 'react';
import { Home, ArrowLeftRight, Landmark, BarChart3, Settings, Wallet } from 'lucide-react';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Dashboard } from './Dashboard';
import { TransactionsView, type TxMode } from '../views/TransactionsView';
import { ComingSoonView } from '../views/ComingSoonView';
import { useMemo, useState } from 'react';
import { type PeriodMode, type PeriodRange, type PeriodSelection, computePeriodRange, selectionFromDate } from '../lib/period';
import type { PendingFilter } from '../lib/txList';

export type ViewId = 'inicio' | 'transacoes' | 'contas' | 'analises' | 'configuracoes';

const NAV_ITEMS: ReadonlyArray<{ id: ViewId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'inicio', label: 'Início', icon: Home },
  { id: 'transacoes', label: 'Transações', icon: ArrowLeftRight },
  { id: 'contas', label: 'Contas', icon: Landmark },
  { id: 'analises', label: 'Análises', icon: BarChart3 },
  { id: 'configuracoes', label: 'Configurações', icon: Settings },
];

export interface PeriodController {
  selection: PeriodSelection;
  mode: PeriodMode;
  range: PeriodRange;
  onSelectionChange: (sel: PeriodSelection) => void;
  onModeChange: (mode: PeriodMode) => void;
}

interface AppShellProps {
  profileId: string;
  profileCode: 'personal' | 'business';
  userEmail: string;
  onProfileSwitch: (session: any) => void;
  onLogout: () => void;
  onProfileSwitchRequest: (notice: string) => void;
  initialView?: ViewId;
}

const COMING_SOON: Record<Exclude<ViewId, 'inicio' | 'transacoes'>, { title: string; description: string }> = {
  contas: {
    title: 'Contas',
    description: 'Gestão de contas, cartões e saldos está programada para a próxima etapa.',
  },
  analises: {
    title: 'Análises',
    description: 'Gráficos, comparações e insights estão programados para a próxima etapa.',
  },
  configuracoes: {
    title: 'Configurações',
    description: 'Preferências, categorias e importações estão programadas para a próxima etapa.',
  },
};

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
  const [selection, setSelection] = useState<PeriodSelection>(() => selectionFromDate(new Date()));
  const [mode, setMode] = useState<PeriodMode>('up_to_today');
  // Modo da view Transações preservado durante a navegação interna (sessão ativa)
  const [txMode, setTxMode] = useState<TxMode>('period');
  const [txPendingFilter, setTxPendingFilter] = useState<PendingFilter>('all');

  const range = useMemo(() => computePeriodRange(selection, mode, new Date()), [selection, mode]);

  // Cards de pendências da Início: abrem Transações na fila global filtrada.
  const handleOpenPending = (filter: 'review' | 'noCategory') => {
    setTxMode('pending');
    setTxPendingFilter(filter);
    setView('transacoes');
  };

  const period: PeriodController = {
    selection,
    mode,
    range,
    onSelectionChange: setSelection,
    onModeChange: setMode,
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
              period={period}
              onOpenPending={handleOpenPending}
            />
          )}
          {view === 'transacoes' && (
            <TransactionsView
              key={profileId}
              profileId={profileId}
              profileCode={profileCode}
              period={period}
              mode={txMode}
              onModeChange={setTxMode}
              pendingFilter={txPendingFilter}
              onPendingFilterChange={setTxPendingFilter}
            />
          )}
          {view === 'contas' && <ComingSoonView {...COMING_SOON.contas} icon={Landmark} />}
          {view === 'analises' && <ComingSoonView {...COMING_SOON.analises} icon={BarChart3} />}
          {view === 'configuracoes' && <ComingSoonView {...COMING_SOON.configuracoes} icon={Settings} />}
        </main>
      </div>

      {/* Navegação inferior mobile/tablet (oculta no desktop via CSS) */}
      <nav className="bottom-nav" aria-label="Navegação principal">
        {NAV_ITEMS.map((item) => navItem(item, 'bottom-nav-item'))}
      </nav>
    </div>
  );
};
