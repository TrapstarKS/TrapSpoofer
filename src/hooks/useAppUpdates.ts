import { useEffect } from 'react';

import { checkAppUpdate } from '../services/updater';
import { useConfigStore } from '../stores/configStore';
import { isTauriRuntime } from '../utils/tauriRuntime';

export function useAppUpdates() {
  const automatic = useConfigStore((state) => state.config.general.autoUpdate);
  useEffect(() => {
    if (!automatic || !isTauriRuntime()) return;
    const check = () => {
      void checkAppUpdate();
    };
    check();
    const timer = setInterval(check, 30 * 60_000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, [automatic]);
}
