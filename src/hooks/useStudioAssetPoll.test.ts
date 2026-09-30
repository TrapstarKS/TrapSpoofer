import * as tauriCore from '@tauri-apps/api/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { useStudioAssetPoll } from './useStudioAssetPoll';

describe('useStudioAssetPoll', () => {
  const defaultBundle = {
    sessionId: 'one',
    scanId: 'scan',
    anims: { assets: [], scanning: false, complete: false },
    sounds: { assets: [], scanning: false, complete: false },
    images: { assets: [], scanning: false, complete: false },
    meshes: { assets: [], scanning: false, complete: false },
    scriptRefs: { assets: [], scanning: false, complete: false },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useStudioSessionsStore.setState({ selectedSessionId: 'one' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores the old window response after switching windows', async () => {
    const onComplete = vi.fn();
    let resolve: (value: unknown) => void = () => {};
    vi.mocked(tauriCore.invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { unmount } = renderHook(() => useStudioAssetPoll(true, onComplete));
    act(() => useStudioSessionsStore.setState({ selectedSessionId: 'two' }));
    await act(async () => {
      resolve({
        ...defaultBundle,
        anims: { complete: true },
        sounds: { complete: true },
        images: { complete: true },
        meshes: { complete: true },
        scriptRefs: { complete: true },
      });
    });
    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });

  it('does not poll if studioConnected is false', async () => {
    const onComplete = vi.fn();
    const invokeSpy = (tauriCore.invoke as any).mockResolvedValue(defaultBundle);

    renderHook(() => useStudioAssetPoll(false, onComplete));

    await vi.advanceTimersByTimeAsync(5000);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('polls and does not call onComplete if incomplete', async () => {
    const onComplete = vi.fn();
    const invokeSpy = (tauriCore.invoke as any).mockResolvedValue({
      ...defaultBundle,
      anims: { assets: [], scanning: true, complete: false },
    });

    renderHook(() => useStudioAssetPoll(true, onComplete));

    await vi.advanceTimersByTimeAsync(100);

    expect(invokeSpy).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2100);
    expect(invokeSpy).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('calls onComplete when all stores are complete', async () => {
    const onComplete = vi.fn();
    const completeBundle = {
      sessionId: 'one',
      scanId: 'scan',
      anims: { assets: [{ name: 'anim1' }], scanning: false, complete: true },
      sounds: { assets: [], scanning: false, complete: true },
      images: { assets: [], scanning: false, complete: true },
      meshes: { assets: [], scanning: false, complete: true },
      scriptRefs: { assets: [], scanning: false, complete: true },
    };

    const invokeSpy = (tauriCore.invoke as any).mockResolvedValue(completeBundle);

    renderHook(() => useStudioAssetPoll(true, onComplete));

    await vi.advanceTimersByTimeAsync(100);

    await vi.advanceTimersByTimeAsync(100);
    expect(invokeSpy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(onComplete).toHaveBeenCalledWith(completeBundle);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not deliver the same completed scan twice', async () => {
    const onComplete = vi.fn();
    const completeBundle = {
      sessionId: 'one',
      scanId: 'scan',
      anims: { assets: [{ name: 'anim1' }], scanning: false, complete: true },
      sounds: { assets: [], scanning: false, complete: true },
      images: { assets: [], scanning: false, complete: true },
      meshes: { assets: [], scanning: false, complete: true },
      scriptRefs: { assets: [], scanning: false, complete: true },
    };

    const invokeSpy = (tauriCore.invoke as any).mockResolvedValue(completeBundle);

    renderHook(() => useStudioAssetPoll(true, onComplete));

    await vi.advanceTimersByTimeAsync(100);

    await vi.advanceTimersByTimeAsync(100);
    expect(invokeSpy).toHaveBeenCalled();

    expect(onComplete).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10100);
    expect(invokeSpy).toHaveBeenCalledTimes(2);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
