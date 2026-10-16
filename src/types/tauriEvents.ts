export type TauriEventPayload<T> = {
  payload: T;
};

export type SpooferProgressPayload = {
  jobId?: string;
  progress?: number;
  message?: string;
  current?: number;
  total?: number;
};

export type SpooferLogPayload = {
  jobId?: string;
  level?: string;
  message?: string;
};

export type SpooferAssetResult = {
  id?: string;
  type?: string;
  assetType?: string;
  name?: string;
  success?: boolean;
  newId?: string;
  newAssetId?: string;
  new_asset_id?: string;
  stage?: string;
  errorReason?: string;
  skipped?: boolean;
  cancelled?: boolean;
  localPath?: string;
  path?: string;
  assetId?: string;
  meshId?: string;
  imageId?: string;
  moderation?: 'approved' | 'pending' | 'rejected';
  cacheHit?: boolean;
  permission?: { status: 'granted' | 'failed' | 'not_requested'; reason?: string };
  reason?: string;
};

export type SpooferResultPayload = {
  jobId?: string;
  success?: boolean;
  partial?: boolean;
  cancelled?: boolean;
  error?: string;
  output?: string;
  assetResults?: SpooferAssetResult[];
  results?: SpooferAssetResult[];
  replacements?: Record<string, string>;
  keyframe_warnings?: number;
};

export type SpooferStartedPayload = {
  jobId: string;
  job_id?: string;
  logFilePath?: string;
};

export type ScriptRefProgressPayload = {
  resolved?: number;
  total?: number;
};
