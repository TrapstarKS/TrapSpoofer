import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigProvider } from '../contexts/ConfigContext';
import { DEFAULT_APP_CONFIG, useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSpooferStore } from '../stores/spooferStore';
import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { useUpdaterStore } from '../stores/updaterStore';
import type { SpooferAssetResult, SpooferResultPayload } from '../types/tauriEvents';
import { getStudioPlaceIdFallback } from '../utils/apiClient';
import { countJobResults } from '../utils/jobProgress';
import { validateCookieProfile } from '../utils/robloxProfiles';
import { performStudioReplacement } from '../utils/studioReplacementTask';
import type { SpoofAsset } from './assets';
import { pushToStudio, recoverFailed, retryFailed, runSpoof, writeSpoofedFile } from './spoofer';

vi.mock('../utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('../utils/apiClient', () => ({ getStudioPlaceIdFallback: vi.fn() }));
vi.mock('../utils/robloxProfiles', async (original) => ({
  ...(await original<typeof import('../utils/robloxProfiles')>()),
  validateCookieProfile: vi.fn(),
  logIsm: vi.fn(),
}));
vi.mock('../utils/studioReplacementTask', () => ({ performStudioReplacement: vi.fn() }));

const ids = ['12345001', '12345002', '12345003', '12345004', '12345005'];
const assets: SpoofAsset[] = ids.map((id) => ({
  id,
  name: `Animation ${id}`,
  type: 'animation',
  usages: [],
  fromScript: false,
}));
const firstResults: SpooferAssetResult[] = [
  { id: ids[0], success: true, newId: '22345001' },
  { id: ids[1], success: false, errorReason: 'Download failed' },
  { id: ids[2], success: false, cancelled: true },
  { id: ids[3], success: true, skipped: true },
  { id: ids[4], success: false, errorReason: 'Upload failed' },
];

interface JobInput {
  jobId: string;
  assets: string;
  enableArchiveRecovery: boolean;
  placeName: string;
}

let launchError: Error | null = null;

function lastJobInput(): JobInput {
  const call = vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === 'run_spoofer_action')
    .at(-1);
  expect(call).toBeDefined();
  return (call![1] as { data: JobInput }).data;
}

async function finishJob(results: SpooferAssetResult[], extra: Partial<SpooferResultPayload> = {}) {
  await act(async () => {
    await emit('spoofer-result', {
      jobId: useSpooferStore.getState().activeSpooferJobId,
      assetResults: results,
      replacements: {},
      ...extra,
    });
  });
}

async function startFileJob(extension = 'rbxm') {
  useSessionStore.getState().setSource(
    {
      kind: 'file',
      label: `fixture.${extension}`,
      filePath: `/fixtures/fixture.${extension}`,
      scannedAt: 1,
    },
    assets,
  );
  await act(async () => {
    await expect(runSpoof()).resolves.toMatchObject({ ok: true, count: 5 });
  });
  await finishJob(firstResults, { replacements: { [ids[0]]: '22345001' } });
}

async function expectFileMappings(extension: string, mappings: Record<string, string>) {
  await act(async () => {
    await writeSpoofedFile({ outputPath: `/copies/fixture.${extension}` });
  });
  expect(invoke).toHaveBeenLastCalledWith('write_spoofed_place_file', {
    path: `/fixtures/fixture.${extension}`,
    outputPath: `/copies/fixture.${extension}`,
    mappings,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  launchError = null;
  localStorage.clear();
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.general.autoApplyResults = false;
  config.spoofing.selectedUser = '111';
  config.spoofing.cookie = 's'.repeat(60);
  config.accounts = [
    { id: '111', name: 'Fixture', isDownloader: true, isUploader: false, cookieValidated: true },
  ];
  useConfigStore.setState({
    config,
    accountSecrets: { '111': { cookie: config.spoofing.cookie } },
    secretsLoaded: true,
    loadSecrets: vi.fn().mockResolvedValue(undefined),
  });
  useSessionStore.setState(useSessionStore.getInitialState());
  useSpooferStore.setState({
    ...useSpooferStore.getInitialState(),
    lastReplacements: {},
    assetForcePlaceIds: {},
    showToast: vi.fn(),
  });
  useStudioSessionsStore.setState({ selectedSessionId: null, sessions: [] });
  useUpdaterStore.setState({ status: 'idle' });
  vi.mocked(validateCookieProfile).mockResolvedValue({
    user: { id: 111, name: 'fixture', displayName: 'Fixture' },
    cookie: config.spoofing.cookie,
  });
  vi.mocked(getStudioPlaceIdFallback).mockResolvedValue('');
  vi.mocked(performStudioReplacement).mockResolvedValue({ succeeded: 1, failed: 0, total: 1 });
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === 'run_spoofer_action' && launchError) throw launchError;
    if (command === 'write_spoofed_place_file') {
      const args = input as { outputPath: string; mappings: Record<string, string> };
      return {
        outputPath: args.outputPath,
        patchesApplied: Object.keys(args.mappings).length,
        patchesFailed: 0,
        warnings: [],
      };
    }
    return null;
  });
  render(<ConfigProvider>{null}</ConfigProvider>);
  await waitFor(() => expect(listen).toHaveBeenCalledWith('spoofer-result', expect.any(Function)));
});

