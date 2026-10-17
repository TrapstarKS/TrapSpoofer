import type { SpooferAssetResult } from '../types/tauriEvents';

type Job = Record<string, unknown>;

export function jobCounts(assets: SpooferAssetResult[], total = assets.length) {
  const counts = {
    total,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    pending: 0,
    moderation: { approved: 0, pending: 0, rejected: 0 },
    permission: { granted: 0, failed: 0, not_requested: 0 },
  };
  for (const asset of assets) {
    if (asset.cancelled) counts.cancelled++;
    else if (asset.skipped) counts.skipped++;
    else if (
      asset.success === false ||
      asset.moderation === 'rejected' ||
      asset.permission?.status === 'failed'
    )
      counts.failed++;
    else if (asset.success === true) counts.completed++;
    if (asset.moderation) counts.moderation[asset.moderation]++;
    if (asset.permission) counts.permission[asset.permission.status]++;
  }
  counts.pending = Math.max(
    0,
    total - counts.completed - counts.failed - counts.skipped - counts.cancelled,
  );
  return counts;
}

export function jobFailures(assets: SpooferAssetResult[]) {
  return assets
    .filter(
      (asset) =>
        (asset.success === false && !asset.skipped && !asset.cancelled) ||
        asset.permission?.status === 'failed' ||
        asset.moderation === 'rejected',
    )
    .map((asset) => ({
      id: asset.id,
      reason:
        asset.errorReason ||
        asset.reason ||
        asset.permission?.reason ||
        (asset.moderation === 'rejected' ? 'Moderation rejected' : 'Failed'),
    }));
}

export function historicalJob(job: Job) {
  const assets = (job.assetResults ?? []) as SpooferAssetResult[];
  const failed =
    job.status === 'errored' ||
    job.status === 'failed' ||
    job.status === 'partially_finished' ||
    jobFailures(assets).length > 0;
  return {
    id: job.id,
    jobId: job.id,
    running: false,
    done: true,
    status: failed ? 'failed' : 'finished',
    progress: 100,
    current: assets.length,
    total: assets.length,
    assets,
    error: job.error,
    startTime: job.startTime,
    endTime: job.endTime,
    durationMs: job.durationMs,
    account: job.account,
    group: job.group,
    pathMappings: Object.fromEntries(
      assets
        .filter(
          (asset) =>
            asset.success &&
            asset.moderation !== 'rejected' &&
            asset.path &&
            (asset.meshId ?? asset.imageId ?? asset.newId),
        )
        .map((asset) => [
          asset.path,
          `rbxassetid://${asset.meshId ?? asset.imageId ?? asset.newId}`,
        ]),
    ),
  };
}

export function jobResponse(
  job: Job,
  options: { summary?: boolean; includeMappings?: boolean } = {},
) {
  const assets = (job.assets ?? []) as SpooferAssetResult[];
  const counts = jobCounts(assets, Number(job.total ?? assets.length));
  const failures = jobFailures(assets);
  if (job.error && failures.length === 0)
    failures.push({ id: undefined, reason: String(job.error) });
  if (options.summary)
    return {
      jobId: job.jobId,
      status: job.status,
      running: job.running,
      done: job.done,
      counts,
      failures,
    };
  const { mappings: _mappings, assetResults: _assetResults, ...scoped } = job;
  return {
    ...scoped,
    counts,
    failures,
    ...(options.includeMappings
      ? {
          mappings: Object.fromEntries(
            assets
              .filter(
                (asset) =>
                  asset.success &&
                  asset.moderation !== 'rejected' &&
                  !asset.cancelled &&
                  asset.id &&
                  (asset.meshId ?? asset.imageId ?? asset.newId),
              )
              .map((asset) => [asset.id, asset.meshId ?? asset.imageId ?? asset.newId]),
          ),
        }
      : {}),
  };
}

export function historyResponse(job: Job, summary = false) {
  const view = historicalJob(job);
  const compact = jobResponse(view, { summary: true });
  if (summary) return compact;
  return {
    ...compact,
    id: view.id,
    startTime: view.startTime,
    endTime: view.endTime,
    durationMs: view.durationMs,
    account: view.account,
    group: view.group,
  };
}
