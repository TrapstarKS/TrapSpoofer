import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as spoofer from '../services/spoofer';
import { useSpooferStore } from '../stores/spooferStore';
import { handlers } from './handlers';

const jobId = '68c62c9c-d841-4cb5-91ae-1cef9d51f507';
const olderId = '68c62c9c-d841-4cb5-91ae-1cef9d51f508';
const uploaded = {
  id: '12345',
  success: true,
  newId: '11111',
  meshId: '22222',
  moderation: 'approved' as const,
  permission: { status: 'granted' as const },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useSpooferStore.setState({
    isPreparingJob: false,
    isSpoofing: false,
    isReplacing: false,
    jobStatus: 'finished',
    lastJobId: jobId,
    activeSpooferJobId: null,
    spoofTotalCount: 1,
    spoofCurrentCount: 1,
    spoofProgress: 100,
    spoofStatusText: 'Initializing...',
    assetMetadataMap: { '12345': { name: 'Mesh', type: 'mesh' } },
    lastAssetResults: [uploaded],
    lastReplacements: { '12345': '11111', '99999': '88888' },
  });
});
afterEach(() => vi.useRealTimers());

it('returns job assets and usable mesh IDs without leaking global mappings', async () => {
  await expect(handlers.get_job({})).resolves.toMatchObject({
    done: true,
    status: 'finished',
    assets: [uploaded],
  });
  expect(await handlers.get_job({})).not.toHaveProperty('mappings');
  expect(await handlers.get_job({ includeMappings: true })).toMatchObject({
    mappings: { '12345': '22222' },
  });
});

it('scopes retry results and maps failures even when the UI text is stale', async () => {
  useSpooferStore.setState({
    lastAssetResults: [uploaded, { id: '99999', success: true, newId: '88888' }],
  });
  expect(spoofer.jobSnapshot().assets).toEqual([uploaded]);
  useSpooferStore.setState({
    lastAssetResults: [{ id: '12345', success: false, errorReason: 'Denied' }],
  });
  expect(spoofer.jobSnapshot()).toMatchObject({ running: false, done: true, status: 'failed' });
  useSpooferStore.setState({ lastAssetResults: [], jobStatus: 'failed' });
  expect(spoofer.jobSnapshot().status).toBe('failed');
});

it('summary returns state, counts and failures without any asset payload', async () => {
  const result = await handlers.get_job({ summary: true, includeMappings: true });
  expect(result).toEqual({
    jobId,
    status: 'finished',
    running: false,
    done: true,
    counts: {
      total: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      moderation: { approved: 1, pending: 0, rejected: 0 },
      permission: { granted: 1, failed: 0, not_requested: 0 },
    },
    failures: [],
  });
});

it('caps the effective wait and returns partial results with done false on timeout', async () => {
  vi.useFakeTimers();
  useSpooferStore.setState({
    isSpoofing: true,
    activeSpooferJobId: jobId,
    jobStatus: 'running',
    spoofTotalCount: 2,
    assetMetadataMap: {
      '12345': { name: 'Mesh', type: 'mesh' },
      '67890': { name: 'Next', type: 'image' },
    },
  });
  const pending = handlers.get_job({ jobId, waitSeconds: 600 });
  await vi.advanceTimersByTimeAsync(100_000);
  await expect(pending).resolves.toMatchObject({
    done: false,
    running: true,
    status: 'running',
    counts: { completed: 1, pending: 1 },
    assets: [uploaded, { id: '67890', stage: 'queued' }],
  });
});

it('wait tracks the requested job rather than a newly started one', async () => {
  vi.useFakeTimers();
  useSpooferStore.setState({ isSpoofing: true, activeSpooferJobId: jobId });
  const wait = spoofer.waitForJob(100_000, jobId);
  useSpooferStore.setState({ activeSpooferJobId: olderId });
  await expect(wait).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the completed job terminal during unrelated preparation or manual Studio replacement', async () => {
  useSpooferStore.setState({ isPreparingJob: true, isReplacing: true, activeSpooferJobId: null });
  expect(spoofer.jobSnapshot()).toMatchObject({
    jobId,
    done: true,
    running: false,
    status: 'finished',
  });
  await expect(spoofer.waitForJob(100_000, jobId)).resolves.toBe(true);
});

it('returns queued state and treats negative wait as an immediate snapshot', async () => {
  useSpooferStore.setState({ isSpoofing: true, activeSpooferJobId: jobId, jobStatus: 'queued' });
  const wait = vi.spyOn(spoofer, 'waitForJob');
  await expect(handlers.get_job({ waitSeconds: -2 })).resolves.toMatchObject({
    status: 'queued',
    done: false,
  });
  expect(wait).not.toHaveBeenCalled();
});

