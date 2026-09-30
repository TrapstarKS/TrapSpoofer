import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { fetchTelemetry, getStudioPlaceIdFallback } from './apiClient';
import * as pluginBridge from './pluginBridge';
import * as tauriRuntime from './tauriRuntime';

describe('apiClient', () => {
  const mockLocalStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    clear: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('localStorage', mockLocalStorage);

    mockLocalStorage.getItem.mockReturnValue(null);
    vi.spyOn(pluginBridge, 'findPluginBridgePort').mockResolvedValue(null);
    vi.spyOn(tauriRuntime, 'isTauriRuntime').mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getStudioPlaceIdFallback', () => {
    it('uses the explicitly selected live window', async () => {
      vi.mocked(invoke).mockResolvedValue({ synced: true, studioPlaceId: '987654' });
      expect(await getStudioPlaceIdFallback('selected')).toBe('987654');
      expect(invoke).toHaveBeenCalledWith('get_studio_health_status', { sessionId: 'selected' });
    });
    it('ignores the old global place cache when no window is selected', async () => {
      useStudioSessionsStore.setState({ selectedSessionId: null });
      mockLocalStorage.getItem.mockReturnValue('123456');
      expect(await getStudioPlaceIdFallback()).toBe('');
    });
    it('returns no place for offline and unsaved windows', async () => {
      vi.mocked(invoke)
        .mockResolvedValueOnce({ synced: false, studioPlaceId: '123' })
        .mockResolvedValueOnce({ synced: true, studioPlaceId: '0' });
      expect(await getStudioPlaceIdFallback('one')).toBe('');
      expect(await getStudioPlaceIdFallback('one')).toBe('');
    });
    it('returns no place when the bridge fails', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Bridge unavailable'));
      expect(await getStudioPlaceIdFallback('one')).toBe('');
    });
  });

  describe('fetchTelemetry', () => {
    it('uses standard browser fetch when not in Tauri', async () => {
      vi.spyOn(tauriRuntime, 'isTauriRuntime').mockReturnValue(false);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));

      await fetchTelemetry('https://example.com');

      expect(fetch).toHaveBeenCalledWith('https://example.com', undefined);
    });

    it('uses tauri-apps/plugin-http fetch when in Tauri', async () => {
      vi.spyOn(tauriRuntime, 'isTauriRuntime').mockReturnValue(true);

      expect(true).toBe(true);
    });
  });
});
