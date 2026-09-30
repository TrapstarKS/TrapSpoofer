export interface SpoofJobAssetResult {
  id: string;
  type?: string;
  assetType?: string;
  name?: string;
  success: boolean;
  stage?: 'download' | 'upload';
  errorReason?: string;
  newId?: string;
  skipped?: boolean;
  cancelled?: boolean;
  localPath?: string;
  reason?: string;
}

export type SpoofJobResultKind = 'uploaded' | 'downloaded' | 'skipped' | 'failed' | 'cancelled';

export interface SpoofJobResultCounts {
  uploaded: number;
  downloaded: number;
  skipped: number;
  failed: number;
  cancelled: number;
  total: number;
}

export function spoofJobResultKind(result: SpoofJobAssetResult): SpoofJobResultKind {
  if (result.cancelled) return 'cancelled';
  if (result.skipped) return 'skipped';
  if (!result.success) return 'failed';
  if (result.reason === 'downloaded' || result.stage === 'download' || result.localPath)
    return 'downloaded';
  return 'uploaded';
}

export function countSpoofJobResults(results: SpoofJobAssetResult[]): SpoofJobResultCounts {
  const counts: SpoofJobResultCounts = {
    uploaded: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    total: results.length,
  };
  for (const result of results) counts[spoofJobResultKind(result)] += 1;
  return counts;
}

interface SpoofJobConfig {
  assets: string;
  groupId?: string | null;
  spoofSounds: boolean;
  downloadOnly: boolean;
  uploadTypes?: string[];
}

export interface SpoofJob {
  id: string;
  status: 'successful' | 'errored' | 'partially_finished';
  startTime: string;
  endTime: string;
  durationMs: number;
  account: { id: string; name: string; avatarUrl: string };
  group?: { id: string; name: string; iconUrl: string };
  assetResults: SpoofJobAssetResult[];
  config: SpoofJobConfig;
  logFilePath?: string;
}

export interface PendingSpoofRetry {
  jobId: string;
  assetIds: string[];
  selectedUserId?: string;
  selectedGroupId?: string;
  spoofSounds?: boolean;
  uploadTypes?: string[];
  account?: { id: string; name: string; avatarUrl: string };
  group?: { id: string; name: string; iconUrl: string } | null;
  assetTypes?: Record<string, string>;
}

const PENDING_SPOOF_RETRY_KEY = 'TrapSpoofer_PendingSpoofRetry';

export function queueSpoofRetry(retry: PendingSpoofRetry) {
  sessionStorage.setItem(PENDING_SPOOF_RETRY_KEY, JSON.stringify(retry));
}

export function takeSpoofRetry(): PendingSpoofRetry | null {
  const serialized = sessionStorage.getItem(PENDING_SPOOF_RETRY_KEY);
  sessionStorage.removeItem(PENDING_SPOOF_RETRY_KEY);
  if (!serialized) return null;

  try {
    const retry = JSON.parse(serialized) as PendingSpoofRetry;
    if (!retry.jobId || !Array.isArray(retry.assetIds) || retry.assetIds.length === 0) return null;
    return retry;
  } catch {
    return null;
  }
}