it('historical jobs have the same scoped response and compact history supports filtering', async () => {
  vi.mocked(invoke).mockResolvedValue([
    {
      id: olderId,
      status: 'partially_finished',
      config: { publishFiles: ['large'] },
      assetResults: [uploaded, { id: '67890', success: false, errorReason: 'Denied' }],
    },
    { id: jobId, status: 'successful', assetResults: [uploaded] },
  ]);
  await expect(handlers.get_job({ jobId: olderId, includeMappings: true })).resolves.toMatchObject({
    status: 'failed',
    done: true,
    mappings: { '12345': '22222' },
    failures: [{ id: '67890', reason: 'Denied' }],
  });
  const history = (await handlers.get_history({ jobId: olderId })) as Record<string, unknown>[];
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ id: olderId, counts: { total: 2 } });
  expect(history[0]).not.toHaveProperty('assetResults');
  expect(history[0]).not.toHaveProperty('config');
  const summary = (await handlers.get_history({ jobId: olderId, summary: true })) as Record<
    string,
    unknown
  >[];
  expect(summary[0]).not.toHaveProperty('account');
  expect(summary[0]).not.toHaveProperty('startTime');
});

it('lookup returns only the requested IDs and uses current results before older history', async () => {
  vi.mocked(invoke).mockResolvedValue([
    { assetResults: [{ ...uploaded, newId: 'old', meshId: 'old' }] },
  ]);
  await expect(handlers.lookup_ids({ ids: ['12345', '22222', '99999'] })).resolves.toEqual([
    { id: '12345', found: true, newId: '22222', type: null, moderation: 'approved' },
    { id: '22222', found: true, newId: '22222', type: null, moderation: 'approved' },
    { id: '99999', found: false, newId: null, type: null, moderation: null },
  ]);
});

it('access requires exactly one target and does not grant permissions', async () => {
  await expect(handlers.check_access({ assetIds: ['12345'] })).rejects.toThrow();
  await expect(
    handlers.check_access({ assetIds: ['12345'], universeId: '3', groupId: '4' }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue([{ assetId: '12345', granted: false }]);
  await handlers.check_access({ assetIds: ['12345'], groupId: '4' });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    'check_asset_access',
    expect.objectContaining({ groupId: '4', universeId: null }),
  );
});

it('moderation recheck updates current results without launching any job', async () => {
  useSpooferStore.setState({ lastAssetResults: [{ ...uploaded, moderation: 'pending' }] });
  vi.mocked(invoke).mockResolvedValue([
    { assetId: '22222', moderation: 'approved', checked: true },
  ]);
  await handlers.recheck_moderation({ assetIds: ['22222'] });
  expect(useSpooferStore.getState().lastAssetResults[0].moderation).toBe('approved');
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    'recheck_asset_moderation',
    expect.objectContaining({ assetIds: ['22222'] }),
  );
});

it('mesh application validates IDs and preserves the default size option', async () => {
  await expect(
    handlers.apply_mesh_to_studio({ meshId: 'bad', instancePath: 'Workspace.Part' }),
  ).rejects.toThrow();
  vi.mocked(invoke)
    .mockResolvedValueOnce({ sessions: [] })
    .mockResolvedValueOnce({ success: true });
  await handlers.apply_mesh_to_studio({ meshId: '22222', instancePath: 'Workspace.Part' });
  expect(invoke).toHaveBeenLastCalledWith(
    'apply_mesh_to_studio',
    expect.objectContaining({
      meshId: '22222',
      instancePath: 'Workspace.Part',
      preserveSize: true,
    }),
  );
});

it('passes mesh normalization through dry-run inspection and the upload pipeline', async () => {
  vi.mocked(invoke).mockResolvedValue([{ path: '/part.obj', type: 'Mesh', cacheHit: false }]);
  await handlers.publish_assets({
    files: [{ path: '/part.obj' }],
    normalizeCenter: true,
    dry_run: true,
  });
  expect(invoke).toHaveBeenCalledWith(
    'inspect_publish_files',
    expect.objectContaining({ normalizeCenter: true }),
  );
  const run = vi.spyOn(spoofer, 'runAssetAction').mockResolvedValue({ jobId, assets: 1 });
  await handlers.publish_assets({ files: [{ path: '/part.obj' }], normalizeCenter: true });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ normalizeCenter: true }));
});

it('retains normalization when retrying a historical mesh so it reuses its cache entry', async () => {
  vi.mocked(invoke).mockResolvedValue([
    {
      id: olderId,
      account: { id: '123' },
      config: { kind: 'publish', normalizeCenter: true, publishFiles: [{ path: '/part.obj' }] },
      assetResults: [{ id: '/part.obj', success: false, meshMetadataError: 'Still processing' }],
    },
  ]);
  const run = vi.spyOn(spoofer, 'runAssetAction').mockResolvedValue({ jobId, assets: 1 });
  await handlers.retry_failed({ jobId: olderId });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ files: [{ path: '/part.obj' }], normalizeCenter: true }),
  );
});
