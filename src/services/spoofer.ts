/**
 * TrapSpoofer core actions. Everything that used to live inside the hidden
 * SpoofingView (scan, run, push, discover...) goes through here, so the UI,
 * the legacy explorer and the MCP server all share one code path.
 */
import { invoke } from '@tauri-apps/api/core';

import { useConfigStore } from '../stores/configStore';
import { isOwnedBy, useSessionStore } from '../stores/sessionStore';
import { applyReplacements, useSpooferStore } from '../stores/spooferStore';
import { getStudioPlaceIdFallback } from '../utils/apiClient';
import { addDebugLog } from '../utils/debugLogger';
import {
  loadCachedGroups,
  loadCachedUsers,
  logIsm,
  normalizeId,
  type RobloxGroup,
  saveCachedGroups,
  validateCookieProfile,
} from '../utils/robloxProfiles';
import { appendSpoofingLog } from '../utils/spoofingLogs';
import { triggerStudioScan } from '../utils/studioScan';
import { isTauriRuntime } from '../utils/tauriRuntime';
import {
  type AssetOwner,
  type AssetStores,
  buildAssetList,
  buildExplorerTree,
  parseAssetIds,
  scriptRefIds,
  type SpoofAsset,
  type SpoofAssetType,
} from './assets';

const log = (line: string) =>
  useSpooferStore.getState().setSpoofingLogs((prev) => appendSpoofingLog(prev, line));

const SCAN_TYPE_KEYS: Record<SpoofAssetType, string> = {
  animation: 'animations',
  audio: 'sounds',
  image: 'images',
  mesh: 'meshes',
  video: 'images',
};

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

async function resolveScriptRefs(stores: AssetStores): Promise<Record<string, string>> {
  const ids = scriptRefIds(stores);
  if (ids.length === 0 || !isTauriRuntime()) return {};
  try {
    return (
      (await invoke<Record<string, string> | null>('resolve_script_references', {
        assetIds: ids,
      })) ?? {}
    );
  } catch (e) {
    addDebugLog('warn', ['resolve_script_references failed', e]);
    return {};
  }
}

/** Mirror the session into the legacy explorer tree. */
function syncExplorer(assets: SpoofAsset[], label: string, filePath?: string) {
  const spoofer = useSpooferStore.getState();
  spoofer.setRootInstances([buildExplorerTree(assets, label)]);
  spoofer.setLoadedFileName(label);
  spoofer.setLoadedFilePath(filePath ?? null);
  spoofer.setLastScanTime(Date.now());
  const ids = new Set(assets.map((a) => a.id));
  spoofer.setSelectedAssetIds(ids);
  spoofer.setSelectedAssetKeys(new Set());
}

async function adoptStores(
  stores: AssetStores,
  source: { kind: 'studio' | 'file'; label: string; filePath?: string; placeId?: string | null },
): Promise<SpoofAsset[]> {
  const session = useSessionStore.getState();
  session.setScanPhase('resolving');
  const scriptTypes = await resolveScriptRefs(stores);
  const assets = buildAssetList(stores, scriptTypes);
  session.setSource({ ...source, scannedAt: Date.now() }, assets);
  session.setScanPhase('done');
  syncExplorer(assets, source.label, source.filePath);
  void resolveOwners();
  return assets;
}

export interface StudioScanOptions {
  types?: SpoofAssetType[];
  scanPath?: string;
}

