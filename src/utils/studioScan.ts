import { invoke } from '@tauri-apps/api/core';

import { requireStudioSession } from '../stores/studioSessionsStore';
import { fetchPluginBridge, findPluginBridgePort } from './pluginBridge';

export interface ScanOptions {
  scanTypes: string[];
  scanPath?: string;
  sessionId?: string;
}

export async function triggerStudioScan(options?: ScanOptions): Promise<string> {
  const sessionId = requireStudioSession(options?.sessionId);
  const port = await findPluginBridgePort();
  if (!port)
    throw new Error('The TrapSpoofer bridge is unavailable. Reopen the app and try again.');
  const response = await fetchPluginBridge(
    '/request-scan',
    port,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    },
    sessionId,
  );
  if (!response.ok) throw new Error('Could not start a Studio scan in the selected window.');
  const started = (await response.json()) as { success: boolean; scanId?: string; error?: string };
  if (!started.success || !started.scanId)
    throw new Error(started.error || 'Could not start a Studio scan.');
  const scanId = started.scanId;
  let lastProgress = -1;
  let progressAt = Date.now();
  while (Date.now() - progressAt < 300_000) {
    const health = await invoke<{
      sessionId?: string;
      synced: boolean;
      completedScanId?: string;
      activeScanId?: string;
      requestedScanId?: string;
      scanStatus?: { scanned?: number } | null;
    }>('get_studio_health_status', { sessionId });
    if (!health.synced || health.sessionId !== sessionId)
      throw new Error('The selected Studio window disconnected during its scan.');
    if (health.completedScanId === scanId) return scanId;
    if (health.activeScanId !== scanId && health.requestedScanId !== scanId)
      throw new Error('The Studio scan was aborted or replaced.');
    const scanned = health.scanStatus?.scanned ?? 0;
    if (scanned !== lastProgress) {
      lastProgress = scanned;
      progressAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    'The selected Studio scan made no progress for 5 minutes. Check the plugin before retrying.',
  );
}
