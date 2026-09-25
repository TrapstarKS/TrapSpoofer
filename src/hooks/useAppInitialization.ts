import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isRegistered, register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { useEffect, useState } from 'react';

import { useConfigStore } from '../stores/configStore';
import { isTauriRuntime } from '../utils/tauriRuntime';

export function useAppInitialization() {
  const [isRobloxApiDown, setIsRobloxApiDown] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const checkStatus = async () => {
      try {
        const isUp: boolean = await invoke('check_roblox_api_status');
        setIsRobloxApiDown(!isUp);
      } catch (e) {
        setIsRobloxApiDown(true);
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  const proxyUrl = useConfigStore((s) => s.config.advanced.proxyUrl);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke('set_proxy_url', { url: proxyUrl || null }).catch(console.warn);
  }, [proxyUrl]);

  useEffect(() => {
    const preventDrag = (e: Event) => e.preventDefault();
    window.addEventListener('dragover', preventDrag);
    window.addEventListener('drop', preventDrag);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i')) {
        invoke('open_frontend_devtools').catch(console.error);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    const shortcut = 'Alt+I';
    let isCancelled = false;
    let didRegisterShortcut = false;
    const registerShortcut = async () => {
      if (!isTauriRuntime()) return;
      try {
        if (await isRegistered(shortcut)) return;
        await register(shortcut, async (event) => {
          if (event.state === 'Pressed') {
            const win = getCurrentWindow();
            await win.show();
            await win.setFocus();
          }
        });
        didRegisterShortcut = true;
        if (isCancelled) {
          await unregister(shortcut);
          didRegisterShortcut = false;
        }
      } catch (error) {
        if (!String(error).includes('already registered')) {
          console.error(error);
        }
      }
    };

    void registerShortcut();

    return () => {
      isCancelled = true;
      window.removeEventListener('dragover', preventDrag);
      window.removeEventListener('drop', preventDrag);
      window.removeEventListener('keydown', handleKeyDown);
      if (!didRegisterShortcut) return;
      unregister(shortcut).catch((error) => {
        if (!String(error).toLowerCase().includes('not registered')) {
          console.error(error);
        }
      });
    };
  }, []);

  return { isRobloxApiDown };
}