export async function scanStudio(options: StudioScanOptions = {}): Promise<SpoofAsset[]> {
  const session = useSessionStore.getState();
  const spoofer = useSpooferStore.getState();
  if (session.scanPhase === 'scanning' || session.scanPhase === 'resolving') {
    throw new Error('Um scan já está em andamento.');
  }
  const types = options.types?.length
    ? Array.from(new Set(options.types.map((t) => SCAN_TYPE_KEYS[t])))
    : ['animations', 'sounds', 'images', 'meshes'];
  types.push('scripts');

  session.setScanPhase('scanning');
  spoofer.setIsScanningStudio(true);
  log('[INFO] Scanning Roblox Studio for assets...');
  try {
    await triggerStudioScan({ scanTypes: types, scanPath: options.scanPath });
    const stores = await invoke<AssetStores>('get_studio_asset_snapshots');
    const health = await invoke<{ studioPlaceId?: string | null; studioPlaceName?: string | null }>(
      'get_studio_health_status',
    ).catch(() => ({}) as { studioPlaceId?: string | null; studioPlaceName?: string | null });
    const label =
      health.studioPlaceName?.trim() ||
      (health.studioPlaceId && health.studioPlaceId !== '0'
        ? `Place ${health.studioPlaceId}`
        : 'Roblox Studio');
    const assets = await adoptStores(stores, {
      kind: 'studio',
      label,
      placeId: health.studioPlaceId ?? null,
    });
    log(`[SUCCESS] Studio scan complete: ${assets.length} unique asset(s).`);
    logIsm('info', `Scan do Studio concluído: ${assets.length} asset(s).`, true);
    return assets;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.setScanPhase('error', message);
    log(`[ERROR] Studio scan failed: ${message}`);
    throw new Error(message, { cause: error });
  } finally {
    spoofer.setIsScanningStudio(false);
  }
}

export interface FileScanResult {
  fileName: string;
  filePath: string;
  format: 'binary' | 'xml';
  kind: 'place' | 'model';
  instanceCount: number;
  recordCount: number;
  stores: AssetStores;
}

/** Drop the Windows extended-length prefix (\\?\) the backend returns. */
export const displayPath = (path: string) => path.replace(/^\\\\\?\\/, '');

export async function scanFile(
  path: string,
): Promise<{ assets: SpoofAsset[]; info: FileScanResult }> {
  const session = useSessionStore.getState();
  session.setScanPhase('scanning');
  useSpooferStore.getState().setParsingFileName(path.split(/[\\/]/).pop() ?? path);
  try {
    const info = await invoke<FileScanResult>('scan_place_file_assets', { path });
    const assets = await adoptStores(info.stores, {
      kind: 'file',
      label: info.fileName,
      filePath: displayPath(info.filePath || path),
    });
    log(`[SUCCESS] Loaded ${info.fileName}: ${assets.length} unique asset(s).`);
    return { assets, info };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.setScanPhase('error', message);
    throw new Error(message, { cause: error });
  } finally {
    useSpooferStore.getState().setParsingFileName(null);
  }
}

export async function pickAndScanFile() {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: false,
    filters: [{ name: 'Roblox place/model', extensions: ['rbxl', 'rbxlx', 'rbxm', 'rbxmx'] }],
  });
  if (!picked || Array.isArray(picked)) return null;
  return scanFile(picked);
}

