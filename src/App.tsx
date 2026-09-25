import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { useFlowAutoAdvance } from './components/app/hooks';
import { goTo, normalizeTab, setConsoleOpen, type TabId } from './components/app/nav';
import Sidebar from './components/layout/Sidebar';
import Titlebar from './components/layout/Titlebar';
import { PortDiagnosticBanner } from './components/shared/PortDiagnosticBanner';
import { RobloxStatusBanner } from './components/shared/RobloxStatusBanner';
import { TutorialGate } from './components/tutorial/TutorialGate';
import { useConfig } from './contexts/ConfigContext';
import { useAppInitialization } from './hooks/useAppInitialization';
import { useLegacyExplorerBridge } from './hooks/useLegacyExplorerBridge';
import { useMcpBridge } from './hooks/useMcpBridge';

const HomePage = lazy(() => import('./components/app/HomePage'));
const SpoofPage = lazy(() => import('./components/app/spoof/SpoofPage'));
const McpPage = lazy(() => import('./components/app/McpPage'));
const ActivityView = lazy(() => import('./components/views/ActivityView'));
const AccountsView = lazy(() => import('./components/views/accounts/AccountsView'));
const SettingsView = lazy(() => import('./components/views/SettingsView'));
const DebugConsole = lazy(() => import('./components/views/DebugConsole'));
const PasteIdsModal = lazy(() => import('./components/modals/PasteIdsModal'));

function PageFallback() {
  return (
    <div className="flex h-full w-full flex-col gap-4 p-8">
      <div className="ts-skeleton h-7 w-48 rounded-lg" />
      <div className="ts-skeleton h-4 w-80 rounded-md" />
      <div className="ts-skeleton mt-4 h-40 w-full rounded-xl" />
    </div>
  );
}

function Page({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'home':
      return <HomePage />;
    case 'spoof':
      return <SpoofPage />;
    case 'accounts':
      return <AccountsView />;
    case 'history':
      return <ActivityView />;
    case 'mcp':
      return <McpPage />;
    case 'settings':
      return <SettingsView />;
  }
}

export default function App() {
  const { config, updateConfig } = useConfig();
  const rawTab = config.ui.activeTab;
  const tab = normalizeTab(rawTab);
  const consoleOpen = Boolean(config.debug?.debugMode);

  const { isRobloxApiDown } = useAppInitialization();
  useMcpBridge();
  useFlowAutoAdvance();

  const [pasteOpen, setPasteOpen] = useState(false);
  const openPasteIds = useCallback(() => setPasteOpen(true), []);
  useLegacyExplorerBridge(openPasteIds);

  // Legacy tab ids ("spoofing", "activity", "console"...) from older configs / components.
  useEffect(() => {
    if (rawTab === 'console') {
      setConsoleOpen(true);
      updateConfig('ui', 'activeTab', 'home');
    } else if (rawTab !== tab) {
      updateConfig('ui', 'activeTab', tab);
    }
  }, [rawTab, tab]);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-background font-sans text-foreground antialiased selection:bg-brand/30">
      <Sidebar activeTab={tab} onTabChange={goTo} />

      <div className="relative z-10 flex h-full min-w-0 flex-1 flex-col">
        <Titlebar />

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <RobloxStatusBanner isVisible={isRobloxApiDown} />
          <PortDiagnosticBanner />

          <main className="relative min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<PageFallback />}>
              <Page key={tab} tab={tab} />
            </Suspense>
          </main>

          {consoleOpen && (
            <div className="relative h-[38%] min-h-[180px] shrink-0">
              <Suspense fallback={null}>
                <DebugConsole isOpen onClose={() => setConsoleOpen(false)} fill />
              </Suspense>
            </div>
          )}
        </div>
      </div>

      {pasteOpen && (
        <Suspense fallback={null}>
          <PasteIdsModal open={pasteOpen} onOpenChange={setPasteOpen} />
        </Suspense>
      )}

      <TutorialGate />
    </div>
  );
}
