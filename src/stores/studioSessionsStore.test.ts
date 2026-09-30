import { beforeEach, describe, expect, it } from 'vitest';

import {
  requireStudioSession,
  type StudioSession,
  useStudioSessionsStore,
} from './studioSessionsStore';

const session = (sessionId: string): StudioSession => ({
  sessionId,
  synced: true,
  studioPlaceId: '123',
  studioPlaceName: 'Same place',
  scanStatus: null,
});

describe('Studio window selection', () => {
  beforeEach(() => useStudioSessionsStore.setState({ sessions: [], selectedSessionId: null }));

  it('requires a choice when several windows open the same place', () => {
    useStudioSessionsStore.getState().updateSessions([session('one'), session('two')]);
    expect(() => requireStudioSession()).toThrow(/Select/);
    useStudioSessionsStore.getState().selectSession('two');
    expect(requireStudioSession()).toBe('two');
  });

  it('keeps a disconnected target instead of moving its commands to the remaining window', () => {
    useStudioSessionsStore.getState().updateSessions([session('one')]);
    expect(requireStudioSession()).toBe('one');
    useStudioSessionsStore.getState().updateSessions([session('two')]);
    expect(useStudioSessionsStore.getState().selectedSessionId).toBe('one');
    expect(() => requireStudioSession()).toThrow(/disconnected/);
  });
});