/** Add ids typed/pasted by the user. Types are looked up when possible. */
export async function addManualIds(text: string): Promise<SpoofAsset[]> {
  const ids = parseAssetIds(text);
  if (ids.length === 0) return [];
  let types: Record<string, string> = {};
  if (isTauriRuntime()) {
    types =
      (await invoke<Record<string, string> | null>('resolve_script_references', {
        assetIds: ids,
      }).catch(() => null)) ?? {};
  }
  const assets: SpoofAsset[] = ids.map((id) => {
    const resolved = (types[id] || '').toLowerCase();
    const type: SpoofAssetType =
      resolved === 'audio' || resolved === 'image' || resolved === 'mesh' || resolved === 'video'
        ? resolved
        : 'animation';
    return { id, type, name: `Asset ${id}`, usages: [], fromScript: false };
  });
  useSessionStore.getState().addManualAssets(assets);
  const all = useSessionStore.getState().assets;
  syncExplorer(all, useSessionStore.getState().source?.label ?? 'IDs');
  void resolveOwners();
  return assets;
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

export interface ActiveTarget {
  userId: string;
  groupId: string;
  cookie: string;
  apiKey: string;
  accountName: string;
  groupName: string | null;
}

export function getActiveTarget(): ActiveTarget {
  const { config, accountSecrets } = useConfigStore.getState();
  const s = config.spoofing;
  const isGroup = s.selectedGroup !== 'none';
  const secrets = accountSecrets[s.selectedUser] ?? {};
  const apiKey = isGroup
    ? s.groupApiKey?.trim() ||
      secrets.groupApiKey?.trim() ||
      s.apiKey?.trim() ||
      secrets.apiKey?.trim() ||
      ''
    : s.apiKey?.trim() || secrets.apiKey?.trim() || '';
  const account = config.accounts.find((a) => a.id === s.selectedUser);
  const cachedUser = loadCachedUsers().find((u) => String(u.id) === s.selectedUser);
  const group = isGroup
    ? loadCachedGroups(s.selectedUser).find(
        (g) => normalizeId(g.id) === normalizeId(s.selectedGroup),
      )
    : undefined;
  return {
    userId: s.selectedUser,
    groupId: s.selectedGroup,
    cookie: (s.cookie || secrets.cookie || '').trim(),
    apiKey,
    accountName: account?.name || cachedUser?.displayName || cachedUser?.name || 'Sem perfil',
    groupName: isGroup ? group?.name || `Grupo ${s.selectedGroup}` : null,
  };
}

/** Single entry point for switching profile + upload target. */
export async function activateProfile(accountId: string, groupId: string | null = null) {
  const store = useConfigStore.getState();
  const account = store.config.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Perfil ${accountId} não encontrado.`);
  const secrets = store.accountSecrets[accountId] ?? {};
  store.updateCategory('advanced', { autoCookieStudio: false, autoCookieBrowser: false });
  store.updateCategory('spoofing', {
    selectedUser: accountId,
    selectedGroup: groupId && groupId !== 'none' ? groupId : 'none',
    cookie: secrets.cookie ?? '',
    apiKey: secrets.apiKey ?? '',
    groupApiKey: secrets.groupApiKey ?? '',
  });
  useSessionStore.setState({ owners: {} });
  void resolveOwners();
}

/** Deselect the active profile (e.g. after removing it). */
export function clearActiveProfile() {
  useConfigStore.getState().updateCategory('spoofing', {
    selectedUser: 'none',
    selectedGroup: 'none',
    cookie: '',
    apiKey: '',
    groupApiKey: '',
  });
  useSessionStore.setState({ owners: {} });
}

export async function setUploadGroup(groupId: string | null) {
  const store = useConfigStore.getState();
  const accountId = store.config.spoofing.selectedUser;
  const secrets = store.accountSecrets[accountId] ?? {};
  store.updateCategory('spoofing', {
    selectedGroup: groupId && groupId !== 'none' ? groupId : 'none',
    groupApiKey: secrets.groupApiKey ?? store.config.spoofing.groupApiKey ?? '',
  });
}

export async function fetchGroups(accountId?: string): Promise<RobloxGroup[]> {
  const store = useConfigStore.getState();
  const userId = accountId ?? store.config.spoofing.selectedUser;
  const cookie =
    (userId === store.config.spoofing.selectedUser ? store.config.spoofing.cookie : '') ||
    store.accountSecrets[userId]?.cookie ||
    '';
  const cached = loadCachedGroups(userId);
  if (!cookie || !isTauriRuntime()) return cached;
  try {
    const raw = await invoke<RobloxGroup[]>('get_manageable_groups', { cookie });
    const icons = await invoke<Record<string, string>>('get_group_icons_batch', {
      groupIds: raw.map((g) => String(g.id)),
    }).catch(() => ({}) as Record<string, string>);
    const groups = raw.map((g) => ({ ...g, iconUrl: icons[String(g.id)] || undefined }));
    saveCachedGroups(userId, groups);
    return groups;
  } catch (e) {
    addDebugLog('warn', ['get_manageable_groups failed', e]);
    return cached;
  }
}

/* ------------------------------------------------------------------ */
/* Ownership                                                           */
/* ------------------------------------------------------------------ */

let ownersRun = 0;

export async function resolveOwners(): Promise<void> {
  const session = useSessionStore.getState();
  const { cookie } = getActiveTarget();
  const missing = session.assets.filter((a) => !session.owners[a.id]).map((a) => a.id);
  if (!isTauriRuntime() || !cookie || missing.length === 0) return;
  const run = ++ownersRun;
  session.setOwnersLoading(true);
  try {
    const resolved = await invoke<
      Array<{
        assetId: string;
        creatorId?: string | null;
        creatorType?: string | null;
        creator?: string | null;
        name?: string | null;
      }>
    >('resolve_asset_creators', {
      assets: missing.map((id) => ({ assetId: id })),
      cookie,
    });
    if (run !== ownersRun) return;
    const owners: Record<string, AssetOwner> = {};
    for (const r of resolved) owners[r.assetId] = r;
    useSessionStore.getState().setOwners(owners);
    // Real names beat "Asset 123" placeholders.
    useSessionStore.setState((state) => ({
      assets: state.assets.map((a) =>
        a.name.startsWith('Asset ') && owners[a.id]?.name ? { ...a, name: owners[a.id]!.name! } : a,
      ),
    }));
  } catch (e) {
    addDebugLog('warn', ['resolve_asset_creators failed', e]);
  } finally {
    if (run === ownersRun) useSessionStore.getState().setOwnersLoading(false);
  }
}

/** true = already owned by the active target (no need to spoof). */
export function ownershipOf(assetId: string): boolean | undefined {
  const { owners } = useSessionStore.getState();
  const { userId, groupId } = getActiveTarget();
  return isOwnedBy(owners[assetId], userId, groupId);
}

/* ------------------------------------------------------------------ */
/* Spoof job                                                           */
/* ------------------------------------------------------------------ */

export type RunFailure =
  | 'busy'
  | 'no_profile'
  | 'bad_cookie'
  | 'no_assets'
  | 'no_api_key'
  | 'bad_api_key'
  | 'quota'
  | 'launch_failed';

export type RunResult =
  | { ok: true; count: number; warnings: string[] }
  | {
      ok: false;
      reason: RunFailure;
      message: string;
      quota?: { audioCount: number; remaining: number };
    };

export interface RunOptions {
  /** Explicit ids. Default: current selection filtered by the type filter. */
  assetIds?: string[];
  /** Override detected types (retry flows). */
  assetTypes?: Record<string, string>;
  ignoreQuota?: boolean;
  downloadOnly?: boolean;
  /** Keep previous mappings for ids that were already spoofed. */
  skipAlreadySpoofed?: boolean;
}

type ApiKeyOwner = { ok: boolean; ownerUserId?: string | null; message?: string };

export function parseAudioQuota(payload: unknown): { remaining: number; total: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload as Record<string, unknown>;
  const records: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(response.assetQuotas)
      ? response.assetQuotas
      : Array.isArray(response.quotas)
        ? response.quotas
        : [payload];
  const record =
    records.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const assetType = String((item as Record<string, unknown>).assetType || '').toLowerCase();
      return !assetType || assetType === 'audio';
    }) || records[0];
  if (!record || typeof record !== 'object') return null;
  const quota = record as Record<string, unknown>;
  const total = Number(quota.capacity);
  const usage = Number(quota.usage);
  if (!Number.isFinite(total) || !Number.isFinite(usage)) return null;
  return { remaining: Math.max(0, total - usage), total };
}

export async function getAudioQuota(): Promise<{ remaining: number; total?: number } | null> {
  const { cookie } = getActiveTarget();
  if (!cookie || !isTauriRuntime()) return null;
  try {
    const payload = await invoke<unknown>('fetch_audio_quota', { cookie, autoDetect: false });
    return parseAudioQuota(payload);
  } catch {
    return null;
  }
}

export function selectedAssetIds(): string[] {
  const { assets, selected, typeFilter } = useSessionStore.getState();
  return assets.filter((a) => selected.has(a.id) && typeFilter.has(a.type)).map((a) => a.id);
}

export async function runSpoof(options: RunOptions = {}): Promise<RunResult> {
  const spoofer = useSpooferStore.getState();
  const { config, accountSecrets } = useConfigStore.getState();
  const session = useSessionStore.getState();
  const warnings: string[] = [];

  if (spoofer.isSpoofing) {
    return { ok: false, reason: 'busy', message: 'Já existe um job de spoof rodando.' };
  }

  const target = getActiveTarget();
  if (target.cookie.length < 50) {
    return {
      ok: false,
      reason: 'no_profile',
      message: 'Nenhum perfil Roblox ativo. Adicione/seleciona um perfil em Contas.',
    };
  }
  try {
    await validateCookieProfile(target.cookie);
  } catch {
    return {
      ok: false,
      reason: 'bad_cookie',
      message: 'O cookie do perfil ativo expirou ou é inválido. Atualize o perfil em Contas.',
    };
  }

  const downloadOnly = options.downloadOnly ?? config.spoofing.downloadOnly;
  if (!downloadOnly && target.apiKey.length < 20) {
    return {
      ok: false,
      reason: 'no_api_key',
      message:
        'Falta a Open Cloud API Key (permissão Assets: read + write) para enviar os assets. Configure em Contas.',
    };
  }

  const ids = Array.from(
    new Set((options.assetIds ?? selectedAssetIds()).filter((id) => /^\d{5,20}$/.test(id))),
  );
  if (ids.length === 0) {
    return {
      ok: false,
      reason: 'no_assets',
      message: 'Nenhum asset selecionado. Faça um scan, abra um arquivo ou cole IDs.',
    };
  }

  const byId = new Map(session.assets.map((a) => [a.id, a]));
  const payload = ids.map((id) => {
    const asset = byId.get(id);
    const override = options.assetTypes?.[id];
    const type =
      override &&
      ['animation', 'audio', 'image', 'mesh', 'script_ref', 'raw_keyframe_sequence'].includes(
        override,
      )
        ? override
        : (asset?.type ?? 'animation');
    return { id, type, name: asset?.name ?? `Asset ${id}`, rawValue: `rbxassetid://${id}` };
  });

  if (!options.ignoreQuota && !downloadOnly) {
    const audioCount = payload.filter((p) => p.type === 'audio').length;
    if (audioCount > 0) {
      const quota = await getAudioQuota();
      if (quota && audioCount > quota.remaining) {
        return {
          ok: false,
          reason: 'quota',
          message: `Você selecionou ${audioCount} áudio(s), mas a cota mensal só permite mais ${quota.remaining}.`,
          quota: { audioCount, remaining: quota.remaining },
        };
      }
    }
  }

  if (!downloadOnly && isTauriRuntime()) {
    try {
      const owner = await invoke<ApiKeyOwner>('detect_opencloud_api_key_owner', {
        key: target.apiKey,
      });
      if (!owner.ok && /invalid|unauthorized/i.test(owner.message || '')) {
        return {
          ok: false,
          reason: 'bad_api_key',
          message: owner.message || 'A API Key foi recusada pelo Roblox.',
        };
      }
      if (
        owner.ok &&
        owner.ownerUserId &&
        target.groupId === 'none' &&
        normalizeId(owner.ownerUserId) !== normalizeId(target.userId)
      ) {
        warnings.push(
          `A API Key pertence ao usuário ${owner.ownerUserId}, mas o perfil ativo é ${target.userId}.`,
        );
      }
    } catch (e) {
      warnings.push(`Não foi possível pré-validar a API Key (${String(e)}).`);
    }
  }

  spoofer.setAssetMetadataMap(
    Object.fromEntries(payload.map((p) => [p.id, { name: p.name, type: p.type }])),
  );
  spoofer.setSpoofingLogs([
    `[INFO] Job iniciado: ${payload.length} asset(s) -> ${target.groupName ?? target.accountName}\n`,
    ...warnings.map((w) => `[WARN] ${w}\n`),
  ]);
  spoofer.setSpoofProgress(0);
  spoofer.setIsSpoofing(true);
  spoofer.setSpoofTotalCount(payload.length);
  spoofer.setSpoofCurrentCount(0);
  for (const item of payload) {
    spoofer.setAssetStatus(item.id, { stage: 'downloading', message: 'Na fila...' });
  }

  try {
    const cachedUser = loadCachedUsers().find((u) => String(u.id) === target.userId);
    const account = {
      id: target.userId,
      name: target.accountName,
      avatarUrl:
        cachedUser?.avatarUrl ||
        config.accounts.find((a) => a.id === target.userId)?.avatarUrl ||
        '',
    };
    const groupInfo =
      target.groupId !== 'none'
        ? loadCachedGroups(target.userId).find(
            (g) => normalizeId(g.id) === normalizeId(target.groupId),
          )
        : undefined;
    const group =
      target.groupId !== 'none'
        ? {
            id: target.groupId,
            name: groupInfo?.name ?? 'Grupo',
            iconUrl: groupInfo?.iconUrl ?? '',
          }
        : null;

    const placeIdFallback =
      session.source?.placeId && session.source.placeId !== '0'
        ? session.source.placeId
        : await getStudioPlaceIdFallback().catch(() => '');
    const forced = useSpooferStore.getState().assetForcePlaceIds || {};
    const forcePlaceIds = Array.from(
      new Set(
        payload
          .map((p) => forced[p.id]?.trim() || placeIdFallback?.trim())
          .filter((p): p is string => Boolean(p)),
      ),
    ).join(',');

    const fallbackCookies = config.accounts
      .filter((a) => a.isDownloader && a.id !== target.userId)
      .map((a) => accountSecrets[a.id]?.cookie)
      .filter((c): c is string => Boolean(c));

    const adv = config.advanced;
    await invoke('run_spoofer_action', {
      data: {
        assets: JSON.stringify(payload),
        cookie: target.cookie,
        fallbackCookies: fallbackCookies.length ? fallbackCookies : null,
        apiKey: target.apiKey,
        groupId: target.groupId !== 'none' ? target.groupId : null,
        spoofSounds: config.spoofing.audio,
        uploadTypes: downloadOnly ? ['download'] : config.spoofing.uploadTypes,
        downloadPath: config.spoofing.downloadPath,
        placeName: session.source?.label ?? null,
        concurrent: adv.concurrentSpoofing,
        concurrentDownloading: adv.concurrentDownloading,
        maxConcurrency: adv.maxConcurrency,
        maxDownloadConcurrency: adv.maxDownloadConcurrency,
        skipOwned: adv.skipOwned,
        excludedUserIds: adv.excludedUserIds,
        excludedGroupIds: adv.excludedGroupIds,
        skipExistingReplacements: options.skipAlreadySpoofed ?? false,
        existingReplacements: useSpooferStore.getState().lastReplacements,
        account,
        group,
        preserveMetadata: config.spoofing.preserveMetadata,
        enableArchiveRecovery: adv.enableArchiveRecovery,
        proxyUrl: adv.proxyUrl,
        operationPollIntervalMs: adv.operationPollIntervalMs || 250,
        forcePlaceIds: forcePlaceIds || null,
        assetForcePlaceIds: Object.keys(forced).length ? forced : null,
      },
    });
    return { ok: true, count: payload.length, warnings };
  } catch (err) {
    useSpooferStore.getState().setIsSpoofing(false);
    const message = err instanceof Error ? err.message : String(err);
    logIsm('error', `Não foi possível iniciar o spoof: ${message}`, true);
    return { ok: false, reason: 'launch_failed', message };
  }
}

