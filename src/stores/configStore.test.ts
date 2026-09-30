import * as tauriCore from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppConfigSchema, DEFAULT_APP_CONFIG, useConfigStore } from './configStore';

vi.mock('../utils/tauriRuntime', () => ({
  isTauriRuntime: vi.fn().mockReturnValue(true),
}));

describe('configStore', () => {
  const storeData: Record<string, string> = {};
  const mockLocalStorage = {
    getItem: vi.fn((key: string) => storeData[key] || null),
    setItem: vi.fn((key: string, val: string) => {
      storeData[key] = val;
    }),
    clear: vi.fn(() => {
      for (const k of Object.keys(storeData)) delete storeData[k];
    }),
  };

  beforeEach(() => {
    vi.stubGlobal('localStorage', mockLocalStorage);
    localStorage.clear();
    useConfigStore.getState().resetConfig();
    useConfigStore.setState({ secretsLoadFailed: false, importingStudioAccounts: false });
    vi.clearAllMocks();
    vi.mocked(tauriCore.invoke).mockReset().mockResolvedValue(undefined);
  });

  it('initializes with default config', () => {
    const { config } = useConfigStore.getState();
    expect(config).toEqual(DEFAULT_APP_CONFIG);
  });

  it('migrates a retired animation mode without dropping account or upload settings', () => {
    const saved = {
      ...DEFAULT_APP_CONFIG,
      spoofing: {
        ...DEFAULT_APP_CONFIG.spoofing,
        animationMode: 'track_loader',
        selectedUser: '12345',
        selectedGroup: '67890',
      },
    };
    const next = AppConfigSchema.parse(saved);
    expect(next.spoofing.animationMode).toBe('animation');
    expect(next.spoofing.selectedUser).toBe('12345');
    expect(next.spoofing.selectedGroup).toBe('67890');
    for (const animationMode of ['clip_replace', 'clip_parent'])
      expect(
        AppConfigSchema.parse({ ...saved, spoofing: { ...saved.spoofing, animationMode } }).spoofing
          .animationMode,
      ).toBe(animationMode);
  });

  it('updates a specific config value', () => {
    useConfigStore.getState().updateConfig('general', 'desktopNotifications', false);
    const { config } = useConfigStore.getState();
    expect(config.general.desktopNotifications).toBe(false);
  });

  it('updates an entire category', () => {
    useConfigStore
      .getState()
      .updateCategory('spoofing', { cookie: 'test_cookie', apiKey: 'test_key' });
    const { config } = useConfigStore.getState();
    expect(config.spoofing.cookie).toBe('test_cookie');
    expect(config.spoofing.apiKey).toBe('test_key');
  });

  it('resets to default config', () => {
    useConfigStore.getState().updateConfig('general', 'desktopNotifications', false);
    useConfigStore.getState().resetConfig();
    const { config } = useConfigStore.getState();
    expect(config.general.desktopNotifications).toBe(true);
  });

  it('loads secrets from backend', async () => {
    const invokeMock = (tauriCore.invoke as any).mockResolvedValueOnce({
      cookie: 'backend_cookie',
      apiKey: 'backend_key',
    });

    await useConfigStore.getState().loadSecrets();
    const { config } = useConfigStore.getState();

    expect(invokeMock).toHaveBeenCalledWith('load_profile_secrets');
    expect(config.spoofing.cookie).toBe('backend_cookie');
    expect(config.spoofing.apiKey).toBe('backend_key');
  });

  it('saves secrets to backend', async () => {
    const invokeMock = (tauriCore.invoke as any).mockResolvedValueOnce(undefined);

    useConfigStore.setState({ secretsLoaded: true });

    useConfigStore
      .getState()
      .updateCategory('spoofing', { cookie: 'new_cookie', apiKey: 'new_key' });
    await useConfigStore.getState().saveSecrets();

    expect(invokeMock).toHaveBeenCalledWith('save_profile_secrets', {
      data: {
        cookie: 'new_cookie',
        apiKey: 'new_key',
        groupApiKey: '',
        profileCookies: {},
        accountSecrets: {},
      },
    });
  });

  it('does not save secrets before the initial load completes', async () => {
    const invokeMock = (tauriCore.invoke as any).mockResolvedValueOnce(undefined);
    useConfigStore.setState({ secretsLoaded: false });

    useConfigStore
      .getState()
      .updateCategory('spoofing', { cookie: 'race_cookie', apiKey: 'race_key' });
    await useConfigStore.getState().saveSecrets();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('shares an in-flight vault load between concurrent startup calls', async () => {
    let resolveLoad: (value: object) => void = () => {};
    const pending = new Promise<object>((resolve) => {
      resolveLoad = resolve;
    });
    vi.mocked(tauriCore.invoke).mockImplementation(async () => pending);
    const first = useConfigStore.getState().loadSecrets();
    const second = useConfigStore.getState().loadSecrets();
    resolveLoad({ accountSecrets: {} });
    await Promise.all([first, second]);
    expect(
      vi
        .mocked(tauriCore.invoke)
        .mock.calls.filter(([command]) => command === 'load_profile_secrets'),
    ).toHaveLength(1);
    expect(useConfigStore.getState().secretsLoadFailed).toBe(false);
  });

  it('blocks vault writes after loading fails and permits a successful retry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(tauriCore.invoke).mockRejectedValueOnce(new Error('vault locked'));
    await useConfigStore.getState().loadSecrets();
    expect(useConfigStore.getState().secretsLoadFailed).toBe(true);
    await expect(useConfigStore.getState().persistSecrets()).rejects.toThrow(/could not be loaded/);
    expect(
      vi
        .mocked(tauriCore.invoke)
        .mock.calls.some(([command]) => command === 'save_profile_secrets'),
    ).toBe(false);
    vi.mocked(tauriCore.invoke).mockResolvedValueOnce({ accountSecrets: {} });
    await useConfigStore.getState().loadSecrets();
    expect(useConfigStore.getState().secretsLoadFailed).toBe(false);
    warning.mockRestore();
  });
});
