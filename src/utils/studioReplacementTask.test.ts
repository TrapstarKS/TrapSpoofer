import { invoke } from '@tauri-apps/api/core';
import { type EventCallback, listen } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSpooferStore } from '../stores/spooferStore';
import { queueStudioReplacements } from './studioBridge';
import { performStudioReplacement } from './studioReplacementTask';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('./studioBridge', () => ({ queueStudioReplacements: vi.fn() }));

describe('Studio replacement completion', () => {
  let handler: EventCallback<unknown>;
  const unlisten = vi.fn();
  const options = { sessionId: 'one', operationId: 'operation' };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useSpooferStore.setState({ replaceCurrentCount: 0 });
    vi.mocked(listen).mockImplementation(async (_, callback) => {
      handler = callback;
      return unlisten;
    });
    vi.mocked(queueStudioReplacements).mockResolvedValue(options);
  });
  afterEach(() => vi.useRealTimers());

  it('ignores results from other windows and from older operations', async () => {
    let completed = false;
    const task = performStudioReplacement({ '123': '456' }, {}, options).then((result) => {
      completed = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    handler({
      event: 'patch-results',
      id: 1,
      payload: { sessionId: 'two', operationId: 'operation', succeeded: 1 },
    });
    handler({
      event: 'patch-results',
      id: 1,
      payload: { sessionId: 'one', operationId: 'old', succeeded: 1 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    handler({
      event: 'patch-results',
      id: 1,
      payload: { ...options, succeeded: 1, failed: 0, total: 1 },
    });
    await expect(task).resolves.toMatchObject({ succeeded: 1 });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up after disconnection without replaying mutations', async () => {
    vi.mocked(invoke).mockResolvedValue({ synced: false });
    const task = expect(performStudioReplacement({ '123': '456' }, {}, options)).rejects.toThrow(
      /disconnected/,
    );
    await vi.advanceTimersByTimeAsync(5000);
    await task;
    expect(queueStudioReplacements).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