export function pauseJob() {
  const id = useSpooferStore.getState().activeSpooferJobId;
  if (!id) return false;
  void invoke('spoofer_pause', { jobId: id });
  useSpooferStore.getState().setIsJobPaused(true);
  return true;
}

export function resumeJob() {
  const id = useSpooferStore.getState().activeSpooferJobId;
  if (!id) return false;
  void invoke('spoofer_resume', { jobId: id });
  useSpooferStore.getState().setIsJobPaused(false);
  return true;
}

export async function cancelJob(): Promise<boolean> {
  const id = useSpooferStore.getState().activeSpooferJobId;
  if (!id) return false;
  const ok = await invoke<boolean>('spoofer_cancel', { jobId: id }).catch(() => false);
  if (ok) log('[WARN] Cancelamento solicitado. Os assets em andamento vão terminar primeiro.');
  return ok;
}

export async function forceReset() {
  await invoke('force_reset_spoofer_job').catch(() => undefined);
  const spoofer = useSpooferStore.getState();
  spoofer.setIsSpoofing(false);
  spoofer.setActiveSpooferJobId(null);
  spoofer.setIsJobPaused(false);
}

/** Resolves true when no job is running (or false on timeout). */
export function waitForJob(timeoutMs: number): Promise<boolean> {
  if (!useSpooferStore.getState().isSpoofing) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useSpooferStore.subscribe((state) => {
      if (!state.isSpoofing) {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(true);
      }
    });
  });
}

