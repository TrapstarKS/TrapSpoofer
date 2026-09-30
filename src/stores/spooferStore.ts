import { create } from 'zustand';

import type { SpooferAssetResult } from '../types/tauriEvents';

export type AssetStage =
  | 'idle'
  | 'queued'
  | 'cancelled'
  | 'resolving_location'
  | 'discovering_usage'
  | 'discovering_graph'
  | 'downloading'
  | 'uploading'
  | 'done'
  | 'error'
  | 'skipped';
import { notifyError } from '../utils/notifyError';
import type { ParsedAssetRef, RbxInstance } from '../utils/robloxPlaceParser/types';
import { appendSpoofingLog } from '../utils/spoofingLogs';
import { performStudioReplacement } from '../utils/studioReplacementTask';
import { isTauriRuntime } from '../utils/tauriRuntime';
import type { AppConfig } from './configStore';
import { useConfigStore } from './configStore';
import type { SessionSource } from './sessionStore';
import { requireStudioSession } from './studioSessionsStore';
import { assertAppIsNotUpdating } from './updaterStore';

export interface JobTarget {
  studioSessionId: string | null;
  animationMode: 'animation' | 'clip_replace' | 'clip_parent';
  source: SessionSource | null;
  autoApply: boolean;
  userId: string;
  groupId: string;
  cookie: string;
  apiKey: string;
  permissions: AppConfig['permissions'];
}

export interface LastJobTarget {
  studioSessionId: string;
  animationMode: JobTarget['animationMode'];
}

interface SpooferState {
  replacingSessionId: string | null;
  replacementOperationId: string | null;
  jobTarget: JobTarget | null;
  lastJobTarget: LastJobTarget | null;
  lastJobSource: SessionSource | null;
  isPreparingJob: boolean;
  rootInstances: RbxInstance[];
  setRootInstances: (val: RbxInstance[] | ((prev: RbxInstance[]) => RbxInstance[])) => void;

  loadedFileName: string | null;
  setLoadedFileName: (val: string | null | ((prev: string | null) => string | null)) => void;

  loadedFilePath: string | null;
  setLoadedFilePath: (val: string | null) => void;

  parsingFileName: string | null;
  setParsingFileName: (name: string | null) => void;

  selectedAssetIds: Set<string>;
  setSelectedAssetIds: (val: Set<string> | ((prev: Set<string>) => Set<string>)) => void;

  selectedAssetKeys: Set<string>;
  setSelectedAssetKeys: (val: Set<string> | ((prev: Set<string>) => Set<string>)) => void;

  spoofingLogs: string[];
  setSpoofingLogs: (val: string[] | ((prev: string[]) => string[])) => void;

  isSpoofing: boolean;
  setIsSpoofing: (val: boolean) => void;

  spoofProgress: number;
  setSpoofProgress: (val: number) => void;

  spoofStatusText: string;
  setSpoofStatusText: (val: string) => void;

  spoofCurrentCount: number;
  setSpoofCurrentCount: (val: number | ((prev: number) => number)) => void;

  spoofTotalCount: number;
  setSpoofTotalCount: (val: number) => void;

  spoofStartTime: number | null;
  setSpoofStartTime: (val: number | null) => void;

  lastReplacements: Record<string, string>;
  setLastReplacements: (
    val: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;

  targetPathsMap: Record<string, string[]>;
  setTargetPathsMap: (
    val: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>),
  ) => void;

  isReplacing: boolean;
  setIsReplacing: (val: boolean) => void;

  replaceCurrentCount: number;
  setReplaceCurrentCount: (val: number | ((prev: number) => number)) => void;

  replaceTotalCount: number;
  setReplaceTotalCount: (val: number) => void;

  replaceStartTime: number | null;
  setReplaceStartTime: (val: number | null) => void;

  isGrantingPermissions: boolean;
  setIsGrantingPermissions: (val: boolean) => void;

  permissionsCurrentCount: number;
  setPermissionsCurrentCount: (val: number | ((prev: number) => number)) => void;

  permissionsTotalCount: number;
  setPermissionsTotalCount: (val: number) => void;

  permissionsStartTime: number | null;
  setPermissionsStartTime: (val: number | null) => void;

  replaceError: boolean;
  setReplaceError: (val: boolean) => void;

  failedReplacements: Set<string>;
  setFailedReplacements: (val: Set<string> | ((prev: Set<string>) => Set<string>)) => void;

  spoofCompletionVersion: number;
  incrementSpoofCompletionVersion: () => void;

  activeSpooferJobId: string | null;
  setActiveSpooferJobId: (id: string | null) => void;

