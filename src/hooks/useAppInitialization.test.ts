import * as tauriCore from '@tauri-apps/api/core';
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importStudioAccounts } from '../services/studioAccounts';
import { DEFAULT_APP_CONFIG, useConfigStore } from '../stores/configStore';
import { useAppInitialization } from './useAppInitialization';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

vi.mock('../utils/tauriRuntime', () => ({
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock('../services/studioAccounts', () => ({
  importStudioAccounts: vi.fn().mockResolvedValue({ importedCount: 0 }),
}));

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  isRegistered: vi.fn().mockResolvedValue(false),
  register: vi.fn().mockResolvedValue(undefined),
  unregister: vi.fn().mockResolvedValue(undefined),
}));

describe('useAppInitialization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useConfigStore.setState({ config: DEFAULT_APP_CONFIG, secretsLoaded: false });
    (tauriCore.invoke as any).mockImplementation((command: string) => {
      if (command === 'check_roblox_api_status') return Promise.resolve(true);
      return Promise.resolve(null);
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initializes with the Roblox API reported as up', async () => {
    const { result } = renderHook(() => useAppInitialization());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isRobloxApiDown).toBe(false);
  });

  it('flags the Roblox API as down when the status check fails', async () => {
    (tauriCore.invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'check_roblox_api_status') return Promise.resolve(false);
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useAppInitialization());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.isRobloxApiDown).toBe(true);
  });

  it('never phones home (no telemetry, heartbeat or remote config)', async () => {
    const tauriHttp = await import('@tauri-apps/plugin-http');
    renderHook(() => useAppInitialization());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(tauriHttp.fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const commands = (tauriCore.invoke as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(commands).not.toContain('initialize_remote_cache');
  });

  it('forwards the proxy setting to the backend', async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        advanced: { ...state.config.advanced, proxyUrl: 'socks5://127.0.0.1:9050' },
      },
    }));
    renderHook(() => useAppInitialization());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(tauriCore.invoke).toHaveBeenCalledWith('set_proxy_url', {
      url: 'socks5://127.0.0.1:9050',
    });
  });

  it('imports Studio accounts once after secrets load even under StrictMode', async () => {
    useConfigStore.setState({ secretsLoaded: true });
    renderHook(() => useAppInitialization(), { wrapper: StrictMode });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(importStudioAccounts).toHaveBeenCalledTimes(1);
  });
});
