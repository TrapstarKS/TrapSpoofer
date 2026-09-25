import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { useSpooferStore } from '../../stores/spooferStore';
import { Button } from '../ui/button';

/** "Abrir pasta de plugins" + "Reinstalar plugin" buttons (used in Home + titlebar). */
export function PluginActions({ size = 'sm' }: { size?: 'sm' | 'default' }) {
  const { t } = useLanguage();
  const [syncing, setSyncing] = useState(false);
  const toast = useSpooferStore((s) => s.showToast);

  const openFolder = async () => {
    try {
      await invoke('open_plugins_folder');
    } catch (e) {
      toast('error', `${t('shell.studio.openFolderFailed')} ${String(e)}`);
    }
  };

  const reinstall = async () => {
    setSyncing(true);
    try {
      await invoke('sync_roblox_plugin');
      toast('success', t('shell.studio.reinstalled'));
    } catch (e) {
      toast('error', `${t('shell.studio.reinstallFailed')} ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size={size} onClick={() => void openFolder()}>
        <FolderOpen />
        {t('shell.studio.openPluginsFolder')}
      </Button>
      <Button variant="outline" size={size} onClick={() => void reinstall()} disabled={syncing}>
        {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {t('shell.studio.reinstallPlugin')}
      </Button>
    </div>
  );
}
