/**
 * MCP tool implementations. The Rust server (src-tauri/src/mcp) owns the tool
 * catalogue and relays every call here through the `mcp://request` event.
 */
import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

import {
  countByType,
  PUBLIC_NAME_OF,
  PUBLIC_TYPE_NAMES,
  type SpoofAssetType,
} from '../services/assets';
import * as spoofer from '../services/spoofer';
import { useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSpooferStore } from '../stores/spooferStore';
import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import type { SpooferAssetResult } from '../types/tauriEvents';
import { loadCachedGroups } from '../utils/robloxProfiles';
import { historicalJob, historyResponse, jobResponse } from './jobs';
import {
  configuredPermissions,
  getSettings,
  grantPermissionsSchema,
  idSchema,
  updateSettings,
} from './settings';

type Args = Record<string, unknown>;
export type ToolHandler = (args: Args) => Promise<unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function toTypes(value: unknown): SpoofAssetType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => PUBLIC_TYPE_NAMES[String(v)] ?? (String(v).toLowerCase() as SpoofAssetType))
    .filter((t): t is SpoofAssetType =>
      ['animation', 'audio', 'image', 'mesh', 'video'].includes(t),
    );
  return out.length ? out : undefined;
}

function scanSummary() {
  const { source, assets, ownersLoading } = useSessionStore.getState();
  if (!source) return null;
  const counts = countByType(assets);
  const foreign = assets.filter((a) => spoofer.ownershipOf(a.id) !== true).length;
  return {
    source: source.kind,
    name: source.label,
    filePath: source.filePath ?? null,
    scannedAt: new Date(source.scannedAt).toISOString(),
    total: assets.length,
    needsSpoof: foreign,
    ownershipCheckPending: ownersLoading,
    byType: Object.fromEntries(
      Object.entries(counts).map(([type, count]) => [
        PUBLIC_NAME_OF[type as SpoofAssetType],
        count,
      ]),
    ),
  };
}

async function studioStatus() {
  const health = await invoke<{ sessions?: Array<Record<string, unknown>> }>(
    'get_studio_health_status',
  );
  const sessions = health.sessions ?? [];
  useStudioSessionsStore
    .getState()
    .updateSessions(sessions as unknown as import('../stores/studioSessionsStore').StudioSession[]);
  return {
    connected: sessions.some((session) => session.synced),
    selectedSessionId: useStudioSessionsStore.getState().selectedSessionId,
    sessions: sessions
      .filter((session) => session.synced)
      .map((session) => ({
        sessionId: session.sessionId,
        place: session.studioPlaceName,
        placeId: session.studioPlaceId,
        owner: { type: session.studioCreatorType ?? null, id: session.studioCreatorId ?? null },
        scanning: Boolean((session.scanStatus as { scanning?: boolean } | null)?.scanning),
      })),
  };
}

function selectStudioSession(sessionId: unknown) {
  if (typeof sessionId !== 'string') return;
  const store = useStudioSessionsStore.getState();
  store.selectSession(sessionId);
  if (useStudioSessionsStore.getState().selectedSessionId !== sessionId)
    throw new Error('Studio session is not connected');
}