export function jobSnapshot() {
  const s = useSpooferStore.getState();
  const results = s.lastAssetResults;
  const failed = results.filter((r) => !r.success && !r.skipped);
  return {
    running: s.isSpoofing,
    paused: s.isJobPaused,
    jobId: s.activeSpooferJobId,
    progress: Math.round(s.spoofProgress),
    current: s.spoofCurrentCount,
    total: s.spoofTotalCount,
    status: s.spoofStatusText,
    lastResult: s.isSpoofing
      ? null
      : {
          succeeded: results.filter((r) => r.success).length,
          skipped: results.filter((r) => r.skipped).length,
          failed: failed.map((r) => ({
            id: String(r.id ?? ''),
            reason: r.errorReason || r.reason || 'Failed',
          })),
        },
    mappings: s.lastReplacements,
    recentLog: s.spoofingLogs.slice(-15),
  };
}

export async function retryFailed(): Promise<RunResult> {
  const results = useSpooferStore.getState().lastAssetResults;
  const failed = results.filter((r) => r.success === false && !r.skipped);
  const assetTypes: Record<string, string> = {};
  const ids: string[] = [];
  for (const r of failed) {
    const id = String(r.id || '').replace(/\D/g, '');
    if (!id) continue;
    ids.push(id);
    const type = String(r.type || r.assetType || '');
    if (type) assetTypes[id] = type;
  }
  return runSpoof({ assetIds: ids, assetTypes, ignoreQuota: true });
}

