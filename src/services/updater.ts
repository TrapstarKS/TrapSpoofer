import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

import { useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSpooferStore } from '../stores/spooferStore';
import { useStudioSessionsStore } from '../stores/studioSessionsStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { isTauriRuntime } from '../utils/tauriRuntime';

let update: Update | null = null;
let checking: Promise<void> | null = null;

export function appWorkInProgress(): boolean {
  const state = useSpooferStore.getState();
  const phase = useSessionStore.getState().scanPhase;
  return (
    state.isPreparingJob ||
    state.isSpoofing ||
    state.isScanningStudio ||
    state.isReplacing ||
    state.isGrantingPermissions ||
    state.isDiscoveringPlaceIds ||
    Boolean(state.parsingFileName) ||
    phase === 'scanning' ||
    phase === 'resolving' ||
    useStudioSessionsStore
      .getState()
      .sessions.some((session) => session.synced && session.scanStatus?.scanning === true)
  );
}

export async function downloadAppUpdate(): Promise<void> {
  if (
    !update ||
    ['downloading', 'ready', 'installing', 'installed'].includes(useUpdaterStore.getState().status)
  )
    return;
  useUpdaterStore.setState({ status: 'downloading', error: '', downloaded: 0, total: 0 });
  try {
    await update.download(
      (event) => {
        if (event.event === 'Started')
          useUpdaterStore.setState({ total: event.data.contentLength ?? 0 });
        if (event.event === 'Progress')
          useUpdaterStore.setState((state) => ({
            downloaded: state.downloaded + event.data.chunkLength,
          }));
      },
      { timeout: 300_000 },
    );
    useUpdaterStore.setState({ status: 'ready' });
  } catch (error) {
    useUpdaterStore.setState({ status: 'error', error: String(error) });
  }
}

export function checkAppUpdate(manual = false): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  if (checking) return checking;
  const state = useUpdaterStore.getState();
  if (['downloading', 'ready', 'installing', 'installed'].includes(state.status))
    return Promise.resolve();
  const automatic = useConfigStore.getState().config.general.autoUpdate;
  const interval = state.status === 'error' ? 30 * 60_000 : 6 * 60 * 60_000;
  if (
    !manual &&
    (!automatic || (state.lastCheckedAt > 0 && Date.now() - state.lastCheckedAt < interval))
  )
    return Promise.resolve();
  checking = (async () => {
    useUpdaterStore.setState({ status: 'checking', error: '', lastCheckedAt: Date.now() });
    try {
      if (update) {
        await update.close();
        update = null;
      }
      update = await check({ timeout: 15_000 });
      if (!update) {
        useUpdaterStore.setState({ status: 'idle', version: '' });
        return;
      }
      useUpdaterStore.setState({ status: 'available', version: update.version });
      if (useConfigStore.getState().config.general.autoUpdate) await downloadAppUpdate();
    } catch (error) {
      useUpdaterStore.setState({ status: 'error', error: String(error) });
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
}

export async function installAppUpdate(): Promise<void> {
  if (useUpdaterStore.getState().status === 'installed') {
    try {
      await relaunch();
    } catch (error) {
      useUpdaterStore.setState({ error: String(error) });
    }
    return;
  }
  if (!update || useUpdaterStore.getState().status !== 'ready') return;
  if (appWorkInProgress()) {
    useUpdaterStore.setState({ error: 'busy' });
    return;
  }
  useUpdaterStore.setState({ status: 'installing', error: '' });
  try {
    if (appWorkInProgress()) {
      useUpdaterStore.setState({ status: 'ready', error: 'busy' });
      return;
    }
    await update.install();
    useUpdaterStore.setState({ status: 'installed' });
    await relaunch();
  } catch (error) {
    const status = useUpdaterStore.getState().status;
    useUpdaterStore.setState({
      status: status === 'installed' ? 'installed' : 'ready',
      error: String(error),
    });
  }
}
