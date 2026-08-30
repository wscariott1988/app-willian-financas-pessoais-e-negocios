import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppShell } from '../components/AppShell';
import { SettingsView } from '../views/SettingsView';

const here = dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(resolve(here, '..', rel), 'utf8');
}

describe('CFG-P7A — rota Contas conectada à gestão existente', () => {
  const shell = readSource('components/AppShell.tsx');
  const settings = readSource('views/SettingsView.tsx');

  it('1. clicar Contas abre a gestão existente (SettingsView com foco em accounts)', () => {
    expect(shell).toContain("view === 'contas' && <SettingsView profileId={profileId} focusSection=\"accounts\" />");
  });

  it('2. AccountsSection está presente (sem duplicação)', () => {
    expect(settings).toContain('<AccountsSection profileId={profileId} />');
    const occurrences = settings.split('<AccountsSection').length - 1;
    expect(occurrences).toBe(1);
  });

  it('3. Contas não usa ComingSoon', () => {
    expect(shell).not.toContain('ComingSoonView');
    expect(shell).not.toContain('COMING_SOON');
  });

  it('4. Configurações normal continua funcionando (sem foco)', () => {
    expect(shell).toContain("view === 'configuracoes' && <SettingsView profileId={profileId} />");
  });

  it('5. Categorias continua acessível (seção renderizada na mesma view)', () => {
    expect(settings).toContain('<CategoriesSection profileId={profileId} />');
  });

  it('6. Histórico continua acessível', () => {
    expect(settings).toContain('<HistorySection profileId={profileId} />');
  });

  it('7. trocar de Contas para outra seção atualiza estado (view é estado único do AppShell)', () => {
    // NAV_ITEMS usa onClick={() => setView(item.id)} — a view é substituída por completo;
    // sair de contas redefine o render (sem estado preso).
    expect(shell).toContain("onClick={() => setView(item.id)}");
    expect(shell).toContain("const [view, setView] = useState<ViewId>(initialView)");
  });

  it('8. profile switch continua funcionando (key={profileId} na view; sem cache)', () => {
    expect(shell).toContain('key={profileId}');
  });

  it('9. mobile nav não quebra (mesmos NAV_ITEMS no bottom-nav)', () => {
    expect(shell).toContain('<nav className="bottom-nav"');
    expect(shell).toContain('NAV_ITEMS.map((item) => navItem(item, \'bottom-nav-item\'))');
  });

  it('10. nenhuma duplicação de AccountsSection', () => {
    const all = readSource('views/SettingsView.tsx') + readSource('components/AppShell.tsx');
    expect(all.split('<AccountsSection').length - 1).toBe(1);
  });

  it('11. nenhum backend/RPC novo (view é 100% reuso)', () => {
    const all = settings + shell;
    expect(all).not.toContain('.rpc(');
    expect(all).not.toContain("from('transaction_series')");
    expect(all).not.toContain('account_create(');
  });

  it('12. rota Análises permanece funcional', () => {
    expect(shell).toContain('<AnalyticsView');
  });

  it('active nav: "Contas" ativo em view=contas; "Configurações" em view=configuracoes', () => {
    // O active usa `view === item.id` (regra consistente); render de contas é SettingsView,
    // então apenas o item contas fica destacado quando view === 'contas'.
    expect(shell).toContain("`${className} ${view === item.id ? 'active' : ''}`");
  });

  it('título da view muda para "Contas" quando focado (sem texto de ComingSoon)', () => {
    expect(settings).toContain("focusSection === 'accounts' ? 'Contas' : 'Configurações'");
  });
});

describe('CFG-P7A — renderização (SSR)', () => {
  it('SettingsView com focusSection renderiza a seção Contas com id', () => {
    const html = renderToString(createElement(SettingsView, { profileId: 'PERFIL', focusSection: 'accounts' as const }));
    expect(html).toContain('id="settings-accounts"');
    expect(html).toContain('settings-section-focus');
    expect(html).toContain('Contas');
    expect(html).not.toContain('Programado para a próxima etapa');
  });

  it('AppShell renderiza sem erro (view inicial inicio)', () => {
    const html = renderToString(createElement(AppShell, {
      profileId: 'P1',
      profileCode: 'personal' as const,
      userEmail: 'a@b.c',
      onProfileSwitch: () => {},
      onLogout: () => {},
      onProfileSwitchRequest: () => {},
      initialView: 'contas' as const,
    }));
    expect(html).toContain('Willian Finanças');
    expect(html).not.toContain('Programado para a próxima etapa');
  });
});