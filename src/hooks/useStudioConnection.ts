import { invoke } from '@tauri-apps/api/core';
import { useEffect } from 'react';

import { type StudioSession, useStudioSessionsStore } from '../stores/studioSessionsStore';

export type ScanStatus = NonNullable<StudioSession['scanStatus']>;

export function useStudioConnection() {
  const sessions = useStudioSessionsStore((state) => state.sessions);
  const selectedStudioSessionId = useStudioSessionsStore((state) => state.selectedSessionId);
  const selectStudioSession = useStudioSessionsStore((state) => state.selectSession);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let recheck = false;
    const check = async () => {
      if (cancelled || inFlight) {
        recheck = true;
        return;
      }
      inFlight = true;
      try {
        const health = await invoke<{ sessions?: StudioSession[] }>('get_studio_health_status', {
          sessionId: useStudioSessionsStore.getState().selectedSessionId,
        });
        if (!cancelled) useStudioSessionsStore.getState().updateSessions(health.sessions ?? []);
      } catch {
        if (!cancelled) useStudioSessionsStore.getState().updateSessions([]);
      } finally {
        inFlight = false;
        if (!cancelled) {
          timer = setTimeout(() => void check(), recheck ? 0 : document.hidden ? 5000 : 1000);
          recheck = false;
        }
      }
    };
    const refresh = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void check();
    };
    void check();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const selected = sessions.find((session) => session.sessionId === selectedStudioSessionId);
  return {
    studioConnected: selected?.synced === true,
    scanStatus: selected?.synced ? selected.scanStatus : null,
    studioPlaceId: selected?.synced ? (selected.studioPlaceId ?? '') : '',
    studioPlaceName: selected?.studioPlaceName ?? null,
    studioSessions: sessions,
    selectedStudioSessionId,
    selectStudioSession,
  };
}
