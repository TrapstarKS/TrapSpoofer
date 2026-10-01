import { createContext, useContext, useEffect, useMemo } from 'react';

import { type AppConfig, useConfigStore } from '../stores/configStore';
import type { AssetStage } from '../stores/spooferStore';
import { applyReplacements, useSpooferStore } from '../stores/spooferStore';
import type {
  SpooferLogPayload,
  SpooferProgressPayload,
  SpooferResultPayload,
  SpooferStartedPayload,
} from '../types/tauriEvents';
import { serviceText } from '../utils/i18n/serviceText';
import {
  acceptsJobEvent,
  countJobResults,
  mergeJobResults,
  normalizeJobResults,
  stageFromResult,
  terminalStages,
  transferStage,
} from '../utils/jobProgress';
import { logIsm } from '../utils/robloxProfiles';
import { appendSpoofingLog } from '../utils/spoofingLogs';
import { isTauriRuntime } from '../utils/tauriRuntime';

export type { AppConfig };

interface ConfigContextType {
  config: AppConfig;
  updateConfig: <C extends keyof AppConfig, K extends keyof AppConfig[C]>(
    c: C,
    k: K,
    v: AppConfig[C][K],
  ) => void;
  updateCategory: <C extends keyof AppConfig>(c: C, vals: Partial<AppConfig[C]>) => void;
  resetConfig: () => void;
}

