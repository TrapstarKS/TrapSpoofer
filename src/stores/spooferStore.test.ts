import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pushToStudio } from '../services/spoofer';
import { performStudioReplacement } from '../utils/studioReplacementTask';
import { applyReplacements, useSpooferStore } from './spooferStore';
import { useStudioSessionsStore } from './studioSessionsStore';

vi.mock('../utils/tauriRuntime', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('../utils/notifyError', () => ({
  notifyError: vi.fn(),
}));

vi.mock('../utils/studioReplacementTask', () => ({ performStudioReplacement: vi.fn() }));

describe('spooferStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const store = useSpooferStore.getState();
    store.setRootInstances([]);
    store.setLoadedFileName(null);
    store.setLoadedFilePath(null);
    store.setParsingFileName(null);
    store.setSelectedAssetIds(new Set());
    store.setSpoofingLogs([]);
    store.setIsSpoofing(false);
    store.setSpoofProgress(0);
    store.setSpoofStatusText('');
    store.setSpoofCurrentCount(0);
    store.setSpoofTotalCount(0);
    store.setSpoofStartTime(null);
    store.setLastReplacements({});
    store.setIsReplacing(false);
    store.setReplaceError(false);
    store.setActiveSpooferJobId(null);
    store.setIsJobPaused(false);
    store.setLastAssetResults([]);
    store.setShowAdvanced(false);
    store.setKeyframeWarningCount(0);
    store.setAssetMetadataMap({});
  });

  it('updates basic state fields', () => {
    const store = useSpooferStore.getState();
    store.setLoadedFileName('test.rbxlx');
    expect(useSpooferStore.getState().loadedFileName).toBe('test.rbxlx');

    store.setIsSpoofing(true);
    expect(useSpooferStore.getState().isSpoofing).toBe(true);

    store.setSpoofProgress(50);
    expect(useSpooferStore.getState().spoofProgress).toBe(50);
  });

  it('updates set state fields with callbacks', () => {
    const store = useSpooferStore.getState();
    store.setSpoofCurrentCount(5);
    store.setSpoofCurrentCount((prev) => prev + 10);
    expect(useSpooferStore.getState().spoofCurrentCount).toBe(15);
  });

  it('truncates spoofing logs at 500 entries', () => {
    const store = useSpooferStore.getState();
    const largeLogs = Array.from({ length: 600 }, (_, i) => `log ${i}`);
    store.setSpoofingLogs(largeLogs);
    expect(useSpooferStore.getState().spoofingLogs.length).toBe(500);
    expect(useSpooferStore.getState().spoofingLogs[499]).toBe('log 599');
  });
});

describe('applyReplacements', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useSpooferStore.setState({
      spoofingLogs: [],
      isReplacing: false,
      replaceError: false,
      targetPathsMap: {},
      lastJobTarget: null,
      lastAssetResults: [],
    });
    useStudioSessionsStore.setState({
      selectedSessionId: 'one',
      sessions: [
        {
          sessionId: 'one',
          synced: true,
          studioPlaceId: '123',
          studioPlaceName: 'First',
          scanStatus: null,
        },
      ],
    });
  });

  it('does not create a replacement job for an empty selection', async () => {
    await applyReplacements({});
    expect(useSpooferStore.getState().isReplacing).toBe(false);
    expect(performStudioReplacement).not.toHaveBeenCalled();
  });

  it('stays busy until Studio confirms the specific operation', async () => {
    let complete: (value: { succeeded: number; failed: number; total: number }) => void = () => {};
    vi.mocked(performStudioReplacement).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const pending = applyReplacements({ '123': '456' }, false, 'one', 'clip_parent');
    expect(useSpooferStore.getState().isReplacing).toBe(true);
    expect(performStudioReplacement).toHaveBeenCalledWith(
      { '123': '456' },
      {},
      {
        sessionId: 'one',
        operationId: expect.any(String),
        animationMode: 'clip_parent',
      },
    );
    await expect(applyReplacements({ '777': '888' })).rejects.toThrow(/already in progress/);
    complete({ succeeded: 3, failed: 0, total: 3 });
    await pending;
    expect(useSpooferStore.getState().isReplacing).toBe(false);
    expect(useSpooferStore.getState().replaceCurrentCount).toBe(3);
    expect(useSpooferStore.getState().lastReplacements).toEqual({ '123': '456' });
  });

  it('reports partial failure and clears the busy state', async () => {
    vi.mocked(performStudioReplacement).mockResolvedValue({ succeeded: 2, failed: 1, total: 3 });
    await expect(applyReplacements({ '123': '456' })).rejects.toThrow(/1 failed/);
    expect(useSpooferStore.getState().replaceError).toBe(true);
    expect(useSpooferStore.getState().isReplacing).toBe(false);
  });

  it('rejects a disconnected captured target before queueing', async () => {
    await expect(applyReplacements({ '123': '456' }, true, 'missing')).rejects.toThrow(
      /disconnected/,
    );
    expect(performStudioReplacement).not.toHaveBeenCalled();
  });

  it('pushes implicit last-job mappings to the captured window and mode', async () => {
    useStudioSessionsStore.setState({
      selectedSessionId: 'one',
      sessions: [
        {
          sessionId: 'one',
          synced: true,
          studioPlaceId: '123',
          studioPlaceName: 'First',
          scanStatus: null,
        },
        {
          sessionId: 'captured',
          synced: true,
          studioPlaceId: '123',
          studioPlaceName: 'Second',
          scanStatus: null,
        },
      ],
    });
    useSpooferStore.setState({
      lastJobTarget: { studioSessionId: 'captured', animationMode: 'clip_replace' },
      lastAssetResults: [
        { id: '123', name: 'Animation', type: 'animation', success: true, newId: '456' },
      ],
    });
    vi.mocked(performStudioReplacement).mockResolvedValue({ succeeded: 1, failed: 0, total: 1 });

    await expect(pushToStudio()).resolves.toBe(1);
    expect(performStudioReplacement).toHaveBeenCalledWith(
      { '123': '456' },
      {},
      {
        sessionId: 'captured',
        operationId: expect.any(String),
        animationMode: 'clip_replace',
      },
    );
  });

  it('does not redirect implicit last-job mappings when the captured window disconnects', async () => {
    useSpooferStore.setState({
      lastJobTarget: { studioSessionId: 'captured', animationMode: 'clip_parent' },
      lastAssetResults: [
        { id: '123', name: 'Animation', type: 'animation', success: true, newId: '456' },
      ],
    });

    await expect(pushToStudio()).rejects.toThrow(/disconnected/);
    expect(performStudioReplacement).not.toHaveBeenCalled();
  });

  it('uses the selected window for explicit mappings and clears the old captured target', async () => {
    useSpooferStore.setState({
      lastJobTarget: { studioSessionId: 'captured', animationMode: 'clip_parent' },
    });
    vi.mocked(performStudioReplacement).mockResolvedValue({ succeeded: 1, failed: 0, total: 1 });

    await expect(pushToStudio({ '777': '888' })).resolves.toBe(1);
    expect(useSpooferStore.getState().lastJobTarget).toBeNull();
    expect(performStudioReplacement).toHaveBeenCalledWith(
      { '777': '888' },
      {},
      {
        sessionId: 'one',
        operationId: expect.any(String),
        animationMode: expect.any(String),
      },
    );
  });
});
