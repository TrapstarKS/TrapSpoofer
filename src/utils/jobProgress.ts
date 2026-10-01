import type { AssetStage } from '../stores/spooferStore';
import type { SpooferAssetResult } from '../types/tauriEvents';

export const terminalStages = new Set<AssetStage>(['done', 'error', 'skipped', 'cancelled']);

export function stageFromResult(result: SpooferAssetResult): AssetStage {
  if (result.cancelled) return 'cancelled';
  if (result.skipped) return 'skipped';
  return result.success ? 'done' : 'error';
}

export function normalizeJobResults(
  results: SpooferAssetResult[],
  assets: Record<string, { name: string; type: string }>,
  error: string,
  cancelled = false,
): SpooferAssetResult[] {
  const byId = new Map<string, SpooferAssetResult>();
  for (const result of results) {
    const id = String(result.id ?? '');
    if (id && Object.hasOwn(assets, id)) byId.set(id, { ...assets[id], ...result, id });
  }
  return Object.entries(assets).map(
    ([id, metadata]) =>
      byId.get(id) ?? { id, ...metadata, success: false, cancelled, errorReason: error },
  );
}

export function countJobResults(results: SpooferAssetResult[]) {
  const counts = { completed: 0, errors: 0, skipped: 0, cancelled: 0, total: results.length };
  for (const result of results) {
    switch (stageFromResult(result)) {
      case 'done':
        counts.completed += 1;
        break;
      case 'skipped':
        counts.skipped += 1;
        break;
      case 'cancelled':
        counts.cancelled += 1;
        break;
      default:
        counts.errors += 1;
    }
  }
  return counts;
}

export function mergeJobResults(
  previous: SpooferAssetResult[],
  results: SpooferAssetResult[],
): SpooferAssetResult[] {
  const byId = new Map<string, SpooferAssetResult>();
  for (const result of [...previous, ...results]) {
    if (result.id) byId.set(result.id, result);
  }
  return [...byId.values()];
}

export function jobReplacements(
  results: SpooferAssetResult[],
  history: Record<string, string> = {},
  assetIds: string[] = [],
): Record<string, string> {
  const pairs =
    results.length > 0
      ? results
          .filter((result) => result.success && !result.cancelled)
          .map((result) => [result.id, result.newId ?? result.newAssetId ?? result.new_asset_id])
      : assetIds.map((id) => [id, history[id]]);
  return Object.fromEntries(
    pairs.filter(
      (pair): pair is [string, string] =>
        typeof pair[0] === 'string' &&
        /^[1-9]\d*$/.test(pair[0]) &&
        typeof pair[1] === 'string' &&
        /^[1-9]\d*$/.test(pair[1]),
    ),
  );
}

export function acceptsJobEvent(activeJobId: string | null, isRunning: boolean, jobId?: string) {
  return Boolean(isRunning && activeJobId && activeJobId === jobId);
}

export function transferStage(
  current: AssetStage,
  transferId: string,
  status: string | undefined,
  jobId: string,
): AssetStage | null {
  if (!transferId.startsWith(`${jobId}:`) || terminalStages.has(current)) return null;
  if (transferId.includes(':up:')) return 'uploading';
  if (current === 'uploading') return null;
  if (
    status === 'resolving_location' ||
    status === 'discovering_usage' ||
    status === 'discovering_graph' ||
    status === 'recovering'
  )
    return status;
  if (status?.startsWith('downloading')) return 'downloading';
  return null;
}
