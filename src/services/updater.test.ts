import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdaterStore } from '../stores/updaterStore';
import { checkAppUpdate, downloadAppUpdate, installAppUpdate } from './updater';

const fixtures = vi.hoisted(() => ({
  configuration: { general: { autoUpdate: true } },
  work: { isSpoofing: false, isReplacing: false, isPreparingJob: false },
  update: { version: '3.0.1', download: vi.fn(), install: vi.fn(), close: vi.fn() },
}));

vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('../utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('../stores/configStore', () => ({
  useConfigStore: { getState: () => ({ config: fixtures.configuration }) },
}));
vi.mock('../stores/spooferStore', () => ({ useSpooferStore: { getState: () => fixtures.work } }));
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ scanPhase: 'ready' }) },
}));
vi.mock('../stores/studioSessionsStore', () => ({
  useStudioSessionsStore: { getState: () => ({ sessions: [] }) },
}));

describe('application updates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixtures.configuration.general.autoUpdate = true;
    fixtures.work.isSpoofing = false;
    fixtures.work.isReplacing = false;
    fixtures.work.isPreparingJob = false;
    useUpdaterStore.setState({
      status: 'idle',
      version: '',
      error: '',
      lastCheckedAt: 0,
      downloaded: 0,
      total: 0,
    });
    vi.mocked(check).mockResolvedValue(fixtures.update as unknown as Update);
    fixtures.update.download.mockResolvedValue(undefined);
    fixtures.update.install.mockResolvedValue(undefined);
    fixtures.update.close.mockResolvedValue(undefined);
  });

  it('downloads automatically and waits for an explicit restart', async () => {
    await checkAppUpdate(true);
    expect(fixtures.update.download).toHaveBeenCalledOnce();
    expect(useUpdaterStore.getState().status).toBe('ready');
    expect(fixtures.update.install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('never installs during a running or preparing job', async () => {
    await checkAppUpdate(true);
    fixtures.work.isSpoofing = true;
    await installAppUpdate();
    fixtures.work.isSpoofing = false;
    fixtures.work.isPreparingJob = true;
    await installAppUpdate();
    expect(fixtures.update.install).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState()).toMatchObject({ status: 'ready', error: 'busy' });
    fixtures.work.isPreparingJob = false;
    await installAppUpdate();
    expect(fixtures.update.install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('coalesces startup and focus checks into one request', async () => {
    let resolve: (value: Update | null) => void = () => {};
    vi.mocked(check).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = checkAppUpdate(true);
    const second = checkAppUpdate(true);
    resolve(null);
    await Promise.all([first, second]);
    expect(check).toHaveBeenCalledOnce();
  });

  it('does not make failed downloads installable and supports retry', async () => {
    fixtures.update.download.mockRejectedValueOnce(new Error('Signature verification failed'));
    await checkAppUpdate(true);
    expect(useUpdaterStore.getState().status).toBe('error');
    await installAppUpdate();
    expect(fixtures.update.install).not.toHaveBeenCalled();
    await downloadAppUpdate();
    expect(useUpdaterStore.getState().status).toBe('ready');
  });

  it('lets an idle user retry installation after an error', async () => {
    await checkAppUpdate(true);
    fixtures.update.install.mockRejectedValueOnce(new Error('Disk full'));
    await installAppUpdate();
    expect(useUpdaterStore.getState()).toMatchObject({
      status: 'ready',
      error: 'Error: Disk full',
    });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('does not automatically check or download when the setting is disabled', async () => {
    fixtures.configuration.general.autoUpdate = false;
    await checkAppUpdate();
    expect(check).not.toHaveBeenCalled();
    await checkAppUpdate(true);
    expect(useUpdaterStore.getState().status).toBe('available');
    expect(fixtures.update.download).not.toHaveBeenCalled();
  });
});
