import { invoke } from '@tauri-apps/api/core';

const PLUGIN_SYNC_WAIT_MS = 8_000;

export async function runSplashFlow() {
  const statusText = document.getElementById('status-text');
  if (statusText) statusText.innerText = 'Synchronizing Studio plugin...';
  const sync = invoke('sync_roblox_plugin').catch(() => {
    console.error('Failed to sync Roblox plugin.');
  });
  let timeoutId: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = window.setTimeout(resolve, PLUGIN_SYNC_WAIT_MS);
  });
  await Promise.race([sync, timeout]);
  if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  if (statusText) statusText.innerText = 'Starting...';
  await invoke('close_splashscreen').catch(() => {
    console.error('Failed to close splashscreen.');
  });
}

window.addEventListener('DOMContentLoaded', () => {
  void runSplashFlow();
});
