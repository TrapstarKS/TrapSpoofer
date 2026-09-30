import { invoke } from '@tauri-apps/api/core';

import { useConfigStore } from '../stores/configStore';
import { useSpooferStore } from '../stores/spooferStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { mergeCachedUser, normalizeId, type RobloxUserInfo } from '../utils/robloxProfiles';
import { isTauriRuntime } from '../utils/tauriRuntime';
import { activateProfile } from './spoofer';

interface StudioAccount {
  user: RobloxUserInfo;
  cookie: string;
  isCurrent: boolean;
}

interface StudioAccountsResponse {
  accounts: StudioAccount[];
  rejectedCount: number;
  failedCount: number;
}

export interface StudioAccountImportResult {
  importedCount: number;
  importedIds: string[];
  currentAccountId: string | null;
  activatedId: string | null;
  rejectedCount: number;
  failedCount: number;
  users: RobloxUserInfo[];
}

let importFlight: Promise<StudioAccountImportResult> | null = null;

function importBlocked() {
  const work = useSpooferStore.getState();
  const updateStatus = useUpdaterStore.getState().status;
  return (
    work.isPreparingJob ||
    work.isSpoofing ||
    work.isScanningStudio ||
    work.isReplacing ||
    work.isGrantingPermissions ||
    work.isDiscoveringPlaceIds ||
    Boolean(work.parsingFileName) ||
    updateStatus === 'installing' ||
    updateStatus === 'installed'
  );
}

function hasValidSelection() {
  const { config, accountSecrets } = useConfigStore.getState();
  const selected = config.spoofing.selectedUser;
  if (!selected || selected === 'none') return false;
  const account = config.accounts.find((item) => normalizeId(item.id) === normalizeId(selected));
  return Boolean(account?.cookieValidated === true && accountSecrets[selected]?.cookie?.trim());
}

async function runImport(): Promise<StudioAccountImportResult> {
  if (!isTauriRuntime())
    return {
      importedCount: 0,
      importedIds: [],
      currentAccountId: null,
      activatedId: null,
      rejectedCount: 0,
      failedCount: 0,
      users: [],
    };
  if (importBlocked())
    throw new Error('Finish the current job or update before importing Studio accounts.');
  if (!useConfigStore.getState().secretsLoaded || useConfigStore.getState().secretsLoadFailed)
    throw new Error('The account vault is unavailable. Reopen the app before importing accounts.');

  const initial = useConfigStore.getState();
  const initialUser = initial.config.spoofing.selectedUser;
  const initialGroup = initial.config.spoofing.selectedGroup;
  const hadValidSelection = hasValidSelection();
  const response = await invoke<StudioAccountsResponse>('detect_studio_accounts');
  if (importBlocked())
    throw new Error('Finish the current job or update before importing Studio accounts.');
  if (!useConfigStore.getState().secretsLoaded || useConfigStore.getState().secretsLoadFailed)
    throw new Error('The account vault is unavailable. Reopen the app before importing accounts.');
  const unique = Array.from(
    new Map(response.accounts.map((account) => [normalizeId(account.user.id), account])).values(),
  );
  const importedIds: string[] = [];
  const users: RobloxUserInfo[] = [];
  let currentAccountId: string | null = null;

  for (const account of unique) {
    if (importBlocked())
      throw new Error('Finish the current job or update before importing Studio accounts.');
    const id = normalizeId(account.user.id);
    if (!id || !account.cookie) continue;
    const store = useConfigStore.getState();
    const accounts = [...store.config.accounts];
    const index = accounts.findIndex((item) => normalizeId(item.id) === id);
    const name = account.user.displayName || account.user.name || id;
    if (index >= 0) {
      accounts[index] = {
        ...accounts[index],
        name,
        avatarUrl: account.user.avatarUrl || accounts[index].avatarUrl,
        isDownloader: true,
        cookieValidated: true,
      };
    } else {
      accounts.push({
        id,
        name,
        avatarUrl: account.user.avatarUrl || '',
        isDownloader: true,
        isUploader: false,
        cookieValidated: true,
      });
    }
    store.updateAccountsList(accounts);
    await store.updateAccountSecret(id, account.cookie);
    mergeCachedUser({ ...account.user, authType: 'cookie' });
    importedIds.push(id);
    users.push(account.user);
    if (account.isCurrent) currentAccountId = id;
  }

  if (importedIds.length > 0) await useConfigStore.getState().persistSecrets();

  let activatedId: string | null = null;
  let refreshedSelection = false;
  const after = useConfigStore.getState().config.spoofing;
  const selectionChanged =
    after.selectedUser !== initialUser || after.selectedGroup !== initialGroup;
  if (hadValidSelection && !selectionChanged && importedIds.includes(initialUser)) {
    if (importBlocked())
      throw new Error('Finish the current job or update before importing Studio accounts.');
    await activateProfile(initialUser, initialGroup === 'none' ? null : initialGroup);
    refreshedSelection = true;
  } else if (!hadValidSelection && !selectionChanged) {
    const targetId = currentAccountId ?? importedIds[0] ?? null;
    if (targetId) {
      if (importBlocked())
        throw new Error('Finish the current job or update before importing Studio accounts.');
      await activateProfile(targetId, null);
      activatedId = targetId;
      refreshedSelection = true;
    }
  }
  if (refreshedSelection) await useConfigStore.getState().persistSecrets();

  return {
    importedCount: importedIds.length,
    importedIds,
    currentAccountId,
    activatedId,
    rejectedCount: response.rejectedCount,
    failedCount: response.failedCount,
    users,
  };
}

export function importStudioAccounts(): Promise<StudioAccountImportResult> {
  if (importFlight) return importFlight;
  useConfigStore.setState({ importingStudioAccounts: true });
  importFlight = runImport().finally(() => {
    useConfigStore.setState({ importingStudioAccounts: false });
    importFlight = null;
  });
  return importFlight;
}
