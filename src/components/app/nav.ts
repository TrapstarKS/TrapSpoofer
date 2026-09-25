import { useConfigStore } from '../../stores/configStore';

export type TabId = 'home' | 'spoof' | 'accounts' | 'history' | 'mcp' | 'settings';

export const TAB_IDS: TabId[] = ['home', 'spoof', 'accounts', 'history', 'mcp', 'settings'];

const LEGACY_TABS: Record<string, TabId> = {
  spoofing: 'spoof',
  activity: 'history',
  config: 'settings',
};

/** Maps legacy/unknown tab ids to the new ones. `console` is handled by the caller. */
export function normalizeTab(id: string | undefined | null): TabId {
  if (!id) return 'home';
  if ((TAB_IDS as string[]).includes(id)) return id as TabId;
  return LEGACY_TABS[id] ?? 'home';
}

export function goTo(tab: TabId) {
  useConfigStore.getState().updateConfig('ui', 'activeTab', tab);
}

export function setConsoleOpen(open: boolean) {
  useConfigStore.getState().updateConfig('debug', 'debugMode', open);
}
