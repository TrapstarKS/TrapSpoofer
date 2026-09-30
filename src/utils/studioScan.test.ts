import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { fetchPluginBridge, findPluginBridgePort } from './pluginBridge';
import { triggerStudioScan } from './studioScan';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./pluginBridge', () => ({ fetchPluginBridge: vi.fn(), findPluginBridgePort: vi.fn() }));

const health = {
  sessionId: 'window-one',
  synced: true,
  activeScanId: 'scan-new',
  scanStatus: { scanned: 1 },
};

describe('Studio scans', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useStudioSessionsStore.setState({
      selectedSessionId: 'window-one',
      sessions: [
        {
          sessionId: 'window-one',
          synced: true,
          studioPlaceId: '123',
          studioPlaceName: 'First',
          scanStatus: null,
        },
        {
          sessionId: 'window-two',
          synced: true,
          studioPlaceId: '123',
          studioPlaceName: 'Second',
          scanStatus: null,
        },
      ],
    });
    vi.mocked(findPluginBridgePort).mockResolvedValue('5555');
    vi.mocked(fetchPluginBridge).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, scanId: 'scan-new' }),
    } as Response);
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the requested scan and keeps its target when selection changes', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ ...health, completedScanId: 'scan-old' })
      .mockResolvedValueOnce({ ...health, activeScanId: null, completedScanId: 'scan-new' });
    const scan = triggerStudioScan({ scanTypes: ['animations'] });
    await vi.advanceTimersByTimeAsync(0);
    useStudioSessionsStore.getState().selectSession('window-two');
    await vi.advanceTimersByTimeAsync(1500);
    await expect(scan).resolves.toBe('scan-new');
    expect(fetchPluginBridge).toHaveBeenCalledTimes(1);
    expect(fetchPluginBridge).toHaveBeenCalledWith(
      '/request-scan',
      '5555',
      expect.any(Object),
      'window-one',
    );
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['get_studio_health_status', { sessionId: 'window-one' }],
      ['get_studio_health_status', { sessionId: 'window-one' }],
    ]);
  });

  it('propagates a rejected scan without reading stale results', async () => {
    vi.mocked(fetchPluginBridge).mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, error: 'Window busy' }),
    } as Response);
    await expect(triggerStudioScan()).rejects.toThrow('Window busy');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stops when the selected window disconnects', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...health, synced: false });
    await expect(triggerStudioScan()).rejects.toThrow(/disconnected/);
  });

  it('does not confuse another scan completion with this scan', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...health,
      activeScanId: 'other',
      completedScanId: 'other',
    });
    await expect(triggerStudioScan()).rejects.toThrow(/aborted or replaced/);
  });

  it('fails after five minutes without progress', async () => {
    vi.mocked(invoke).mockResolvedValue(health);
    const result = expect(triggerStudioScan()).rejects.toThrow(/no progress for 5 minutes/);
    await vi.advanceTimersByTimeAsync(301_500);
    await result;
  });
});
