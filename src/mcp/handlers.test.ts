import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as spoofer from '../services/spoofer';
import { DEFAULT_APP_CONFIG, useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSpooferStore } from '../stores/spooferStore';
import { handlers } from './handlers';
import { sanitizeMcp } from './sanitize';
import { getSettings } from './settings';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useConfigStore.setState({ config: structuredClone(DEFAULT_APP_CONFIG), accountSecrets: {} });
  useSpooferStore.setState({ isSpoofing: false, isPreparingJob: false, isReplacing: false });
  useSessionStore.setState({ autoApplyOverride: null, assets: [] });
});

describe('MCP shared configuration and previews', () => {
  it('patches shared UI settings atomically and keeps omitted fields', async () => {
    await handlers.update_settings({
      grantPermissions: { enabled: true, subjectType: 'Group', ids: ['764544807'] },
    });
    await handlers.update_settings({ skipOwned: true });
    expect(getSettings()).toMatchObject({
      skipOwned: true,
      keepNameAndDescription: true,
      grantPermissions: { enabled: true, subjectType: 'Group', ids: ['764544807'] },
    });
    expect(useConfigStore.getState().config.permissions).toEqual({
      enabled: true,
      subjectType: 'group',
      subjectIds: '764544807',
      action: 'Use',
    });
    const before = getSettings();
    await expect(
      handlers.update_settings({ skipOwned: false, grantPermissions: { ids: ['invalid'] } }),
    ).rejects.toThrow();
    expect(getSettings()).toEqual(before);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('spoof and permission dry runs never invoke the backend or mutate job state', async () => {
    await expect(
      handlers.spoof_assets({ assetIds: ['12345678'], autoPush: true, dry_run: true }),
    ).resolves.toMatchObject({ dry_run: true, count: 1, quotaEstimate: { uploads: 1 } });
    await expect(
      handlers.grant_permissions({
        assetIds: ['12345678'],
        subjectType: 'Group',
        ids: ['764544807'],
        dry_run: true,
      }),
    ).resolves.toMatchObject({ dry_run: true, count: 1, quotaEstimate: { uploads: 0 } });
    expect(invoke).not.toHaveBeenCalled();
    expect(useSessionStore.getState().autoApplyOverride).toBeNull();
    expect(useSpooferStore.getState().isSpoofing).toBe(false);
  });

  it('publish dry run only inspects files and reports cache quota savings', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { path: '/a.png', type: 'Image', cacheHit: true },
      { path: '/b.mesh', type: 'Mesh', cacheHit: false },
    ]);
    await expect(
      handlers.publish_assets({
        files: [{ path: '/a.png' }, { path: '/b.mesh' }],
        pushToStudio: true,
        dry_run: true,
      }),
    ).resolves.toMatchObject({ dry_run: true, quotaEstimate: { uploads: 1 } });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('inspect_publish_files', expect.any(Object));
    expect(useSpooferStore.getState().isSpoofing).toBe(false);
  });

  it('rejects unrecognized or malformed inputs before writes', async () => {
    await expect(handlers.spoof_assets({ dry_run: 'false' })).rejects.toThrow();
    await expect(
      handlers.publish_assets({ files: [{ path: '/a.png' }], cookie: 'secret' }),
    ).rejects.toThrow();
    await expect(
      handlers.grant_permissions({ assetIds: ['bad'], subjectType: 'Group', ids: ['3'] }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});

it('removes nested credential fields and exact secret values from errors, keys and logs', () => {
  const cookie = 'synthetic-cookie-value';
  const key = 'synthetic-api-key-value';
  const value = sanitizeMcp(
    {
      hasCookie: true,
      hasApiKey: true,
      cookie,
      nested: { apiKey: key },
      logs: [`failed: ${cookie}`, `x-api-key=${key}`, `.ROBLOSECURITY=${cookie}`],
      [key]: 'a',
    },
    [cookie, key],
  );
  const encoded = JSON.stringify(value);
  expect(encoded).not.toContain(cookie);
  expect(encoded).not.toContain(key);
  expect(value).toMatchObject({ hasCookie: true, hasApiKey: true, nested: {} });
});

it('retries a published asset permission by ID even if its source file has changed', async () => {
  const jobId = '68c62c9c-d841-4cb5-91ae-1cef9d51f507';
  const grantPermissions = { enabled: true, subjectType: 'Group', ids: ['764544807'] };
  vi.mocked(invoke).mockResolvedValueOnce([
    {
      id: jobId,
      account: { id: '291416696' },
      config: {
        kind: 'publish',
        publishFiles: [{ path: '/changed.png' }],
        grantPermissions,
        groupId: null,
      },
      assetResults: [
        {
          id: '/changed.png',
          path: '/changed.png',
          imageId: '133133921355706',
          newId: '133133921355706',
          success: false,
          permission: { status: 'failed', reason: 'rate limited' },
        },
      ],
    },
  ]);
  const run = vi.spyOn(spoofer, 'runAssetAction').mockResolvedValue({ jobId: 'retry', assets: 1 });
  await expect(handlers.retry_failed({ jobId })).resolves.toMatchObject({ started: true });
  expect(run).toHaveBeenCalledWith({
    files: [],
    assetIds: ['133133921355706'],
    profile: '291416696',
    groupId: null,
    grantPermissions,
  });
});
