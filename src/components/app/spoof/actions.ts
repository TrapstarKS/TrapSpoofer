/**
 * UI-level wrappers around the spoofer service: they drive the wizard
 * (navigation + step) and turn errors into friendly toasts.
 */
import { useLanguage } from '../../../contexts/LanguageContext';
import type { SpoofAssetType } from '../../../services/assets';
import * as spoofer from '../../../services/spoofer';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import { goTo } from '../nav';
import { useFlowStore } from './flowStore';

const t = (key: string) => useLanguage.getState().t(key);
const tf = (key: string, vars: Record<string, string | number>) =>
  useLanguage.getState().tf(key, vars);

const toast = (level: 'success' | 'error' | 'info', message: string, ttl = 6000) =>
  useSpooferStore.getState().showToast(level, message, ttl);

function isBusy() {
  const phase = useSessionStore.getState().scanPhase;
  return phase === 'scanning' || phase === 'resolving';
}

/** Scan the open Studio place, then move to "Revisar". */
export async function startStudioScan(types?: SpoofAssetType[]) {
  const flow = useFlowStore.getState();
  goTo('spoof');
  flow.setSourceTab('studio');
  flow.setStep(0);
  if (isBusy()) return;
  try {
    const assets = await spoofer.scanStudio({ types });
    if (assets.length === 0) {
      toast('info', t('flow.source.scanEmpty'));
      return;
    }
    useFlowStore.getState().setStep(1);
    toast('success', tf('flow.source.scanDone', { count: assets.length }), 4000);
  } catch (error) {
    toast('error', `${t('flow.source.scanFailed')} ${errorText(error)}`);
  }
}

/** Open a .rbxl/.rbxm (dialog when no path is given), then move to "Revisar". */
export async function startFileScan(path?: string) {
  const flow = useFlowStore.getState();
  goTo('spoof');
  flow.setSourceTab('file');
  flow.setStep(0);
  if (isBusy()) return;
  try {
    const result = path ? await spoofer.scanFile(path) : await spoofer.pickAndScanFile();
    if (!result) return; // dialog cancelled
    if (result.assets.length === 0) {
      toast('info', t('flow.source.fileEmpty'));
      return;
    }
    useFlowStore.getState().setStep(1);
    toast('success', tf('flow.source.scanDone', { count: result.assets.length }), 4000);
  } catch (error) {
    toast('error', `${t('flow.source.fileFailed')} ${errorText(error)}`);
  }
}

/** Jump to the "Colar IDs" source. */
export function openPasteIds() {
  const flow = useFlowStore.getState();
  goTo('spoof');
  flow.setSourceTab('manual');
  flow.setStep(0);
}

export async function submitManualIds(text: string): Promise<number> {
  try {
    const added = await spoofer.addManualIds(text);
    if (added.length === 0) {
      toast('error', t('flow.source.noIdsFound'));
      return 0;
    }
    useFlowStore.getState().setStep(1);
    toast('success', tf('flow.source.idsAdded', { count: added.length }), 4000);
    return added.length;
  } catch (error) {
    toast('error', errorText(error));
    return 0;
  }
}

/** Start over: clears the current session (not the history or saved mappings). */
export function resetFlow() {
  useSessionStore.getState().clear();
  useSpooferStore.getState().clearAssetStatuses();
  useSpooferStore.getState().setLastAssetResults([]);
  const flow = useFlowStore.getState();
  flow.setStep(0);
  flow.setTreeView(false);
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