  isJobPaused: boolean;
  setIsJobPaused: (val: boolean) => void;

  jobPauseStartTime: number | null;
  setJobPauseStartTime: (val: number | null) => void;

  lastAssetResults: SpooferAssetResult[];
  setLastAssetResults: (results: SpooferAssetResult[]) => void;

  showAdvanced: boolean;
  setShowAdvanced: (val: boolean | ((prev: boolean) => boolean)) => void;

  isScanningStudio: boolean;
  setIsScanningStudio: (val: boolean) => void;

  lastScanTime: number | null;
  setLastScanTime: (val: number | null) => void;

  keyframeWarningCount: number;
  setKeyframeWarningCount: (val: number | ((prev: number) => number)) => void;

  assetMetadataMap: Record<string, { name: string; type: string }>;
  setAssetMetadataMap: (val: Record<string, { name: string; type: string }>) => void;

  assetForcePlaceIds: Record<string, string>;
  setAssetForcePlaceIds: (
    val: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  clearAssetForcePlaceIds: (ids: string[]) => void;

  assetStatuses: Record<string, { stage: AssetStage; message?: string }>;
  setAssetStatus: (assetId: string, status: { stage: AssetStage; message?: string }) => void;
  clearAssetStatuses: () => void;

  toast: { id: number; level: 'success' | 'error' | 'info'; message: string } | null;
  showToast: (level: 'success' | 'error' | 'info', message: string, ttlMs?: number) => void;
  dismissToast: () => void;

  isDiscoveringPlaceIds: boolean;
  setIsDiscoveringPlaceIds: (val: boolean) => void;

  searchQuery: string;
  setSearchQuery: (query: string) => void;

  activeAssetFilters: string[];
  setActiveAssetFilters: (filters: string[] | ((prev: string[]) => string[])) => void;

  isInspectorOpen: boolean;
  setIsInspectorOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

  isPropertiesOpen: boolean;
  setIsPropertiesOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

  activeInspectAsset: ParsedAssetRef | null;
  setActiveInspectAsset: (asset: ParsedAssetRef | null) => void;

  forceSpoof: boolean;
  setForceSpoof: (val: boolean) => void;

  ghostAssetIds: Set<string>;
  addGhostAssets: (ids: string[]) => void;
  removeGhostAssets: (ids: string[]) => void;
  clearGhostAssets: () => void;

  discoveryTimeoutSecs: number;
  setDiscoveryTimeoutSecs: (val: number) => void;
}

const loadSavedReplacements = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem('TrapSpoofer_SavedReplacements');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const loadSavedPlaceIds = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem('TrapSpoofer_SavedPlaceIds');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const useSpooferStore = create<SpooferState>((set) => ({
  replacingSessionId: null,
  replacementOperationId: null,
  jobTarget: null,
  lastJobTarget: null,
  lastJobSource: null,
  isPreparingJob: false,
  rootInstances: [],
  setRootInstances: (val) =>
    set((state) => ({
      rootInstances: typeof val === 'function' ? val(state.rootInstances) : val,
    })),

  loadedFileName: null,
  setLoadedFileName: (val) =>
    set((state) => ({
      loadedFileName: typeof val === 'function' ? val(state.loadedFileName) : val,
    })),

  loadedFilePath: null,
  setLoadedFilePath: (val) => set({ loadedFilePath: val }),

  parsingFileName: null,
  setParsingFileName: (name) => set({ parsingFileName: name }),

  selectedAssetIds: new Set<string>(),
  setSelectedAssetIds: (val) =>
    set((state) => ({
      selectedAssetIds: typeof val === 'function' ? val(state.selectedAssetIds) : val,
    })),

  selectedAssetKeys: new Set<string>(),
  setSelectedAssetKeys: (val) =>
    set((state) => ({
      selectedAssetKeys: typeof val === 'function' ? val(state.selectedAssetKeys) : val,
    })),

  spoofingLogs: [],
  setSpoofingLogs: (val) =>
    set((state) => {
      const nextVal = typeof val === 'function' ? val(state.spoofingLogs) : val;
      if (nextVal.length > 500) {
        return { spoofingLogs: nextVal.slice(nextVal.length - 500) };
      }
      return { spoofingLogs: nextVal };
    }),

  isSpoofing: false,
  setIsSpoofing: (val) => set({ isSpoofing: val }),

  spoofProgress: 0,
  setSpoofProgress: (val) => set({ spoofProgress: val }),

  spoofStatusText: '',
  setSpoofStatusText: (val) => set({ spoofStatusText: val }),

  spoofCurrentCount: 0,
  setSpoofCurrentCount: (val) =>
    set((state) => ({
      spoofCurrentCount: typeof val === 'function' ? val(state.spoofCurrentCount) : val,
    })),

  spoofTotalCount: 0,
  setSpoofTotalCount: (val) => set({ spoofTotalCount: val }),

  spoofStartTime: null,
  setSpoofStartTime: (val) => set({ spoofStartTime: val }),

  lastReplacements: loadSavedReplacements(),
  setLastReplacements: (val) =>
    set((state) => {
      const next = typeof val === 'function' ? val(state.lastReplacements) : val;
      try {
        localStorage.setItem('TrapSpoofer_SavedReplacements', JSON.stringify(next));
      } catch {}
      return { lastReplacements: next };
    }),

  targetPathsMap: {},
  setTargetPathsMap: (val) =>
    set((state) => ({
      targetPathsMap: typeof val === 'function' ? val(state.targetPathsMap) : val,
    })),

  isReplacing: false,
  setIsReplacing: (val) => set({ isReplacing: val }),

  replaceCurrentCount: 0,
  setReplaceCurrentCount: (val) =>
    set((state) => ({
      replaceCurrentCount: typeof val === 'function' ? val(state.replaceCurrentCount) : val,
    })),

  replaceTotalCount: 0,
  setReplaceTotalCount: (val) => set({ replaceTotalCount: val }),

  replaceStartTime: null,
  setReplaceStartTime: (val) => set({ replaceStartTime: val }),

  isGrantingPermissions: false,
  setIsGrantingPermissions: (val) => set({ isGrantingPermissions: val }),

  permissionsCurrentCount: 0,
  setPermissionsCurrentCount: (val) =>
    set((state) => ({
      permissionsCurrentCount: typeof val === 'function' ? val(state.permissionsCurrentCount) : val,
    })),

  permissionsTotalCount: 0,
  setPermissionsTotalCount: (val) => set({ permissionsTotalCount: val }),

  permissionsStartTime: null,
  setPermissionsStartTime: (val) => set({ permissionsStartTime: val }),

  replaceError: false,
  setReplaceError: (val) => set({ replaceError: val }),

  failedReplacements: new Set(),
  setFailedReplacements: (val) =>
    set((state) => ({
      failedReplacements: typeof val === 'function' ? val(state.failedReplacements) : val,
    })),

  spoofCompletionVersion: 0,
  incrementSpoofCompletionVersion: () =>
    set((state) => ({
      spoofCompletionVersion: state.spoofCompletionVersion + 1,
    })),

  activeSpooferJobId: null,
  setActiveSpooferJobId: (id) => set({ activeSpooferJobId: id }),

  isJobPaused: false,
  setIsJobPaused: (val) => set({ isJobPaused: val }),

  jobPauseStartTime: null,
  setJobPauseStartTime: (val) => set({ jobPauseStartTime: val }),

  lastAssetResults: [],
  setLastAssetResults: (results) => set({ lastAssetResults: results }),

  showAdvanced: false,
  setShowAdvanced: (val) =>
    set((state) => ({
      showAdvanced: typeof val === 'function' ? val(state.showAdvanced) : val,
    })),

  isScanningStudio: false,
  setIsScanningStudio: (val) => set({ isScanningStudio: val }),

  lastScanTime: null,
  setLastScanTime: (val) => set({ lastScanTime: val }),

  keyframeWarningCount: 0,
  setKeyframeWarningCount: (val) =>
    set((state) => ({
      keyframeWarningCount: typeof val === 'function' ? val(state.keyframeWarningCount) : val,
    })),

  assetMetadataMap: {},
  setAssetMetadataMap: (val) => set({ assetMetadataMap: val }),

  assetForcePlaceIds: loadSavedPlaceIds(),
  setAssetForcePlaceIds: (val) =>
    set((state) => {
      const next = typeof val === 'function' ? val(state.assetForcePlaceIds) : val;
      try {
        localStorage.setItem('TrapSpoofer_SavedPlaceIds', JSON.stringify(next));
      } catch {}
      return { assetForcePlaceIds: next };
    }),
  clearAssetForcePlaceIds: (ids) =>
    set((state) => {
      if (ids.length === 0) return {};
      const next = { ...state.assetForcePlaceIds };
      for (const id of ids) delete next[id];
      try {
        localStorage.setItem('TrapSpoofer_SavedPlaceIds', JSON.stringify(next));
      } catch {}
      return { assetForcePlaceIds: next };
    }),

  assetStatuses: {},
  setAssetStatus: (assetId, status) =>
    set((state) => ({
      assetStatuses: { ...state.assetStatuses, [assetId]: status },
    })),
  clearAssetStatuses: () => set({ assetStatuses: {} }),

  toast: null,
  showToast: (level, message, ttlMs = 4000) => {
    const id = Date.now();
    set({ toast: { id, level, message } });
    setTimeout(() => {
      const cur = useSpooferStore.getState().toast;
      if (cur && cur.id === id) set({ toast: null });
    }, ttlMs);
  },
  dismissToast: () => set({ toast: null }),

  isDiscoveringPlaceIds: false,
  setIsDiscoveringPlaceIds: (val) => set({ isDiscoveringPlaceIds: val }),

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  activeAssetFilters: [],
  setActiveAssetFilters: (val) =>
    set((state) => ({
      activeAssetFilters: typeof val === 'function' ? val(state.activeAssetFilters) : val,
    })),

  isInspectorOpen: true,
  setIsInspectorOpen: (val) =>
    set((state) => ({
      isInspectorOpen: typeof val === 'function' ? val(state.isInspectorOpen) : val,
    })),

  isPropertiesOpen: true,
  setIsPropertiesOpen: (val) =>
    set((state) => ({
      isPropertiesOpen: typeof val === 'function' ? val(state.isPropertiesOpen) : val,
    })),

  activeInspectAsset: null,
  setActiveInspectAsset: (asset) => set({ activeInspectAsset: asset }),

  forceSpoof: false,
  setForceSpoof: (val) => set({ forceSpoof: val }),

  discoveryTimeoutSecs: 60,
  setDiscoveryTimeoutSecs: (val) => set({ discoveryTimeoutSecs: val }),

  ghostAssetIds: new Set<string>(),
  addGhostAssets: (ids: string[]) =>
    set((state) => {
      const next = new Set(state.ghostAssetIds);
      for (const id of ids) {
        if (id) next.add(id);
      }
      return { ghostAssetIds: next };
    }),
  removeGhostAssets: (ids: string[]) =>
    set((state) => {
      const next = new Set(state.ghostAssetIds);
      for (const id of ids) next.delete(id);
      return { ghostAssetIds: next };
    }),
  clearGhostAssets: () => set({ ghostAssetIds: new Set() }),
}));

export const applyReplacements = async (
  replacements: Record<string, string>,
  skipPersist = false,
  studioSessionId?: string,
  animationMode = useConfigStore.getState().config.spoofing.animationMode,
): Promise<void> => {
  assertAppIsNotUpdating();
  if (!isTauriRuntime() || !Object.keys(replacements).length) return;
  const store = useSpooferStore.getState();
  if (store.isReplacing) throw new Error('A Studio replacement is already in progress.');
  if (studioSessionId === undefined) useSpooferStore.setState({ lastJobTarget: null });
  const sessionId = requireStudioSession(studioSessionId);
  const operationId = crypto.randomUUID();
  useSpooferStore.setState({
    isReplacing: true,
    replaceError: false,
    replaceCurrentCount: 0,
    replaceTotalCount: Object.keys(replacements).length,
    replaceStartTime: Date.now(),
    replacingSessionId: sessionId,
    replacementOperationId: operationId,
  });
  try {
    if (!skipPersist) store.setLastReplacements(replacements);
    const result = await performStudioReplacement(replacements, store.targetPathsMap, {
      sessionId,
      operationId,
      animationMode,
    });
    const succeeded = result.succeeded ?? 0;
    const failed = result.failed ?? 0;
    useSpooferStore.setState({
      replaceCurrentCount: succeeded + failed,
      replaceTotalCount: result.total ?? succeeded + failed,
    });
    if (result.error || failed > 0)
      throw new Error(
        result.error ||
          `${succeeded} replacements applied; ${failed} failed. Check the plugin log before retrying.`,
      );
    store.setSpoofingLogs((previous) =>
      appendSpoofingLog(
        previous,
        `[SUCCESS] ${succeeded} replacements applied in the selected Studio window. Save the place.`,
      ),
    );
  } catch (error) {
    store.setReplaceError(true);
    notifyError('Could Not Apply Replacements', String(error));
    store.setSpoofingLogs((previous) => appendSpoofingLog(previous, `[ERROR] ${String(error)}`));
    throw error;
  } finally {
    if (useSpooferStore.getState().replacementOperationId === operationId) {
      useSpooferStore.setState({
        isReplacing: false,
        replacingSessionId: null,
        replacementOperationId: null,
      });
    }
  }
};