afterEach(() => {
  cleanup();
});

describe('retrying a completed file job', () => {
  it.each(['rbxm', 'rbxl', 'rbxmx', 'rbxlx'])(
    'keeps the %s copy downloadable when retry fails, then adds recovered replacements',
    async (extension) => {
      await startFileJob(extension);
      await expectFileMappings(extension, { [ids[0]]: '22345001' });

      await act(async () => {
        await expect(retryFailed()).resolves.toMatchObject({ ok: true, count: 2 });
      });
      const retry = lastJobInput();
      expect(JSON.parse(retry.assets).map((asset: { id: string }) => asset.id)).toEqual([
        ids[1],
        ids[4],
      ]);
      expect(retry.enableArchiveRecovery).toBe(false);
      expect(useSessionStore.getState().lastFileWrite).toBeNull();
      await act(async () => {
        await emit('spoofer-started', { jobId: retry.jobId });
        await emit('spoofer-queued', {
          jobId: retry.jobId,
          total: 2,
          assets: JSON.parse(retry.assets),
        });
      });
      await finishJob([
        { id: ids[1], success: false },
        { id: ids[4], success: false },
      ]);
      expect(countJobResults(useSpooferStore.getState().lastAssetResults)).toEqual({
        completed: 1,
        errors: 2,
        skipped: 1,
        cancelled: 1,
        total: 5,
      });
      await expectFileMappings(extension, { [ids[0]]: '22345001' });

      await act(async () => {
        await expect(recoverFailed()).resolves.toMatchObject({ ok: true, count: 2 });
      });
      expect(lastJobInput().enableArchiveRecovery).toBe(true);
      expect(useSpooferStore.getState().spoofTotalCount).toBe(2);
      await finishJob(
        [
          { id: ids[1], success: true, newId: '22345002' },
          { id: ids[4], success: false },
        ],
        { replacements: { [ids[1]]: '22345002' } },
      );
      await expectFileMappings(extension, { [ids[0]]: '22345001', [ids[1]]: '22345002' });

      await act(async () => {
        await expect(retryFailed()).resolves.toMatchObject({ ok: true, count: 1 });
      });
      expect(JSON.parse(lastJobInput().assets)).toEqual([
        expect.objectContaining({ id: ids[4], type: 'animation' }),
      ]);
      await finishJob([{ id: ids[4], success: true, newId: '22345005' }]);
      await expectFileMappings(extension, {
        [ids[0]]: '22345001',
        [ids[1]]: '22345002',
        [ids[4]]: '22345005',
      });
      expect(countJobResults(useSpooferStore.getState().lastAssetResults)).toEqual({
        completed: 3,
        errors: 0,
        skipped: 1,
        cancelled: 1,
        total: 5,
      });
      const launches = vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === 'run_spoofer_action');
      await expect(recoverFailed()).resolves.toMatchObject({ ok: false, reason: 'no_assets' });
      expect(
        vi.mocked(invoke).mock.calls.filter(([name]) => name === 'run_spoofer_action'),
      ).toHaveLength(launches.length);
    },
  );

  it('preserves successes and the source when a retry cannot launch', async () => {
    await startFileJob();
    launchError = new Error('Backend could not start');
    await act(async () => {
      await expect(retryFailed()).resolves.toMatchObject({ ok: false, reason: 'launch_failed' });
    });
    expect(useSpooferStore.getState().isSpoofing).toBe(false);
    expect(useSpooferStore.getState().lastAssetResults).toHaveLength(5);
    expect(useSpooferStore.getState().lastAssetResults[1]?.errorReason).toBe(launchError.message);
    await expectFileMappings('rbxm', { [ids[0]]: '22345001' });
  });

  it('keeps earlier mappings when recovery stops without results and ignores old job events', async () => {
    await startFileJob();
    const oldJobId = lastJobInput().jobId;
    await act(async () => {
      await recoverFailed();
      await emit('spoofer-result', {
        jobId: oldJobId,
        assetResults: [{ id: ids[0], success: true, newId: '99999001' }],
      });
    });
    expect(useSpooferStore.getState().isSpoofing).toBe(true);
    await finishJob([], { error: 'Recovery interrupted' });
    expect(useSpooferStore.getState().lastAssetResults).toHaveLength(5);
    await expectFileMappings('rbxm', { [ids[0]]: '22345001' });
  });

  it('retains the original file when the current source changes before retry', async () => {
    await startFileJob('rbxl');
    useSessionStore
      .getState()
      .setSource(
        { kind: 'file', label: 'other.rbxm', filePath: '/fixtures/other.rbxm', scannedAt: 2 },
        [],
      );
    await act(async () => {
      await retryFailed();
    });
    expect(lastJobInput().placeName).toBe('fixture.rbxl');
    await finishJob([{ id: ids[1], success: true, newId: '22345002' }]);
    await expectFileMappings('rbxl', { [ids[0]]: '22345001', [ids[1]]: '22345002' });
  });

  it('starts a fresh result set for a new job without reviving cached mappings for its failures', async () => {
    await startFileJob();
    await act(async () => {
      await runSpoof({ assetIds: [ids[0]] });
    });
    expect(useSpooferStore.getState().lastAssetResults).toEqual([]);
    await finishJob([{ id: ids[0], success: false }]);
    expect(useSpooferStore.getState().lastAssetResults).toHaveLength(1);
    await expect(writeSpoofedFile({})).rejects.toThrow();
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'write_spoofed_place_file')).toBe(
      false,
    );
  });

  it('requires explicit recovery even when the old global recovery setting is enabled', async () => {
    act(() => {
      useConfigStore.getState().updateConfig('advanced', 'enableArchiveRecovery', true);
    });
    await startFileJob();
    expect(lastJobInput().enableArchiveRecovery).toBe(false);
    await act(async () => {
      await retryFailed();
    });
    expect(lastJobInput().enableArchiveRecovery).toBe(false);
    await finishJob([]);
    await act(async () => {
      await recoverFailed();
    });
    expect(lastJobInput().enableArchiveRecovery).toBe(true);
    expect(useConfigStore.getState().config.advanced.enableArchiveRecovery).toBe(true);
    await finishJob([]);
    await act(async () => {
      await runSpoof({ assetIds: [ids[0]] });
    });
    expect(lastJobInput().enableArchiveRecovery).toBe(false);
  });

  it('rejects a second retry while the first is preparing without losing the previous results', async () => {
    await startFileJob();
    const previous = useSpooferStore.getState().lastAssetResults;
    let validate!: (value: Awaited<ReturnType<typeof validateCookieProfile>>) => void;
    vi.mocked(validateCookieProfile).mockImplementationOnce(
      () => new Promise((resolve) => (validate = resolve)),
    );
    await act(async () => {
      const retry = retryFailed();
      await expect(recoverFailed()).resolves.toMatchObject({ ok: false, reason: 'busy' });
      expect(useSpooferStore.getState().lastAssetResults).toBe(previous);
      validate({
        user: { id: 111, name: 'fixture', displayName: 'Fixture' },
        cookie: 's'.repeat(60),
      });
      await expect(retry).resolves.toMatchObject({ ok: true });
    });
    expect(lastJobInput().enableArchiveRecovery).toBe(false);
  });
});

