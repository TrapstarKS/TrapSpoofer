import { invoke } from '@tauri-apps/api/core';

async function runSplashFlow() {
  const statusText = document.getElementById('status-text');
  if (statusText) statusText.innerText = 'Synchronizing Studio plugin...';
  try {
    await invoke('sync_roblox_plugin');
  } catch (error) {
    console.error('Failed to sync Roblox plugin:', error);
  } finally {
    if (statusText) statusText.innerText = 'Starting...';
    await invoke('close_splashscreen').catch((error) =>
      console.error('Failed to close splashscreen:', error),
    );
  }
}

window.addEventListener('DOMContentLoaded', () => {
  void runSplashFlow();
});
