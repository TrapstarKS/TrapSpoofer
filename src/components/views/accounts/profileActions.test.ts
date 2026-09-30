import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, useConfigStore } from '../../../stores/configStore';
import { validateCookieProfile } from '../../../utils/robloxProfiles';
import { profileNeedsAttention, revalidateProfile } from './profileActions';

vi.mock('../../../utils/robloxProfiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/robloxProfiles')>();
  return { ...actual, validateCookieProfile: vi.fn() };
});

describe('profileActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConfigStore.setState({
      config: structuredClone(DEFAULT_APP_CONFIG),
      accountSecrets: {},
      secretsLoaded: true,
    });
  });

  it('does not require an API key for a validated session', () => {
    const profile = {
      id: '42',
      name: 'User',
      isDownloader: true,
      isUploader: false,
      cookieValidated: true,
    };
    useConfigStore.getState().updateAccountsList([profile]);
    useConfigStore.setState({ accountSecrets: { '42': { cookie: 's'.repeat(60) } } });

    expect(profileNeedsAttention(profile)).toBe(false);
  });

  it('revalidates a session successfully when no API key is saved', async () => {
    useConfigStore.getState().updateAccountsList([
      {
        id: '42',
        name: 'User',
        isDownloader: true,
        isUploader: false,
        cookieValidated: true,
      },
    ]);
    useConfigStore.setState({ accountSecrets: { '42': { cookie: 's'.repeat(60) } } });
    vi.mocked(validateCookieProfile).mockResolvedValue({
      user: { id: 42, name: 'user42', displayName: 'User 42' },
      cookie: 's'.repeat(60),
    });

    await expect(revalidateProfile('42')).resolves.toBe(true);
    expect(useConfigStore.getState().config.accounts[0].apiKeyValidated).toBeUndefined();
  });

  it('only warns about the key selected for the current destination', () => {
    const profile = {
      id: '42',
      name: 'User',
      isDownloader: true,
      isUploader: true,
      cookieValidated: true,
      apiKeyValidated: false,
      groupApiKeyValidated: true,
    };
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        accounts: [profile],
        spoofing: { ...state.config.spoofing, selectedUser: '42', selectedGroup: '222' },
      },
      accountSecrets: {
        '42': { cookie: 's'.repeat(60), apiKey: 'personal-fixture', groupApiKey: 'group-fixture' },
      },
    }));
    expect(profileNeedsAttention(profile)).toBe(false);
    useConfigStore.getState().updateConfig('spoofing', 'selectedGroup', 'none');
    expect(profileNeedsAttention(profile)).toBe(true);
    useConfigStore.getState().updateAccountsList([{ ...profile, uploadAuthMode: 'session' }]);
    expect(profileNeedsAttention(useConfigStore.getState().config.accounts[0])).toBe(false);
  });
});
