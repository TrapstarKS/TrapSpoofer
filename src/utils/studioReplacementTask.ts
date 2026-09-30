import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { useSpooferStore } from '../stores/spooferStore';
import { queueStudioReplacements, type ReplacementOptions } from './studioBridge';

interface PatchResult {
  sessionId?: string;
  operationId?: string;
  succeeded?: number;
  failed?: number;
  total?: number;
  error?: string;
}

export async function performStudioReplacement(
  replacements: Record<string, string>,
  targetPathsMap: Record<string, string[]>,
  options: ReplacementOptions & { sessionId: string; operationId: string },
): Promise<PatchResult> {
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  try {
    let resolveResult: (result: PatchResult) => void = () => {};
    const resultPromise = new Promise<PatchResult>((resolve) => {
      resolveResult = resolve;
    });
    unlisten = await listen<PatchResult>('patch-results', (event) => {
      if (
        event.payload.sessionId === options.sessionId &&
        event.payload.operationId === options.operationId
      ) {
        resolveResult(event.payload);
      }
    });
    await queueStudioReplacements(replacements, targetPathsMap, options);
    let progressAt = Date.now();
    let progressKey = '';
    const connection = new Promise<never>((_, reject) => {
      const check = async () => {
        if (stopped) return;
        try {
          const health = await invoke<{ synced: boolean; scanStatus?: { scanned?: number } }>(
            'get_studio_health_status',
            { sessionId: options.sessionId },
          );
          if (stopped) return;
          if (!health.synced)
            throw new Error(
              'The target Studio window disconnected. Check its changes before retrying.',
            );
          const key = `${useSpooferStore.getState().replaceCurrentCount}:${health.scanStatus?.scanned ?? ''}`;
          if (key !== progressKey) {
            progressKey = key;
            progressAt = Date.now();
          }
          if (Date.now() - progressAt >= 300_000)
            throw new Error(
              'Studio did not confirm progress for 5 minutes. Check its changes before retrying.',
            );
          timer = setTimeout(() => void check(), 5000);
        } catch (error) {
          reject(error);
        }
      };
      timer = setTimeout(() => void check(), 5000);
    });
    return await Promise.race([resultPromise, connection]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    unlisten?.();
  }
}
