import type { PluginAsset, PluginAssetStore } from '../utils/pluginBridge';
import type { ParsedAssetRef, RbxInstance } from '../utils/robloxPlaceParser/types';

/** Asset types the spoofer understands (matches the backend `type` strings). */
export type SpoofAssetType = 'animation' | 'audio' | 'image' | 'mesh' | 'video';

export const ASSET_TYPES: SpoofAssetType[] = ['animation', 'audio', 'image', 'mesh', 'video'];

/** MCP / public names -> internal type. */
export const PUBLIC_TYPE_NAMES: Record<string, SpoofAssetType> = {
  Animation: 'animation',
  Sound: 'audio',
  Audio: 'audio',
  Image: 'image',
  Decal: 'image',
  Mesh: 'mesh',
  Video: 'video',
};

export const PUBLIC_NAME_OF: Record<SpoofAssetType, string> = {
  animation: 'Animation',
  audio: 'Sound',
  image: 'Image',
  mesh: 'Mesh',
  video: 'Video',
};

export interface SpoofAssetUsage {
  path: string;
  className: string;
  property: string;
}

/** One unique asset id found in the scanned source, with every place it's used. */
export interface SpoofAsset {
  id: string;
  type: SpoofAssetType;
  name: string;
  usages: SpoofAssetUsage[];
  /** Found only inside script source (require/LoadAnimation strings). */
  fromScript: boolean;
}

export interface AssetStores {
  anims?: PluginAssetStore;
  sounds?: PluginAssetStore;
  images?: PluginAssetStore;
  meshes?: PluginAssetStore;
  scriptRefs?: PluginAssetStore;
  videos?: PluginAssetStore;
}

export interface AssetOwner {
  creatorId?: string | null;
  creatorType?: string | null;
  creator?: string | null;
  name?: string | null;
}

const RESOLVED_TYPE: Record<string, SpoofAssetType | undefined> = {
  animation: 'animation',
  audio: 'audio',
  sound: 'audio',
  image: 'image',
  decal: 'image',
  mesh: 'mesh',
  video: 'video',
};

function isSpoofableId(id: string | undefined): id is string {
  if (!id) return false;
  if (!/^\d+$/.test(id)) return false;
  return Number(id) >= 10000;
}

function usageOf(asset: PluginAsset): SpoofAssetUsage {
  const path = asset.fullName || asset.script || asset.name || 'Workspace';
  return {
    path,
    className: asset.kind || '',
    property: asset.property || asset.callType || asset.sourceHint || '',
  };
}

/**
 * Collapse the per-property scan records into unique assets.
 * `scriptRefTypes` maps script-only ids to their resolved type
 * (from `resolve_script_references`); unresolved ones are dropped.
 */
export function buildAssetList(
  stores: AssetStores,
  scriptRefTypes: Record<string, string> = {},
): SpoofAsset[] {
  const byId = new Map<string, SpoofAsset>();

  const add = (asset: PluginAsset, type: SpoofAssetType, fromScript: boolean) => {
    const id = asset.assetId;
    if (!isSpoofableId(id)) return;
    const usage = usageOf(asset);
    const existing = byId.get(id);
    if (existing) {
      if (
        !existing.usages.some((u) => u.path === usage.path && u.property === usage.property) &&
        existing.usages.length < 200
      ) {
        existing.usages.push(usage);
      }
      existing.fromScript = existing.fromScript && fromScript;
      return;
    }
    const lastSegment = usage.path.split('.').filter(Boolean).pop();
    byId.set(id, {
      id,
      type,
      name: asset.name || lastSegment || `Asset ${id}`,
      usages: [usage],
      fromScript,
    });
  };

  // Real properties (SoundId, AnimationId...) decide the type; ids that only
  // appear inside script source are guesses, so they are added last.
  const typed: Array<[PluginAsset, SpoofAssetType, boolean]> = [];
  for (const a of stores.anims?.assets ?? []) typed.push([a, 'animation', false]);
  for (const a of stores.sounds?.assets ?? []) typed.push([a, 'audio', false]);
  for (const a of stores.images?.assets ?? []) typed.push([a, 'image', false]);
  for (const a of stores.meshes?.assets ?? []) typed.push([a, 'mesh', false]);
  for (const a of stores.videos?.assets ?? []) typed.push([a, 'video', false]);
  for (const a of stores.scriptRefs?.assets ?? []) {
    const resolved = a.assetId
      ? RESOLVED_TYPE[scriptRefTypes[a.assetId]?.toLowerCase()]
      : undefined;
    if (resolved) typed.push([a, resolved, true]);
  }
  const isSourceUsage = ([a]: [PluginAsset, SpoofAssetType, boolean]) =>
    usageOf(a).property === 'Source' || Boolean(a.callType);
  for (const entry of typed) if (!isSourceUsage(entry)) add(...entry);
  for (const entry of typed) if (isSourceUsage(entry)) add(...entry);

  return Array.from(byId.values()).sort(
    (a, b) =>
      ASSET_TYPES.indexOf(a.type) - ASSET_TYPES.indexOf(b.type) || a.name.localeCompare(b.name),
  );
}

