import { useEffect } from 'react';

import * as spoofer from '../services/spoofer';
import { useSpooferStore } from '../stores/spooferStore';
import { logIsm } from '../utils/robloxProfiles';

/**
 * The advanced Explorer view still talks through `ism-*` DOM events. They used
 * to be handled by the hidden SpoofingView; now they go to the spoofer service.
 */
export function useLegacyExplorerBridge(onOpenPasteIds: () => void) {
  useEffect(() => {
    const report = (result: spoofer.RunResult) => {
      if (!result.ok) {
        useSpooferStore.getState().showToast('error', result.message, 6000);
      }
    };
    const onRun = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      if (detail.targetPaths) useSpooferStore.getState().setTargetPathsMap(detail.targetPaths);
      const ids: string[] | undefined =
        detail.assetIds ?? Array.from(useSpooferStore.getState().selectedAssetIds);
      void spoofer.runSpoof({ assetIds: ids }).then(report);
    };
    const onScan = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      void spoofer.scanStudio({ scanPath: detail.scanPath }).catch((err: Error) => {
        logIsm('error', err.message, true);
      });
    };
    const onDiscover = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      const ids = Array.from(useSpooferStore.getState().selectedAssetIds);
      void spoofer
        .discoverPlaceIds(ids.length ? ids : undefined, detail.timeoutSecs ?? 60)
        .then(({ searched, found }) =>
          logIsm('info', `Place IDs: ${found}/${searched} encontrados.`, true),
        )
        .catch((err: Error) => logIsm('warn', err.message, true));
    };
    const onPaste = () => onOpenPasteIds();

    document.addEventListener('ism-run-spoofer', onRun);
    document.addEventListener('ism-start-scan', onScan);
    document.addEventListener('ism-discover-place-ids', onDiscover);
    document.addEventListener('ism-open-paste-ids', onPaste);
    return () => {
      document.removeEventListener('ism-run-spoofer', onRun);
      document.removeEventListener('ism-start-scan', onScan);
      document.removeEventListener('ism-discover-place-ids', onDiscover);
      document.removeEventListener('ism-open-paste-ids', onPaste);
    };
  }, [onOpenPasteIds]);
}