const publishOptionsSchema = z.object({
  profile: z.string().min(1).optional(),
  groupId: idSchema.nullable().optional(),
  grantPermissions: grantPermissionsSchema.optional(),
  studioPathMap: z.record(z.string(), z.string()).optional(),
  pushToStudio: z.boolean().optional(),
  studioSessionId: z.string().optional(),
  dry_run: z.boolean().optional(),
  normalizeCenter: z.boolean().optional(),
});
const publishSchema = publishOptionsSchema
  .extend({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            type: z.enum(['Image', 'Audio', 'Mesh']).optional(),
            name: z.string().min(1).max(100).optional(),
            description: z.string().max(1000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

function safeDestination(options: { profile?: string; groupId?: string | null } = {}) {
  const target = spoofer.getActiveTarget(options);
  return {
    profile: target.userId,
    name: target.accountName,
    groupId: target.groupId === 'none' ? null : target.groupId,
  };
}

async function publishAssets(input: z.infer<typeof publishSchema>) {
  const destination = safeDestination(input);
  const files = await invoke<Array<Record<string, unknown>>>('inspect_publish_files', {
    files: input.files,
    profileId: destination.profile,
    groupId: destination.groupId,
    normalizeCenter: input.normalizeCenter ?? false,
  });
  if (input.dry_run)
    return {
      dry_run: true,
      count: files.length,
      files,
      destination,
      grantPermissions: input.grantPermissions ?? configuredPermissions(),
      quotaEstimate: {
        uploads: files.filter((file) => !file.cacheHit && !file.error).length,
        audioUploads: files.filter(
          (file) =>
            !file.cacheHit && !file.error && (file.type === 'Audio' || file.type === 'audio'),
        ).length,
        note: 'Estimate; cache hits use no upload quota. Roblox enforces creator-specific limits.',
      },
    };
  let studioPathMap = input.studioPathMap;
  if (input.pushToStudio) {
    await studioStatus();
    selectStudioSession(input.studioSessionId);
    const sessionId = input.studioSessionId ?? useStudioSessionsStore.getState().selectedSessionId;
    let refs: Array<{ uri: string; path: string | null }>;
    try {
      refs = await invoke('get_studio_local_references', { sessionId });
    } catch (error) {
      if (!String(error).includes('Complete a scan')) throw error;
      if (input.studioPathMap && Object.keys(input.studioPathMap).length) refs = [];
      else {
        await spoofer.scanStudio();
        refs = await invoke('get_studio_local_references', { sessionId });
      }
    }
    studioPathMap = {
      ...Object.fromEntries(refs.filter((ref) => ref.path).map((ref) => [ref.path!, ref.uri])),
      ...studioPathMap,
    };
  }
  return {
    started: true,
    ...(await spoofer.runAssetAction({ ...input, studioPathMap })),
    destination,
    next: 'Call get_job with jobId and waitSeconds for moderation, meshId/imageId, permission results and pathMappings.',
  };
}

export const handlers: Record<string, ToolHandler> = {
  async get_status() {
    const target = spoofer.getActiveTarget();
    return {
      studio: await studioStatus(),
      profile: {
        userId: target.userId === 'none' ? null : target.userId,
        name: target.accountName,
        uploadTarget: target.groupId === 'none' ? 'user' : 'group',
        groupId: target.groupId === 'none' ? null : target.groupId,
        groupName: target.groupName,
        hasCookie: target.cookie.length >= 50,
        hasApiKey: target.apiKey.length >= 20,
      },
      lastScan: scanSummary(),
      job: spoofer.jobSnapshot(),
    };
  },

  async scan_studio(args) {
    await studioStatus();
    selectStudioSession(args.studioSessionId);
    await spoofer.scanStudio();
    const localReferences = await invoke('get_studio_local_references', {
      sessionId: useSessionStore.getState().source?.studioSessionId ?? null,
    });
    return { ...scanSummary(), localReferences };
  },

  async scan_file(args) {
    const path = str(args.path);
    if (!path) throw new Error('path is required');
    const { info } = await spoofer.scanFile(path);
    return {
      ...scanSummary(),
      format: info.format,
      kind: info.kind,
      instances: info.instanceCount,
    };
  },

  async list_assets(args) {
    const { assets, owners } = useSessionStore.getState();
    const type = str(args.type) ? PUBLIC_TYPE_NAMES[str(args.type)!] : undefined;
    const search = str(args.search)?.toLowerCase();
    const onlyForeign = args.onlyForeign !== false;
    const limit = Math.min(500, num(args.limit, 100));
    const offset = num(args.offset, 0);
    const filtered = assets.filter((a) => {
      if (type && a.type !== type) return false;
      if (onlyForeign && spoofer.ownershipOf(a.id) === true) return false;
      if (search) {
        const hay = `${a.id} ${a.name} ${a.usages.map((u) => u.path).join(' ')}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    return {
      total: filtered.length,
      offset,
      items: filtered.slice(offset, offset + limit).map((a) => ({
        id: a.id,
        type: PUBLIC_NAME_OF[a.type],
        name: a.name,
        owner: owners[a.id]?.creator ?? null,
        ownerType: owners[a.id]?.creatorType ?? null,
        needsSpoof: spoofer.ownershipOf(a.id) !== true,
        usedAt: a.usages.slice(0, 3).map((u) => `${u.path}.${u.property}`),
        usageCount: a.usages.length,
      })),
    };
  },

  async get_settings() {
    return getSettings();
  },

  async update_settings(args) {
    return updateSettings(args);
  },

  async spoof_assets(args) {
    const input = z
      .object({
        assetIds: z.array(idSchema).max(10000).optional(),
        types: z.array(z.enum(['Animation', 'Sound', 'Image', 'Mesh', 'Video'])).optional(),
        autoPush: z.boolean().optional(),
        grantPermissions: grantPermissionsSchema.optional(),
        skipOwned: z.boolean().optional(),
        keepNameAndDescription: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    const { assets } = useSessionStore.getState();
    const skipOwned = input.skipOwned ?? getSettings().skipOwned;
    const types = new Set(toTypes(input.types) ?? ['animation', 'audio']);
    const ids = [
      ...new Set(
        input.assetIds ??
          assets
            .filter((a) => types.has(a.type) && (!skipOwned || spoofer.ownershipOf(a.id) !== true))
            .map((a) => a.id),
      ),
    ];
    const selected = ids.filter((id) => !skipOwned || spoofer.ownershipOf(id) !== true);
    if (input.dry_run) {
      const byId = new Map(assets.map((asset) => [asset.id, asset.type]));
      return {
        dry_run: true,
        count: selected.length,
        skippedOwned: ids.length - selected.length,
        assetIds: selected,
        byType: selected.reduce<Record<string, number>>((counts, id) => {
          const type = byId.get(id) ?? 'animation';
          counts[type] = (counts[type] ?? 0) + 1;
          return counts;
        }, {}),
        destination: safeDestination(),
        grantPermissions: input.grantPermissions ?? configuredPermissions(),
        quotaEstimate: {
          uploads: selected.length,
          audioUploads: selected.filter((id) => byId.get(id) === 'audio').length,
          note: 'Estimate; Roblox enforces creator-specific limits.',
        },
      };
    }
    useSessionStore.setState({ autoApplyOverride: input.autoPush ?? null });
    const result = await spoofer.runSpoof({
      assetIds: ids,
      ignoreQuota: false,
      skipOwned: input.skipOwned,
      keepNameAndDescription: input.keepNameAndDescription,
      grantPermissions: input.grantPermissions,
    });
    if (!result.ok) throw new Error(result.message);
    return {
      started: true,
      jobId: spoofer.jobSnapshot().jobId,
      assets: result.count,
      warnings: result.warnings,
      next: 'Call get_job with jobId and waitSeconds to follow progress.',
    };
  },

  async publish_assets(args) {
    return publishAssets(publishSchema.parse(args));
  },

  async publish_folder(args) {
    const input = publishOptionsSchema
      .extend({
        dir: z.string().min(1),
        recursive: z.boolean().default(false),
        glob: z.string().optional(),
      })
      .strict()
      .parse(args);
    const files = await invoke<spoofer.AssetActionOptions['files']>('list_publish_folder', {
      directory: input.dir,
      recursive: input.recursive,
      glob: input.glob ?? null,
    });
    return publishAssets({ ...input, files: files ?? [] });
  },

  async grant_permissions(args) {
    const input = z
      .object({
        assetIds: z.array(idSchema).min(1).max(1000),
        subjectType: z.enum(['Universe', 'Group', 'User']),
        ids: z.array(idSchema).min(1).max(100),
        dry_run: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    const assetIds = [...new Set(input.assetIds)];
    const grantPermissions = {
      enabled: true,
      subjectType: input.subjectType,
      ids: [...new Set(input.ids)],
    };
    if (input.dry_run)
      return {
        dry_run: true,
        count: assetIds.length,
        assetIds,
        grantPermissions,
        destination: safeDestination(),
        quotaEstimate: {
          uploads: 0,
          permissionUpdates: assetIds.length * grantPermissions.ids.length,
        },
      };
    return { started: true, ...(await spoofer.runAssetAction({ assetIds, grantPermissions })) };
  },

  async get_permissions(args) {
    const { assetIds } = z
      .object({ assetIds: z.array(idSchema).min(1).max(1000) })
      .strict()
      .parse(args);
    const target = spoofer.getActiveTarget();
    return invoke('get_asset_permissions', {
      assetIds: [...new Set(assetIds)],
      cookie: target.cookie || null,
      apiKey: target.apiKey || null,
    });
  },

  async lookup_ids(args) {
    const { ids } = z
      .object({ ids: z.array(z.string().min(1)).min(1).max(1000) })
      .strict()
      .parse(args);
    const history = await invoke<Array<{ assetResults?: SpooferAssetResult[] }>>('get_jobs');
    const results = [
      ...spoofer.jobSnapshot().assets,
      ...history.flatMap((job) => job.assetResults ?? []),
    ];
    const wanted = new Set(ids);
    const byId = new Map<string, SpooferAssetResult>();
    for (const asset of results) {
      for (const alias of [
        asset.id,
        asset.path,
        asset.newId,
        asset.assetId,
        asset.meshId,
        asset.imageId,
      ]) {
        if (alias && wanted.has(alias) && !byId.has(alias)) byId.set(alias, asset);
      }
    }
    return ids.map((id) => {
      const result = byId.get(id);
      return {
        id,
        found: Boolean(result),
        newId: result?.meshId ?? result?.imageId ?? result?.newId ?? null,
        type: result?.type ?? result?.assetType ?? null,
        moderation: result?.moderation ?? null,
      };
    });
  },

  async check_access(args) {
    const input = z
      .object({
        assetIds: z.array(idSchema).min(1).max(1000),
        universeId: idSchema.optional(),
        groupId: idSchema.optional(),
      })
      .strict()
      .refine(
        (value) => Boolean(value.universeId) !== Boolean(value.groupId),
        'Provide universeId or groupId',
      )
      .parse(args);
    const target = spoofer.getActiveTarget();
    return invoke('check_asset_access', {
      ...input,
      assetIds: [...new Set(input.assetIds)],
      universeId: input.universeId ?? null,
      groupId: input.groupId ?? null,
      cookie: target.cookie || null,
      apiKey: target.apiKey || null,
    });
  },

  async recheck_moderation(args) {
    const { assetIds } = z
      .object({ assetIds: z.array(idSchema).min(1).max(1000) })
      .strict()
      .parse(args);
    const target = spoofer.getActiveTarget();
    const updates = await invoke<
      Array<{ assetId: string; moderation: SpooferAssetResult['moderation']; checked: boolean }>
    >('recheck_asset_moderation', {
      assetIds: [...new Set(assetIds)],
      pendingAssets: spoofer.jobSnapshot().assets,
      cookie: target.cookie || null,
      apiKey: target.apiKey || null,
    });
    const checked = new Map(
      updates.filter((item) => item.checked).map((item) => [item.assetId, item]),
    );
    useSpooferStore.setState((state) => ({
      lastAssetResults: state.lastAssetResults.map((result) => {
        const update = [result.id, result.newId, result.assetId, result.meshId, result.imageId]
          .map((id) => (id ? checked.get(id) : undefined))
          .find(Boolean);
        return update?.moderation ? { ...result, moderation: update.moderation } : result;
      }),
    }));
    return updates;
  },

  async apply_mesh_to_studio(args) {
    const input = z
      .object({
        meshId: idSchema,
        instancePath: z.string().min(1).max(4096),
        meshPartName: z.string().min(1).max(100).optional(),
        studioSessionId: z.string().optional(),
        preserveSize: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    await studioStatus();
    selectStudioSession(input.studioSessionId);
    return invoke('apply_mesh_to_studio', {
      meshId: input.meshId,
      instancePath: input.instancePath,
      meshPartName: input.meshPartName ?? null,
      sessionId: input.studioSessionId ?? useStudioSessionsStore.getState().selectedSessionId,
      preserveSize: input.preserveSize ?? true,
    });
  },

  async retry_failed(args) {
    const { jobId } = z.object({ jobId: z.string().uuid() }).strict().parse(args);
    const snapshot = spoofer.jobSnapshot();
    if (snapshot.running) throw new Error('A job is still running');
    const history = await invoke<Array<Record<string, unknown>>>('get_jobs');
    const job = history.find((item) => item.id === jobId);
    if (!job) throw new Error('Job not found in local history');
    const results = (job.assetResults ?? []) as import('../types/tauriEvents').SpooferAssetResult[];
    const failed = results.filter(
      (result) =>
        (!result.success && !result.skipped && !result.cancelled) ||
        result.permission?.status === 'failed',
    );
    if (!failed.length)
      return { started: false, assets: 0, message: 'No failed assets or permissions' };
    const config = (job.config ?? {}) as Record<string, unknown>;
    const account = job.account as { id?: string } | undefined;
    const groupId = typeof config.groupId === 'string' ? config.groupId : null;
    const grant = config.grantPermissions
      ? grantPermissionsSchema.parse(config.grantPermissions)
      : undefined;
    const permissionFailures = failed.filter(
      (r) => r.permission?.status === 'failed' && (r.meshId ?? r.imageId ?? r.newId),
    );
    const permissionIds = permissionFailures
      .map((r) => r.meshId ?? r.imageId ?? r.newId!)
      .filter(Boolean);
    const uploadFailures = failed.filter((r) => !permissionFailures.includes(r));
    if (config.kind === 'publish') {
      const files = (config.publishFiles ?? []) as NonNullable<spoofer.AssetActionOptions['files']>;
      return {
        started: true,
        ...(await spoofer.runAssetAction({
          files: files.filter((file) => uploadFailures.some((result) => result.id === file.path)),
          ...(config.normalizeCenter === true ? { normalizeCenter: true } : {}),
          assetIds: permissionIds,
          profile: account?.id,
          groupId,
          grantPermissions: grant,
        })),
      };
    }
    if (config.kind === 'permissions' || permissionFailures.length === failed.length) {
      if (!grant) throw new Error('This historical job does not contain its permission recipients');
      return {
        started: true,
        ...(await spoofer.runAssetAction({
          assetIds: failed.map((r) => r.meshId ?? r.imageId ?? r.newId ?? r.id!).filter(Boolean),
          profile: account?.id,
          groupId,
          grantPermissions: grant,
        })),
      };
    }
    useSessionStore.setState({ autoApplyOverride: false });
    const result = await spoofer.runSpoof({
      assetIds: uploadFailures
        .filter((r) => !r.success)
        .map((r) => r.id!)
        .filter(Boolean),
      permissionAssetIds: permissionIds,
      assetTypes: Object.fromEntries(
        uploadFailures.map((r) => [r.id, r.type ?? r.assetType ?? 'animation']),
      ),
      profile: account?.id,
      groupId,
      grantPermissions: grant,
      enableArchiveRecovery: true,
      ignoreQuota: false,
    });
    if (!result.ok) throw new Error(result.message);
    return { started: true, jobId: spoofer.jobSnapshot().jobId, assets: result.count };
  },

  async get_job(args) {
    const input = z
      .object({
        jobId: z.string().uuid().optional(),
        waitSeconds: z.number().finite().optional(),
        includeMappings: z.boolean().optional(),
        summary: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    const wait = Math.max(0, Math.min(100, input.waitSeconds ?? 0));
    const jobId = input.jobId;
    if (jobId && jobId !== spoofer.jobSnapshot().jobId) {
      const jobs = await invoke<Array<Record<string, unknown>>>('get_jobs');
      const job = jobs.find((item) => item.id === jobId);
      if (!job) throw new Error('Job not found');
      return jobResponse(historicalJob(job), input);
    }
    const requestedJobId = jobId ?? spoofer.jobSnapshot().jobId;
    if (wait > 0) await spoofer.waitForJob(wait * 1000, requestedJobId);
    const snapshot = spoofer.jobSnapshot();
    if (requestedJobId && snapshot.jobId !== requestedJobId) {
      const jobs = await invoke<Array<Record<string, unknown>>>('get_jobs');
      const job = jobs.find((item) => item.id === requestedJobId);
      if (!job) throw new Error('Job not found');
      return jobResponse(historicalJob(job), input);
    }
    return jobResponse(snapshot, input);
  },

  async cancel_job() {
    return { cancelled: await spoofer.cancelJob() };
  },

  async push_to_studio() {
    const count = await spoofer.pushToStudio();
    return {
      queued: count,
      note: 'The Studio plugin applies them within a few seconds. Remember to save the place.',
    };
  },

  async replace_ids(args) {
    const raw = args.mappings;
    if (!raw || typeof raw !== 'object')
      throw new Error('mappings must be an object oldId -> newId');
    const mappings: Record<string, string> = {};
    for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
      if (/^\d+$/.test(from) && /^\d+$/.test(String(to))) mappings[from] = String(to);
    }
    const count = await spoofer.pushToStudio(mappings);
    return { queued: count };
  },

  async list_profiles() {
    const { config, accountSecrets } = useConfigStore.getState();
    const active = config.spoofing.selectedUser;
    return config.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      active: a.id === active,
      hasCookie: Boolean(accountSecrets[a.id]?.cookie),
      hasApiKey: Boolean(accountSecrets[a.id]?.apiKey || accountSecrets[a.id]?.groupApiKey),
      groups: loadCachedGroups(a.id).map((g) => ({ id: String(g.id), name: g.name })),
    }));
  },

  async select_profile(args) {
    const wanted = str(args.profile)?.toLowerCase();
    const { config } = useConfigStore.getState();
    const account = config.accounts.find((a) => a.id === wanted || a.name.toLowerCase() === wanted);
    if (!account) throw new Error(`Profile not found: ${args.profile}`);
    const groupId =
      args.groupId === null || args.groupId === undefined ? null : String(args.groupId);
    await spoofer.activateProfile(account.id, groupId);
    if (groupId) await spoofer.fetchGroups(account.id);
    const target = spoofer.getActiveTarget();
    return { profile: target.accountName, uploadTarget: target.groupName ?? 'user account' };
  },

  async get_history(args) {
    const input = z
      .object({
        jobId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        summary: z.boolean().optional(),
      })
      .strict()
      .parse(args);
    const jobs = await invoke<Array<Record<string, unknown>>>('get_jobs');
    return jobs
      .filter((job) => !input.jobId || job.id === input.jobId)
      .slice(0, input.limit ?? 10)
      .map((job) => historyResponse(job, input.summary));
  },

  async write_spoofed_file(args) {
    const path = str(args.path);
    const mappings =
      args.mappings && typeof args.mappings === 'object'
        ? Object.fromEntries(
            Object.entries(args.mappings as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v),
            ]),
          )
        : undefined;
    return spoofer.writeSpoofedFile({ path, outputPath: str(args.outputPath), mappings });
  },
};
