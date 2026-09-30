import { invoke } from '@tauri-apps/api/core';

import { requireStudioSession } from '../stores/studioSessionsStore';

export interface ReplacementOptions {
  sessionId?: string;
  operationId?: string;
  animationMode?: 'animation' | 'clip_replace' | 'clip_parent';
}

export async function queueStudioReplacements(
  replacements: Record<string, string>,
  targetPathsMap: Record<string, string[]> = {},
  options: ReplacementOptions = {},
) {
  if (!Object.keys(replacements).length) throw new Error('No asset mappings were selected.');
  const sessionId = requireStudioSession(options.sessionId);
  const operationId = options.operationId ?? crypto.randomUUID();
  const replacementsMap = Object.entries(replacements).map(([originalId, newId]) => ({
    originalId,
    newId,
    targetPaths: targetPathsMap[originalId]?.length ? targetPathsMap[originalId] : null,
  }));
  const receipt = await invoke<{ sessionId: string; operationId: string }>('push_to_studio', {
    replacementsMap,
    sessionId,
    operationId,
    animationMode: options.animationMode ?? 'animation',
  });
  if (receipt?.sessionId !== sessionId || receipt?.operationId !== operationId)
    throw new Error(
      'Studio did not acknowledge the target operation. Check the plugin before retrying.',
    );
  return receipt;
}