/* ------------------------------------------------------------------ */
/* Applying results                                                    */
/* ------------------------------------------------------------------ */

/** Queue replacements for the Studio plugin. Explicit mappings are not saved as job history unless `persist`. */
export async function pushToStudio(
  mappings?: Record<string, string>,
  options: { persist?: boolean } = {},
) {
  const map = mappings ?? useSpooferStore.getState().lastReplacements;
  if (Object.keys(map).length === 0) throw new Error('Nenhum mapeamento para aplicar ainda.');
  await applyReplacements(map, !(options.persist ?? false) || !mappings);
  return Object.keys(map).length;
}

export async function writeSpoofedFile(options: {
  path?: string;
  outputPath?: string;
  mappings?: Record<string, string>;
}) {
  const source = useSessionStore.getState().source;
  const path = options.path ?? source?.filePath;
  if (!path) throw new Error('Nenhum arquivo .rbxl/.rbxm carregado.');
  const mappings = options.mappings ?? useSpooferStore.getState().lastReplacements;
  if (Object.keys(mappings).length === 0) {
    throw new Error('Nenhum mapeamento: rode o spoof antes de salvar o arquivo.');
  }
  const result = await invoke<{
    outputPath: string;
    patchesApplied: number;
    patchesFailed: number;
    warnings: string[];
  }>('write_spoofed_place_file', {
    path,
    outputPath: options.outputPath ?? null,
    mappings,
  });
  result.outputPath = displayPath(result.outputPath);
  useSessionStore.getState().setLastFileWrite(result);
  log(`[SUCCESS] Arquivo salvo: ${result.outputPath} (${result.patchesApplied} substituições).`);
  return result;
}