const Context = createContext<ConfigContextType | undefined>(undefined);

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const configState = useConfigStore();

  useEffect(() => {
    configState.loadSecrets();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let isMounted = true;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const {
        setIsSpoofing,
        setSpoofingLogs,
        setActiveSpooferJobId,
        setSpoofProgress,
        setLastAssetResults,
        setKeyframeWarningCount,
        incrementSpoofCompletionVersion,
        setSpoofStatusText,
        setSpoofCurrentCount,
        setSpoofTotalCount,
        setSpoofStartTime,
        setAssetStatus,
      } = useSpooferStore.getState();

      const accepts = (jobId?: string) => {
        const state = useSpooferStore.getState();
        return acceptsJobEvent(state.activeSpooferJobId, state.isSpoofing, jobId);
      };

      const p1 = listen<SpooferStartedPayload>('spoofer-started', (e) => {
        const jobId = e.payload.job_id ?? e.payload.jobId;
        const state = useSpooferStore.getState();
        if (state.activeSpooferJobId && state.activeSpooferJobId !== jobId) return;
        if (!state.activeSpooferJobId) {
          useSpooferStore.setState({
            assetMetadataMap: {},
            assetStatuses: {},
            lastAssetResults: [],
            jobTarget: null,
            lastJobTarget: null,
            spoofTotalCount: 0,
            isJobPaused: false,
          });
        }
        setIsSpoofing(true);
        setSpoofProgress(0);
        setSpoofStatusText('Initializing...');
        setSpoofCurrentCount(0);
        setSpoofStartTime(Date.now());
        setActiveSpooferJobId(e.payload.job_id ?? e.payload.jobId);
      });

      const p2 = listen<SpooferLogPayload>('spoofer-log', (e) => {
        if (e.payload.jobId && !accepts(e.payload.jobId)) return;
        let msg = e.payload.message ?? '';
        const rawLevel = (e.payload.level || 'info').toUpperCase();

        if (!msg.startsWith('[')) {
          msg = `[${rawLevel}] ${msg}`;
        }

        setSpoofingLogs((prev) => appendSpoofingLog(prev, msg));
      });

      const p3 = listen<SpooferProgressPayload>('spoofer-progress', (e) => {
        if (!accepts(e.payload.jobId)) return;
        if (e.payload.message) {
          setSpoofStatusText(e.payload.message);
        }

        if (e.payload.current !== undefined) {
          setSpoofCurrentCount((previous) => Math.max(previous, e.payload.current ?? 0));
        }

        if (e.payload.total !== undefined) {
          setSpoofTotalCount(e.payload.total);
        }

        if (e.payload.progress !== undefined) {
          setSpoofProgress(e.payload.progress);
        } else if (
          e.payload.current !== undefined &&
          e.payload.total !== undefined &&
          e.payload.total > 0
        ) {
          setSpoofProgress(
            Math.min(100, (useSpooferStore.getState().spoofCurrentCount / e.payload.total) * 100),
          );
        }
      });

      const p4 = listen<SpooferResultPayload>('spoofer-result', (e) => {
        if (!accepts(e.payload.jobId)) return;
        const state = useSpooferStore.getState();
        const target = state.jobTarget;
        const startTime = state.spoofStartTime;
        const batchResults = normalizeJobResults(
          e.payload.assetResults ?? e.payload.results ?? [],
          state.assetMetadataMap,
          e.payload.error || e.payload.output || 'Job stopped before this asset finished',
          e.payload.cancelled,
        );
        const results = mergeJobResults(target?.previousResults ?? [], batchResults);
        setIsSpoofing(false);
        setActiveSpooferJobId(null);
        setSpoofStartTime(null);
        setLastAssetResults(results);
        setKeyframeWarningCount(e.payload.keyframe_warnings ?? 0);
        incrementSpoofCompletionVersion();
        useSpooferStore.setState({
          isJobPaused: false,
          jobTarget: null,
          lastJobTarget: target?.studioSessionId
            ? {
                studioSessionId: target.studioSessionId,
                animationMode: target.animationMode,
              }
            : null,
          lastJobSource: target?.source ?? null,
        });
        for (const result of batchResults) {
          if (!result.id) continue;
          setAssetStatus(result.id, {
            stage: stageFromResult(result),
            message: result.errorReason || result.reason,
          });
        }
        const counts = countJobResults(batchResults);
        const { total, completed: ok, skipped, errors: failed, cancelled } = counts;
        setSpoofCurrentCount(total);
        setSpoofTotalCount(total);
        setSpoofProgress(total ? 100 : 0);
        const durationMs = startTime ? Date.now() - startTime : 0;
        const durationSec = (durationMs / 1000).toFixed(2);
        const avgMsPerAsset = Math.round(durationMs / Math.max(1, total));
        let level: 'success' | 'error' | 'info';
        let message: string;
        if (e.payload.error) {
          level = 'error';
          message = `Spoofing job stopped: ${e.payload.error}`;
        } else {
          level =
            failed > 0 && ok === 0 ? 'error' : failed > 0 || cancelled > 0 ? 'info' : 'success';
          message = `Job finished: ${ok} completed, ${skipped} skipped, ${failed} failed, ${cancelled} cancelled out of ${total} assets in ${durationSec}s (${avgMsPerAsset}ms/asset).`;
        }
        useSpooferStore.getState().showToast(level, message, 6000);
        logIsm(
          level === 'error' ? 'error' : level === 'success' ? 'success' : 'info',
          message,
          false,
        );

        if (e.payload.error) {
          setSpoofingLogs((prev) => appendSpoofingLog(prev, `[ERROR] ${e.payload.error}`));
        } else {
          setSpoofingLogs((prev) => appendSpoofingLog(prev, `[SUCCESS] ${message}`));

          if (e.payload.replacements !== undefined) {
            const newBatchReplacements: Record<string, string> = e.payload.replacements ?? {};
            const existingMappings = useSpooferStore.getState().lastReplacements;
            const mergedReplacements: Record<string, string> = {
              ...existingMappings,
              ...newBatchReplacements,
            };

            useSpooferStore.getState().setLastReplacements(mergedReplacements);

            const toApply = newBatchReplacements;
            const autoApply = target?.autoApply ?? false;
            if (target?.source?.kind === 'file') {
              setSpoofingLogs((prev) =>
                appendSpoofingLog(prev, `[INFO] ${serviceText('fileModeHint')}`),
              );
            } else if (autoApply && target?.studioSessionId && Object.keys(toApply).length > 0) {
              void applyReplacements(
                toApply,
                true,
                target?.studioSessionId ?? undefined,
                target?.animationMode,
              ).catch((error) => {
                useSpooferStore.getState().showToast('error', String(error), 6000);
              });
            }
          }

          const permissionsConfig = target?.permissions;
          if (permissionsConfig?.enabled && permissionsConfig.subjectIds?.trim()) {
            const rawIds: unknown[] = [];
            if (e.payload.replacements) {
              rawIds.push(...Object.values(e.payload.replacements));
            }
            if (e.payload.assetResults) {
              for (const r of e.payload.assetResults as any[]) {
                const newId = r.newId || r.new_asset_id || r.newAssetId;
                if (newId) {
                  rawIds.push(newId);
                }
              }
            }

            const newAssetIds: number[] = [];
            for (const val of rawIds) {
              const num = Number(val);
              if (Number.isFinite(num) && num > 0 && !newAssetIds.includes(num)) {
                newAssetIds.push(num);
              }
            }

            if (newAssetIds.length > 0) {
              const subjectIds = permissionsConfig.subjectIds
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);

              if (subjectIds.length > 0) {
                const apiKey = target?.apiKey || null;
                const cookie = target?.cookie || null;

                console.log(
                  '[AssetPermissions] Auto-granting permissions for asset IDs:',
                  newAssetIds,
                  'to targets:',
                  subjectIds,
                  `(${permissionsConfig.subjectType})`,
                  'Has Cookie:',
                  Boolean(cookie),
                  'Has API Key:',
                  Boolean(apiKey),
                );

                setSpoofingLogs((prev) =>
                  appendSpoofingLog(
                    prev,
                    `[INFO] Auto-granting permissions for ${newAssetIds.length} asset(s) to ${subjectIds.length} target(s) (${permissionsConfig.subjectType})...`,
                  ),
                );

                useSpooferStore.getState().setIsGrantingPermissions(true);
                useSpooferStore.getState().setPermissionsTotalCount(newAssetIds.length);
                useSpooferStore.getState().setPermissionsCurrentCount(0);
                useSpooferStore.getState().setPermissionsStartTime(Date.now());

                import('@tauri-apps/api/core')
                  .then(({ invoke }) =>
                    invoke<{
                      success_asset_ids: number[];
                      failed_asset_ids: number[];
                      errors: string[];
                    }>('batch_grant_asset_permissions', {
                      req: {
                        asset_ids: newAssetIds,
                        subject_type: permissionsConfig.subjectType,
                        subject_ids: subjectIds,
                        action: 'Use',
                        api_key: apiKey,
                        cookie: cookie,
                      },
                    }),
                  )
                  .then((res) => {
                    console.log('[AssetPermissions] Response:', res);
                    const okCount = res.success_asset_ids.length;
                    const failCount = res.failed_asset_ids.length;
                    const logMsg =
                      failCount > 0
                        ? `Permissions auto-grant completed with warnings: ${okCount} updated, ${failCount} failed.`
                        : `Permissions auto-grant completed successfully: ${okCount} asset(s) updated.`;
                    setSpoofingLogs((prev) =>
                      appendSpoofingLog(
                        prev,
                        failCount > 0 ? `[WARN] ${logMsg}` : `[SUCCESS] ${logMsg}`,
                      ),
                    );
                    if (res.errors && res.errors.length > 0) {
                      for (const err of res.errors) {
                        console.error('[AssetPermissions] Error:', err);
                        setSpoofingLogs((prev) => appendSpoofingLog(prev, `[ERROR] ${err}`));
                      }
                    }
                    logIsm(failCount > 0 ? 'warn' : 'success', logMsg, false);
                  })
                  .catch((err) => {
                    console.error('[AssetPermissions] Fatal error granting permissions:', err);
                    const errMsg = `Could not auto-grant permissions: ${String(err)}`;
                    setSpoofingLogs((prev) => appendSpoofingLog(prev, `[ERROR] ${errMsg}`));
                    logIsm('error', errMsg, false);
                  })
                  .finally(() => {
                    useSpooferStore.getState().setIsGrantingPermissions(false);
                  });
              }
            }
          }
        }
      });

      const p5 = listen<{
        id: string;
        original_asset_id?: string;
        status?: string;
        error?: string;
      }>('transfer-update', (e) => {
        const state = useSpooferStore.getState();
        const jobId = state.activeSpooferJobId;
        if (!jobId || !state.isSpoofing) return;
        const payload = e.payload;
        const assetId = payload.original_asset_id || payload.id.split(':').at(-1) || '';
        const current = state.assetStatuses[assetId];
        if (!current || !Object.hasOwn(state.assetMetadataMap, assetId)) return;
        const stage = transferStage(current.stage, payload.id, payload.status, jobId);
        if (stage) setAssetStatus(assetId, { stage, message: payload.error || payload.status });
      });

      const p9 = listen<{ jobId: string; id: string; stage: AssetStage; message?: string }>(
        'spoofer-asset-status',
        (e) => {
          if (!accepts(e.payload.jobId)) return;
          const state = useSpooferStore.getState();
          const current = state.assetStatuses[e.payload.id];
          if (!current || terminalStages.has(current.stage)) return;
          setAssetStatus(e.payload.id, { stage: e.payload.stage, message: e.payload.message });
        },
      );

      const p10 = listen<{
        jobId: string;
        total: number;
        assets: { id: string; name?: string; type: string }[];
      }>('spoofer-queued', (e) => {
        if (!accepts(e.payload.jobId)) return;
        useSpooferStore.setState({
          spoofTotalCount: e.payload.total,
          assetMetadataMap: Object.fromEntries(
            e.payload.assets.map((asset) => [
              asset.id,
              { name: asset.name || `Asset ${asset.id}`, type: asset.type },
            ]),
          ),
          assetStatuses: Object.fromEntries(
            e.payload.assets.map((asset) => [asset.id, { stage: 'queued' }]),
          ),
        });
      });

      const p6 = listen<{
        sessionId?: string;
        operationId?: string;
        current?: number;
        total?: number;
      }>('patch-progress', (e) => {
        const state = useSpooferStore.getState();
        if (
          !state.isReplacing ||
          e.payload.sessionId !== state.replacingSessionId ||
          e.payload.operationId !== state.replacementOperationId
        )
          return;
        const { current, total } = e.payload;
        if (typeof current === 'number') {
          useSpooferStore
            .getState()
            .setReplaceCurrentCount(Math.max(state.replaceCurrentCount, current));
        }
        if (typeof total === 'number') {
          useSpooferStore.getState().setReplaceTotalCount(total);
        }
      });

      const p8 = listen<{ current?: number; total?: number; assetId?: number }>(
        'asset-permissions-progress',
        (e) => {
          const { current, total } = e.payload;
          if (typeof current === 'number') {
            useSpooferStore.getState().setPermissionsCurrentCount(current);
          }
          if (typeof total === 'number') {
            useSpooferStore.getState().setPermissionsTotalCount(total);
          }
        },
      );

      import('@tauri-apps/api/core').then(({ invoke }) => {
        const currentBatch = useConfigStore.getState().config.advanced.batchSize ?? 50;
        invoke('set_plugin_batch_size', { batchSize: currentBatch }).catch(() => {});
      });

      const uns = await Promise.all([p1, p2, p3, p4, p5, p6, p8, p9, p10]);
      if (!isMounted) {
        uns.forEach((u) => u());
      } else {
        unlisteners.push(...uns);
      }
    };

    setup();
    return () => {
      isMounted = false;
      unlisteners.forEach((u) => u());
    };
  }, []);

  const contextValue = useMemo<ConfigContextType>(
    () => ({
      config: configState.config,
      updateConfig: configState.updateConfig,
      updateCategory: configState.updateCategory,
      resetConfig: configState.resetConfig,
    }),
    [
      configState.config,
      configState.updateConfig,
      configState.updateCategory,
      configState.resetConfig,
    ],
  );

  return <Context.Provider value={contextValue}>{children}</Context.Provider>;
};

export const useConfig = () => {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider');
  return ctx;
};
