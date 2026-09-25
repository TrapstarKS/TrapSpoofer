import { create } from 'zustand';

import type { AssetOwner, SpoofAsset, SpoofAssetType } from '../services/assets';

export type SessionSourceKind = 'studio' | 'file' | 'manual';

export interface SessionSource {
  kind: SessionSourceKind;
  /** Place name, file name or "IDs colados". */
  label: string;
  filePath?: string;
  placeId?: string | null;
  scannedAt: number;
}

export type ScanPhase = 'idle' | 'scanning' | 'resolving' | 'done' | 'error';

export interface FileWriteResult {
  outputPath: string;
  patchesApplied: number;
  patchesFailed: number;
  warnings: string[];
}

/** Who triggered the current action — shown in the UI when an AI agent drives the app. */
export interface McpActivity {
  id: string;
  tool: string;
  at: number;
  ok?: boolean;
  summary?: string;
}

interface SessionState {
  source: SessionSource | null;
  assets: SpoofAsset[];
  owners: Record<string, AssetOwner>;
  ownersLoading: boolean;
  selected: Set<string>;
  typeFilter: Set<SpoofAssetType>;
  scanPhase: ScanPhase;
  scanError: string | null;
  scanProgress: { scanned: number; total: number; service: string } | null;
  lastFileWrite: FileWriteResult | null;
  mcpActivity: McpActivity[];
  /** One-shot override of config.general.autoApplyResults for the next job (MCP). */
  autoApplyOverride: boolean | null;

  setSource: (source: SessionSource | null, assets: SpoofAsset[]) => void;
  addManualAssets: (assets: SpoofAsset[]) => void;
  setOwners: (owners: Record<string, AssetOwner>) => void;
  setOwnersLoading: (loading: boolean) => void;
  setSelected: (ids: Set<string>) => void;
  toggleSelected: (id: string) => void;
  toggleType: (type: SpoofAssetType) => void;
  setScanPhase: (phase: ScanPhase, error?: string | null) => void;
  setScanProgress: (progress: SessionState['scanProgress']) => void;
  setLastFileWrite: (result: FileWriteResult | null) => void;
  pushMcpActivity: (activity: McpActivity) => void;
  updateMcpActivity: (id: string, patch: Partial<McpActivity>) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  source: null,
  assets: [],
  owners: {},
  ownersLoading: false,
  selected: new Set(),
  typeFilter: new Set(['animation', 'audio', 'image', 'mesh', 'video']),
  scanPhase: 'idle',
  scanError: null,
  scanProgress: null,
  lastFileWrite: null,
  mcpActivity: [],
  autoApplyOverride: null,

  setSource: (source, assets) =>
    set({
      source,
      assets,
      owners: {},
      selected: new Set(assets.map((a) => a.id)),
      lastFileWrite: null,
    }),
  addManualAssets: (incoming) =>
    set((state) => {
      const known = new Set(state.assets.map((a) => a.id));
      const fresh = incoming.filter((a) => !known.has(a.id));
      const selected = new Set(state.selected);
      for (const a of incoming) selected.add(a.id);
      return {
        assets: [...state.assets, ...fresh],
        selected,
        source: state.source ?? {
          kind: 'manual',
          label: 'IDs',
          scannedAt: Date.now(),
        },
      };
    }),
  setOwners: (owners) => set((state) => ({ owners: { ...state.owners, ...owners } })),
  setOwnersLoading: (ownersLoading) => set({ ownersLoading }),
  setSelected: (selected) => set({ selected }),
  toggleSelected: (id) =>
    set((state) => {
      const selected = new Set(state.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { selected };
    }),
  toggleType: (type) =>
    set((state) => {
      const typeFilter = new Set(state.typeFilter);
      if (typeFilter.has(type)) typeFilter.delete(type);
      else typeFilter.add(type);
      return { typeFilter };
    }),
  setScanPhase: (scanPhase, scanError = null) => set({ scanPhase, scanError }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setLastFileWrite: (lastFileWrite) => set({ lastFileWrite }),
  pushMcpActivity: (activity) =>
    set((state) => ({ mcpActivity: [activity, ...state.mcpActivity].slice(0, 50) })),
  updateMcpActivity: (id, patch) =>
    set((state) => ({
      mcpActivity: state.mcpActivity.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
  clear: () =>
    set({
      source: null,
      assets: [],
      owners: {},
      selected: new Set(),
      scanPhase: 'idle',
      scanError: null,
      scanProgress: null,
      lastFileWrite: null,
    }),
}));

/** Owner check: does the active profile/group already own this asset? */
export function isOwnedBy(
  owner: AssetOwner | undefined,
  userId: string,
  groupId: string,
): boolean | undefined {
  if (!owner?.creatorId) return undefined;
  const type = (owner.creatorType || '').toLowerCase();
  if (groupId && groupId !== 'none' && type.includes('group')) return owner.creatorId === groupId;
  if (userId && userId !== 'none' && type.includes('user')) return owner.creatorId === userId;
  return false;
}
