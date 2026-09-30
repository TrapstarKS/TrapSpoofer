import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSplashFlow } from './splash';

describe('splash startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="status-text"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens main after plugin sync succeeds', async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === 'sync_roblox_plugin' ? true : undefined),
    );

    await runSplashFlow();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'sync_roblox_plugin');
    expect(invoke).toHaveBeenNthCalledWith(2, 'close_splashscreen');
    expect(document.getElementById('status-text')?.innerText).toBe('Starting...');
  });

  it('opens main after plugin sync fails without logging rejection details', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation((command) =>
      command === 'sync_roblox_plugin'
        ? Promise.reject(new Error('secret-cookie-fixture'))
        : Promise.resolve(undefined),
    );

    await runSplashFlow();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('close_splashscreen');
    expect(consoleError).toHaveBeenCalledWith('Failed to sync Roblox plugin.');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('secret-cookie-fixture');
  });

  it('opens main after eight seconds when plugin sync never resolves', async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === 'sync_roblox_plugin' ? new Promise(() => {}) : Promise.resolve(undefined),
    );

    const flow = runSplashFlow();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flow;

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('close_splashscreen');
  });

  it('does not close splash again when plugin sync resolves after the timeout', async () => {
    let resolveSync!: (value: boolean) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'sync_roblox_plugin') {
        return new Promise((resolve) => {
          resolveSync = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const flow = runSplashFlow();
    await vi.advanceTimersByTimeAsync(8_000);
    await flow;
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'close_splashscreen'),
    ).toHaveLength(1);

    resolveSync(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'sync_roblox_plugin'),
    ).toHaveLength(1);
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'close_splashscreen'),
    ).toHaveLength(1);
  });
});
