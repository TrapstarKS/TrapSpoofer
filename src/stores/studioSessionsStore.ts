import { create } from 'zustand';

export interface StudioSession {
  sessionId: string;
  synced: boolean;
  studioPlaceId: string | null;
  studioPlaceName: string | null;
  scanStatus: { scanning: boolean; current_service: string; scanned: number; total: number } | null;
  completedScanId?: string | null;
}

interface StudioSessionsState {
  sessions: StudioSession[];
  selectedSessionId: string | null;
  updateSessions: (sessions: StudioSession[]) => void;
  selectSession: (sessionId: string) => void;
}

export const useStudioSessionsStore = create<StudioSessionsState>((set) => ({
  sessions: [],
  selectedSessionId: null,
  updateSessions: (sessions) =>
    set((state) => {
      const connected = sessions.filter(
        (session) => session.synced && session.sessionId !== 'legacy',
      );
      return {
        sessions,
        selectedSessionId:
          state.selectedSessionId ?? (connected.length === 1 ? connected[0].sessionId : null),
      };
    }),
  selectSession: (sessionId) =>
    set((state) =>
      state.sessions.some(
        (session) =>
          session.sessionId === sessionId && session.synced && session.sessionId !== 'legacy',
      )
        ? { selectedSessionId: sessionId }
        : state,
    ),
}));

export function requireStudioSession(
  sessionId = useStudioSessionsStore.getState().selectedSessionId,
): string {
  const state = useStudioSessionsStore.getState();
  if (!sessionId) throw new Error('Select a connected Studio window before continuing.');
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session?.synced)
    throw new Error(
      'The selected Studio window disconnected. Select or reconnect it before continuing.',
    );
  if (sessionId === 'legacy')
    throw new Error('Update the TrapSpoofer Studio plugin before continuing.');
  return sessionId;
}
