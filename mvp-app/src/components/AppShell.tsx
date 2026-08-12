import React from 'react';
import { Home, ArrowLeftRight, Landmark, BarChart3, Settings, Hourglass } from 'lucide-react';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Dashboard } from './Dashboard';
import { TransactionsView } from '../views/TransactionsView';
import { ComingSoonView } from '../views/ComingSoonView';
import { useMemo, useState } from 'react';
import { type PeriodMode, type PeriodRange, type PeriodSelection, computePeriodRange, selectionFromDate } from '../lib/period';

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
}) => {
  const [view, setView] = useState<ViewId>('inicio');
  const [selection, setSelection] = useState<PeriodSelection>(() => selectionFromDate(new Date()));
  const [mode, setMode] = useState<PeriodMode>('up_to_today');

  const range = useMemo(() => computePeriodRange(selection, mode, new Date()), [selection, mode]);

  const period: PeriodController = {
    selection,
    mode,
    range,
    onSelectionChange: setSelection,
    onModeChange: setMode,
  };

  const nav = (id: ViewId, index: number, className: string) => (
    <button
      key={id}
      className={`${className} ${view === id ? 'active' : ''}`}
      onClick={() => setView(id)}
      aria-current={view === id ? 'page' : undefined}
    >
      {(() => {
        const Icon = NAV_ITEMS[index].icon;
        return <Icon size={18} />;
      })()}
      <span>{NAV_ITEMS[index].label}</span>
    </button>
  );

  return (
    <div className="app-shell">
      <ProfileSwitcher
        currentProfileCode={profileCode}
        userEmail={userEmail}
        onProfileSwitch={onProfileSwitch}
        onLogout={onLogout}
      />

      <div className="app-body">
        <nav className="side-nav glass" aria-label="Navegação principal">
          {NAV_ITEMS.map((item, i) => nav(item.id, i, 'side-nav-item'))}
          <div className="side-nav-spacer" />
          <div className="side-nav-foot">
            <Hourglass size={13} />
            <span>Fundamento visual — Etapa 1</span>
          </div>
        </nav>

        <main className="app-main">
          {view === 'inicio' && (
            <Dashboard key={profileId} profileId={profileId} profileCode={profileCode} period={period} />
          )}
          {view === 'transacoes' && <TransactionsView key={profileId} profileId={profileId} period={period} />}
          {view === 'contas' && <ComingSoonView {...COMING_SOON.contas} icon={Landmark} />}
          {view === 'analises' && <ComingSoonView {...COMING_SOON.analises} icon={BarChart3} />}
          {view === 'configuracoes' && <ComingSoonView {...COMING_SOON.configuracoes} icon={Settings} />}
        </main>
      </div>

      <nav className="bottom-nav glass" aria-label="Navegação principal">
        {NAV_ITEMS.map((item, i) => nav(item.id, i, 'bottom-nav-item'))}
      </nav>
    </div>
  );
};
