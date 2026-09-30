import * as tauriCore from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, useConfigStore } from '../stores/configStore';
import { useSpooferStore } from '../stores/spooferStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { activateProfile } from './spoofer';
import { importStudioAccounts } from './studioAccounts';

vi.mock('../utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('./spoofer', () => ({ activateProfile: vi.fn().mockResolvedValue(undefined) }));

const sessionValue = 's'.repeat(60);

function response(accounts: Array<{ id: number; current?: boolean }>, rejectedCount = 0) {
  return {
    accounts: accounts.map(({ id, current }) => ({
      user: { id, name: `user${id}`, displayName: `User ${id}` },
      cookie: sessionValue,
      isCurrent: Boolean(current),
    })),
    rejectedCount,
    failedCount: 0,
  };
}

describe('importStudioAccounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useConfigStore.setState({
      config: structuredClone(DEFAULT_APP_CONFIG),
      accountSecrets: {},
      secretsLoaded: true,
      secretsLoadFailed: false,
      importingStudioAccounts: false,
    });
    useSpooferStore.setState({
      isPreparingJob: false,
      isSpoofing: false,
      isScanningStudio: false,
      isReplacing: false,
      isGrantingPermissions: false,
      isDiscoveringPlaceIds: false,
      parsingFileName: null,
    });
    useUpdaterStore.setState({ status: 'idle' });
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([]);
      if (command === 'save_profile_secrets') return undefined;
      return undefined;
    });
  });

  it('dedupes validated accounts and activates the current Studio account when no valid choice exists', async () => {
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts')
        return response([{ id: 10 }, { id: 10 }, { id: 20, current: true }]);
      return undefined;
    });

    const result = await importStudioAccounts();

    expect(result.importedIds).toEqual(['10', '20']);
    expect(useConfigStore.getState().config.accounts.map((item) => item.id)).toEqual(['10', '20']);
    expect(useConfigStore.getState().accountSecrets['10']?.cookie?.length).toBe(
      sessionValue.length,
    );
    expect(activateProfile).toHaveBeenCalledWith('20', null);
  });

  it('preserves an existing valid profile and group selection', async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        accounts: [
          {
            id: '10',
            name: 'Existing',
            isDownloader: true,
            isUploader: false,
            cookieValidated: true,
          },
        ],
        spoofing: { ...state.config.spoofing, selectedUser: '10', selectedGroup: '777' },
      },
      accountSecrets: { '10': { cookie: sessionValue } },
    }));
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([{ id: 20, current: true }]);
      return undefined;
    });

    await importStudioAccounts();

    expect(useConfigStore.getState().config.spoofing.selectedUser).toBe('10');
    expect(useConfigStore.getState().config.spoofing.selectedGroup).toBe('777');
    expect(activateProfile).not.toHaveBeenCalled();
  });

  it('refreshes the active profile secret mirror without changing its group', async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        accounts: [
          {
            id: '10',
            name: 'Existing',
            isDownloader: true,
            isUploader: false,
            cookieValidated: true,
          },
        ],
        spoofing: { ...state.config.spoofing, selectedUser: '10', selectedGroup: '777' },
      },
      accountSecrets: { '10': { cookie: sessionValue } },
    }));
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([{ id: 10, current: true }]);
      return undefined;
    });

    await importStudioAccounts();

    expect(activateProfile).toHaveBeenCalledWith('10', '777');
  });

  it('does not perform a second authentication request in the frontend', async () => {
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([{ id: 20, current: true }]);
      return undefined;
    });

    await importStudioAccounts();

    const commands = vi.mocked(tauriCore.invoke).mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command === 'detect_studio_accounts')).toHaveLength(1);
    expect(commands).not.toContain('get_roblox_user_info');
    expect(commands).not.toContain('get_cookie_from_roblox_studio');
  });

  it('does not activate anything when Studio only returns rejected sessions', async () => {
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([], 2);
      return undefined;
    });

    const result = await importStudioAccounts();

    expect(result.importedCount).toBe(0);
    expect(result.rejectedCount).toBe(2);
    expect(activateProfile).not.toHaveBeenCalled();
  });

  it('falls back to the first validated account when no current Studio account is available', async () => {
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([{ id: 30 }, { id: 40 }], 1);
      return undefined;
    });

    const result = await importStudioAccounts();

    expect(result.activatedId).toBe('30');
    expect(activateProfile).toHaveBeenCalledWith('30', null);
  });

  it('does not inspect Studio credentials while a job is active', async () => {
    useSpooferStore.setState({ isSpoofing: true });

    await expect(importStudioAccounts()).rejects.toThrow(/current job or update/);

    expect(tauriCore.invoke).not.toHaveBeenCalledWith('detect_studio_accounts');
  });

  it('shares one backend detection across concurrent imports', async () => {
    let release: (value: ReturnType<typeof response>) => void = () => {};
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      release = resolve;
    });
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return pending;
      return undefined;
    });

    const first = importStudioAccounts();
    const second = importStudioAccounts();
    release(response([{ id: 20, current: true }]));
    await Promise.all([first, second]);

    expect(
      vi
        .mocked(tauriCore.invoke)
        .mock.calls.filter(([command]) => command === 'detect_studio_accounts'),
    ).toHaveLength(1);
  });

  it('does not overwrite a profile choice changed while import is in flight', async () => {
    let release: (value: ReturnType<typeof response>) => void = () => {};
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      release = resolve;
    });
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return pending;
      return undefined;
    });

    const importing = importStudioAccounts();
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        spoofing: { ...state.config.spoofing, selectedUser: 'manual-choice', selectedGroup: '55' },
      },
    }));
    release(response([{ id: 20, current: true }]));
    await importing;

    expect(useConfigStore.getState().config.spoofing.selectedUser).toBe('manual-choice');
    expect(useConfigStore.getState().config.spoofing.selectedGroup).toBe('55');
    expect(activateProfile).not.toHaveBeenCalled();
  });

  it('does not report success when the final vault persistence fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return response([{ id: 20, current: true }]);
      if (command === 'save_profile_secrets') throw new Error('vault unavailable');
      return undefined;
    });

    await expect(importStudioAccounts()).rejects.toThrow(/vault unavailable/);
    expect(activateProfile).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not import after an initial vault load failure', async () => {
    useConfigStore.setState({ secretsLoadFailed: true });
    await expect(importStudioAccounts()).rejects.toThrow(/vault is unavailable/);
    expect(tauriCore.invoke).not.toHaveBeenCalled();
    expect(useConfigStore.getState().importingStudioAccounts).toBe(false);
  });

  it('allows login while an update downloads and holds the install guard until import finishes', async () => {
    useUpdaterStore.setState({ status: 'downloading' });
    let resolveDetection: (value: ReturnType<typeof response>) => void = () => {};
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveDetection = resolve;
    });
    vi.mocked(tauriCore.invoke).mockImplementation(async (command: string) => {
      if (command === 'detect_studio_accounts') return pending;
      return undefined;
    });
    const importing = importStudioAccounts();
    expect(useConfigStore.getState().importingStudioAccounts).toBe(true);
    resolveDetection(response([{ id: 10, current: true }]));
    await importing;
    expect(activateProfile).toHaveBeenCalledWith('10', null);
    expect(useConfigStore.getState().importingStudioAccounts).toBe(false);
  });
});