/* ------------------------------------------------------------------ */
/* Place-id discovery (private animations)                             */
/* ------------------------------------------------------------------ */

export async function discoverPlaceIds(assetIds?: string[], timeoutSecs = 60) {
  const store = useSpooferStore.getState();
  const { cookie } = getActiveTarget();
  if (cookie.length < 50) throw new Error('Selecione um perfil com cookie válido.');
  const ids = assetIds?.length ? assetIds : selectedAssetIds();
  if (ids.length === 0) throw new Error('Nenhum asset para descobrir.');

  store.setIsDiscoveringPlaceIds(true);
  let found = 0;
  const queue = [...ids];
  const concurrency = Math.min(
    useConfigStore.getState().config.advanced.discoveryConcurrency ?? 30,
    ids.length,
  );
  const worker = async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) continue;
      store.setAssetStatus(id, { stage: 'discovering_graph', message: 'Procurando Place ID...' });
      try {
        const pid = await Promise.race([
          invoke<string | null>('discover_asset_place_id', {
            assetId: id,
            cookie,
            forcedPlaceId: useSpooferStore.getState().assetForcePlaceIds[id] || null,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutSecs * 1000)),
        ]);
        if (pid) {
          found++;
          store.setAssetForcePlaceIds((prev) => ({ ...prev, [id]: pid }));
          store.setAssetStatus(id, { stage: 'done', message: `Place ID: ${pid}` });
        } else {
          store.setAssetStatus(id, { stage: 'error', message: 'Nenhum Place ID encontrado' });
        }
      } catch {
        store.setAssetStatus(id, { stage: 'error', message: 'Falha na busca' });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    store.setIsDiscoveringPlaceIds(false);
  }
  return { searched: ids.length, found };
}