export function scriptRefIds(stores: AssetStores): string[] {
  return Array.from(
    new Set(
      (stores.scriptRefs?.assets ?? [])
        .map((a) => a.assetId)
        .filter((id): id is string => isSpoofableId(id)),
    ),
  );
}

export function countByType(assets: SpoofAsset[]): Record<SpoofAssetType, number> {
  const counts: Record<SpoofAssetType, number> = {
    animation: 0,
    audio: 0,
    image: 0,
    mesh: 0,
    video: 0,
  };
  for (const asset of assets) counts[asset.type] += 1;
  return counts;
}

/** Parse ids out of free text (plain ids, rbxassetid:// or Roblox URLs). */
export function parseAssetIds(text: string): string[] {
  const ids = new Set<string>();
  const re = /(?:rbxassetid:\/\/|[?&]id=|\/(?:library|catalog|asset)\/)?(\d{5,20})/gi;
  for (const match of text.matchAll(re)) {
    if (match[1]) ids.add(match[1]);
  }
  return Array.from(ids);
}

/** Parse "old -> new", "old=new", "old,new" or "old new" lines. */
export function parseMappings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(\d{3,20})\s*(?:->|=>|=|,|:|\s)\s*(\d{3,20})/);
    if (match && match[1] !== match[2]) out[match[1]] = match[2];
  }
  return out;
}

/** Tree for the legacy Explorer view, built from the unique asset list. */
export function buildExplorerTree(assets: SpoofAsset[], rootName: string): RbxInstance {
  const nodeMap = new Map<string, RbxInstance>();
  const roots: RbxInstance[] = [];

  const getNode = (parts: string[], className?: string): RbxInstance => {
    const key = parts.join('.');
    const existing = nodeMap.get(key);
    if (existing) {
      if (className && existing.className === 'Folder') existing.className = className;
      return existing;
    }
    const node: RbxInstance = {
      referent: `session-${key}`,
      className: className || (parts.length === 1 ? parts[0] : 'Folder'),
      name: parts[parts.length - 1],
      assets: [],
      children: [],
    };
    nodeMap.set(key, node);
    if (parts.length === 1) roots.push(node);
    else getNode(parts.slice(0, -1)).children.push(node);
    return node;
  };

  for (const asset of assets) {
    for (const usage of asset.usages) {
      const parts = usage.path.split('.').filter(Boolean);
      if (parts.length === 0) continue;
      const node = getNode(parts, usage.className || undefined);
      const ref: ParsedAssetRef = {
        type: asset.type === 'video' ? 'unknown' : asset.type,
        assetId: asset.id,
        rawValue: `rbxassetid://${asset.id}`,
        className: usage.className || node.className,
        instanceName: node.name,
        propertyName: usage.property,
        path: usage.path,
      };
      if (
        !node.assets.some((a) => a.assetId === ref.assetId && a.propertyName === ref.propertyName)
      ) {
        node.assets.push(ref);
      }
    }
  }

  return {
    referent: 'studio-root',
    className: 'Place',
    name: rootName,
    assets: [],
    children: roots,
  };
}
