import { invoke } from '@tauri-apps/api/core';

import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { addDebugLog } from './debugLogger';
import { isTauriRuntime } from './tauriRuntime';

export async function getStudioPlaceIdFallback(
  sessionId = useStudioSessionsStore.getState().selectedSessionId,
): Promise<string> {
  if (!sessionId) return '';
  try {
    const health = await invoke<{ synced: boolean; studioPlaceId?: string | null }>(
      'get_studio_health_status',
      { sessionId },
    );
    const placeId = String(health.studioPlaceId ?? '');
    return health.synced && /^\d+$/.test(placeId) && placeId !== '0' ? placeId : '';
  } catch (error) {
    addDebugLog('warn', ['Failed to get the selected Studio place ID', error]);
    return '';
  }
}

export async function fetchTelemetry(url: string, options?: RequestInit): Promise<Response> {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(url, options as Parameters<typeof tauriFetch>[1]);
  } else {
    return fetch(url, options);
  }
}
