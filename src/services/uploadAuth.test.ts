import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSpooferStore } from '../stores/spooferStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { validateCookieProfile } from '../utils/robloxProfiles';
import { profileUploadAuth, resolveUploadAuth, uploadAuthNoticeKey } from '../utils/uploadAuth';
import { getActiveTarget, runSpoof } from './spoofer';

vi.mock('../utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('../utils/apiClient', () => ({ getStudioPlaceIdFallback: vi.fn().mockResolvedValue('') }));
vi.mock('../utils/robloxProfiles', async (original) => ({
  ...(await original<typeof import('../utils/robloxProfiles')>()),
  validateCookieProfile: vi.fn(),
}));

describe('upload authentication selection', () => {
  it.each(['none', '222'])('accepts no keys for destination %s', (groupId) => {
    expect(resolveUploadAuth({ groupId, apiKey: '  ', groupApiKey: '' })).toEqual({
      method: 'session',
      apiKey: '',
      isGroup: groupId !== 'none',
    });
  });

  it('keeps group keys out of personal publication and prefers them for group publication', () => {
    const keys = { apiKey: 'personal-fixture', groupApiKey: 'group-fixture' };
    expect(resolveUploadAuth({ ...keys, groupId: 'none' }).method).toBe('personal_key');
    expect(resolveUploadAuth({ ...keys, groupId: '222' }).method).toBe('group_key');
    expect(resolveUploadAuth({ groupApiKey: keys.groupApiKey, groupId: 'none' }).apiKey).toBe('');
  });

  it('identifies personal-key fallback for groups and permits explicit session use', () => {
    const auth = resolveUploadAuth({ apiKey: 'personal-fixture', groupId: '222' });
    expect(uploadAuthNoticeKey(auth)).toBe('personalKeyForGroup');
    expect(
      resolveUploadAuth({
        apiKey: 'personal-fixture',
        groupApiKey: 'group-fixture',
        groupId: '222',
        mode: 'session',
      }),
    ).toEqual({
      method: 'session',
      apiKey: '',
      isGroup: true,
    });
  });

  it('does not borrow the active account key for another profile', () => {
    const config = structuredClone(DEFAULT_APP_CONFIG);
    config.spoofing.selectedUser = '111';
    config.spoofing.apiKey = 'other-account-fixture';
    expect(profileUploadAuth(config, {}, '333').apiKey).toBe('');
  });
});

describe('upload job authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const config = structuredClone(DEFAULT_APP_CONFIG);
    config.accounts = [
      { id: '111', name: 'Fixture', isDownloader: true, isUploader: false, cookieValidated: true },
    ];
    config.spoofing.selectedUser = '111';
    config.spoofing.cookie = 's'.repeat(60);
    useConfigStore.setState({
      config,
      accountSecrets: { '111': { cookie: config.spoofing.cookie } },
      secretsLoaded: true,
      secretsLoadFailed: false,
      importingStudioAccounts: false,
    });
    useSpooferStore.setState({
      isPreparingJob: false,
      isSpoofing: false,
      isReplacing: false,
      isScanningStudio: false,
      assetForcePlaceIds: {},
      lastReplacements: {},
    });
    useSessionStore.getState().clear();
    useUpdaterStore.setState({ status: 'idle' });
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(validateCookieProfile).mockResolvedValue({
      user: { id: 111, name: 'fixture', displayName: 'Fixture' },
      cookie: config.spoofing.cookie,
    });
  });

  it.each(['none', '222'])(
    'launches destination %s through the session branch without key prevalidation',
    async (groupId) => {
      useConfigStore.getState().updateConfig('spoofing', 'selectedGroup', groupId);
      const result = await runSpoof({ assetIds: ['12345678'] });
      expect(result.ok).toBe(true);
      expect(invoke).toHaveBeenCalledWith(
        'run_spoofer_action',
        expect.objectContaining({
          data: expect.objectContaining({
            apiKey: '',
            groupId: groupId === 'none' ? null : groupId,
            account: expect.objectContaining({ id: '111' }),
          }),
        }),
      );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(([command]) => command === 'detect_opencloud_api_key_owner'),
      ).toBe(false);
    },
  );

  it('uses session mode with saved rejected keys without erasing or sending them', async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        accounts: state.config.accounts.map((account) => ({
          ...account,
          uploadAuthMode: 'session' as const,
          apiKeyValidated: false,
        })),
      },
      accountSecrets: {
        '111': {
          cookie: 's'.repeat(60),
          apiKey: 'saved-personal-fixture',
          groupApiKey: 'saved-group-fixture',
        },
      },
    }));
    expect(getActiveTarget().uploadAuthMethod).toBe('session');
    expect((await runSpoof({ assetIds: ['12345678'] })).ok).toBe(true);
    expect(useSpooferStore.getState().jobTarget?.apiKey).toBe('');
    expect(useConfigStore.getState().accountSecrets['111'].apiKey).toBe('saved-personal-fixture');
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === 'detect_opencloud_api_key_owner'),
    ).toBe(false);
  });

  it('reports an explicitly selected rejected key with guidance instead of changing authentication silently', async () => {
    useConfigStore.setState({
      accountSecrets: { '111': { cookie: 's'.repeat(60), apiKey: 'invalid-key-fixture' } },
    });
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'detect_opencloud_api_key_owner'
        ? { ok: false, message: 'Invalid API key' }
        : null,
    );
    const result = await runSpoof({ assetIds: ['12345678'] });
    expect(result).toMatchObject({ ok: false, reason: 'bad_api_key' });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'run_spoofer_action')).toBe(
      false,
    );
    expect(useSpooferStore.getState().isPreparingJob).toBe(false);
  });
});
