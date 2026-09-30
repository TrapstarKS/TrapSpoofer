import { invoke } from '@tauri-apps/api/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type StudioSession, useStudioSessionsStore } from '../stores/studioSessionsStore';
import { useStudioConnection } from './useStudioConnection';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const windowState = (sessionId: string): StudioSession => ({
  sessionId,
  synced: true,
  studioPlaceId: '123',
  studioPlaceName: 'Same place',
  scanStatus: null,
});

describe('Studio connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useStudioSessionsStore.setState({ selectedSessionId: null, sessions: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('recovers when the bridge starts after an initial failure', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('not started'))
      .mockResolvedValue({ sessions: [windowState('one')] });
    const { result } = renderHook(() => useStudioConnection());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.studioConnected).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.studioConnected).toBe(true);
    expect(result.current.studioPlaceId).toBe('123');
  });

  it('requires a selection for two windows of the same place', async () => {
    vi.mocked(invoke).mockResolvedValue({ sessions: [windowState('one'), windowState('two')] });
    const { result } = renderHook(() => useStudioConnection());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.studioConnected).toBe(false);
    act(() => result.current.selectStudioSession('two'));
    expect(result.current.selectedStudioSessionId).toBe('two');
    expect(result.current.studioConnected).toBe(true);
  });

  it('never reuses a previous place ID when its window disconnects', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ sessions: [windowState('one')] })
      .mockResolvedValue({ sessions: [windowState('two')] });
    const { result } = renderHook(() => useStudioConnection());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.studioPlaceId).toBe('123');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.selectedStudioSessionId).toBe('one');
    expect(result.current.studioPlaceId).toBe('');
    expect(result.current.studioConnected).toBe(false);
  });

  it('does not overlap pending requests or apply a response after unmount', async () => {
    let complete: (value: unknown) => void = () => {};
    vi.mocked(invoke).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { unmount } = renderHook(() => useStudioConnection());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      complete({ sessions: [windowState('one')] });
    });
    expect(useStudioSessionsStore.getState().sessions).toEqual([]);
  });
});