describe('retry Studio target isolation', () => {
  it('keeps the original manual job window and animation mode after selection changes', async () => {
    useSessionStore.getState().setSource({ kind: 'manual', label: 'IDs', scannedAt: 1 }, assets);
    useStudioSessionsStore.setState({
      selectedSessionId: 'window-a',
      sessions: ['window-a', 'window-b'].map((sessionId) => ({
        sessionId,
        synced: true,
        studioPlaceId: '77777777',
        studioPlaceName: sessionId,
        scanStatus: null,
      })),
    });
    await act(async () => {
      useConfigStore.getState().updateConfig('spoofing', 'animationMode', 'clip_parent');
      await runSpoof();
    });
    await finishJob(firstResults);
    useStudioSessionsStore.setState({ selectedSessionId: 'window-b' });
    vi.mocked(getStudioPlaceIdFallback).mockClear();
    await act(async () => {
      useConfigStore.getState().updateConfig('spoofing', 'animationMode', 'animation');
      await recoverFailed();
    });
    expect(getStudioPlaceIdFallback).toHaveBeenCalledWith('window-a');
    expect(useSpooferStore.getState().jobTarget).toMatchObject({
      studioSessionId: 'window-a',
      animationMode: 'clip_parent',
    });
    await finishJob([{ id: ids[1], success: true, newId: '22345002' }]);
    await pushToStudio();
    expect(performStudioReplacement).toHaveBeenCalledWith(
      { [ids[0]]: '22345001', [ids[1]]: '22345002' },
      expect.any(Object),
      expect.objectContaining({ sessionId: 'window-a', animationMode: 'clip_parent' }),
    );
    vi.mocked(performStudioReplacement).mockClear();
    useStudioSessionsStore.setState((state) => ({
      sessions: state.sessions.filter((session) => session.sessionId !== 'window-a'),
    }));
    await expect(pushToStudio()).rejects.toThrow(/disconnected/);
    expect(performStudioReplacement).not.toHaveBeenCalled();
  });
});
