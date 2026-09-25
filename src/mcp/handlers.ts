/**
 * MCP tool implementations. The Rust server (src-tauri/src/mcp) owns the tool
 * catalogue and relays every call here through the `mcp://request` event.
 */
import { invoke } from '@tauri-apps/api/core';

import {
  countByType,
  PUBLIC_NAME_OF,
  PUBLIC_TYPE_NAMES,
  type SpoofAssetType,
} from '../services/assets';
import * as spoofer from '../services/spoofer';
import { useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { loadCachedGroups } from '../utils/robloxProfiles';

type Args = Record<string, unknown>;
export type ToolHandler = (args: Args) => Promise<unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function toTypes(value: unknown): SpoofAssetType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => PUBLIC_TYPE_NAMES[String(v)] ?? (String(v).toLowerCase() as SpoofAssetType))
    .filter((t): t is SpoofAssetType => ['animation', 'audio', 'image', 'mesh', 'video'].includes(t));
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
      Object.entries(counts).map(([type, count]) => [PUBLIC_NAME_OF[type as SpoofAssetType], count]),
    ),
  };
}

async function studioStatus() {
  try {
    const health = await invoke<{
      synced?: boolean;
      studioPlaceId?: string | null;
      studioPlaceName?: string | null;
      scanStatus?: { scanning?: boolean } | null;
    }>('get_studio_health_status');
    return {
      connected: Boolean(health.synced),
      placeId: health.studioPlaceId ?? null,
      placeName: health.studioPlaceName ?? null,
      scanning: Boolean(health.scanStatus?.scanning),
    };
  } catch {
    return { connected: false, placeId: null, placeName: null, scanning: false };
  }
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

  async scan_studio() {
    await spoofer.scanStudio();
    return scanSummary();
  },

  async scan_file(args) {
    const path = str(args.path);
    if (!path) throw new Error('path is required');
    const { info } = await spoofer.scanFile(path);
    return { ...scanSummary(), format: info.format, kind: info.kind, instances: info.instanceCount };
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

  async spoof_assets(args) {
    const { assets } = useSessionStore.getState();
    let ids = Array.isArray(args.assetIds) ? args.assetIds.map(String) : undefined;
    if (!ids) {
      const types = new Set(toTypes(args.types) ?? ['animation', 'audio']);
      ids = assets
        .filter((a) => types.has(a.type) && spoofer.ownershipOf(a.id) !== true)
        .map((a) => a.id);
    }
    useSessionStore.setState({ autoApplyOverride: args.autoPush === false ? false : null });
    const result = await spoofer.runSpoof({ assetIds: ids, ignoreQuota: false });
    if (!result.ok) throw new Error(result.message);
    return {
      started: true,
      assets: result.count,
      warnings: result.warnings,
      next: 'Call get_job with waitSeconds to follow progress.',
    };
  },

  async get_job(args) {
    const wait = Math.min(600, num(args.waitSeconds, 0));
    if (wait > 0) await spoofer.waitForJob(wait * 1000);
    return spoofer.jobSnapshot();
  },

  async cancel_job() {
    return { cancelled: await spoofer.cancelJob() };
  },

  async push_to_studio() {
    const count = await spoofer.pushToStudio();
    return { queued: count, note: 'The Studio plugin applies them within a few seconds. Remember to save the place.' };
  },

  async replace_ids(args) {
    const raw = args.mappings;
    if (!raw || typeof raw !== 'object') throw new Error('mappings must be an object oldId -> newId');
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
      hasApiKey: Boolean(accountSecrets[a.id]?.apiKey),
      groups: loadCachedGroups(a.id).map((g) => ({ id: String(g.id), name: g.name })),
    }));
  },

  async select_profile(args) {
    const wanted = str(args.profile)?.toLowerCase();
    const { config } = useConfigStore.getState();
    const account = config.accounts.find(
      (a) => a.id === wanted || a.name.toLowerCase() === wanted,
    );
    if (!account) throw new Error(`Profile not found: ${args.profile}`);
    const groupId = args.groupId === null || args.groupId === undefined ? null : String(args.groupId);
    await spoofer.activateProfile(account.id, groupId);
    if (groupId) await spoofer.fetchGroups(account.id);
    const target = spoofer.getActiveTarget();
    return { profile: target.accountName, uploadTarget: target.groupName ?? 'user account' };
  },

  async get_history(args) {
    const jobs = await invoke<Array<Record<string, unknown>>>('get_jobs');
    return jobs.slice(0, Math.min(50, num(args.limit, 10)));
  },

  async write_spoofed_file(args) {
    const path = str(args.path);
    const mappings =
      args.mappings && typeof args.mappings === 'object'
        ? Object.fromEntries(
            Object.entries(args.mappings as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    return spoofer.writeSpoofedFile({ path, outputPath: str(args.outputPath), mappings });
  },
};
