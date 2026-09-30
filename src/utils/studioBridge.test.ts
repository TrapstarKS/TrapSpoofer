import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { queueStudioReplacements } from './studioBridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('Studio replacement targeting', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
          sessionId: 'two',
          synced: true,
          studioPlaceId: '123',
          studioPlaceName: 'Second',
          scanStatus: null,
        },
      ],
    });
    vi.mocked(invoke).mockImplementation(async (_, args) => ({
      sessionId: (args as { sessionId: string }).sessionId,
      operationId: (args as { operationId: string }).operationId,
    }));
  });

  it('rejects empty mappings', async () => {
    await expect(queueStudioReplacements({})).rejects.toThrow(/No asset mappings/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends the explicit window, operation and animation mode', async () => {
    await queueStudioReplacements(
      { '123': '456' },
      { '123': ['Workspace.Animation'] },
      { sessionId: 'two', operationId: 'operation', animationMode: 'clip_parent' },
    );
    expect(invoke).toHaveBeenCalledWith('push_to_studio', {
      replacementsMap: [{ originalId: '123', newId: '456', targetPaths: ['Workspace.Animation'] }],
      sessionId: 'two',
      operationId: 'operation',
      animationMode: 'clip_parent',
    });
  });

  it('never falls back to another window after the captured window disconnects', async () => {
    useStudioSessionsStore.setState((state) => ({
      sessions: state.sessions.filter((session) => session.sessionId !== 'one'),
      selectedSessionId: 'two',
    }));
    await expect(
      queueStudioReplacements({ '123': '456' }, {}, { sessionId: 'one' }),
    ).rejects.toThrow(/disconnected/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates backend rejection without replaying the command', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Window busy'));
    await expect(queueStudioReplacements({ '123': '456' })).rejects.toThrow('Window busy');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
