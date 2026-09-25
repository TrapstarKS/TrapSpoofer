import { invoke } from '@tauri-apps/api/core';
import { Bug, FolderOpen, Trash2 } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useSpooferStore } from '../../../stores/spooferStore';
import { logIsm } from '../../../utils/robloxProfiles';
import { Button } from '../../ui/button';
import { SettingCard, SettingSwitchRow } from './SettingComponents';

/** localStorage keys that must survive a cache wipe (profiles/groups/config). */
const KEEP_KEYS = new Set(['TrapSpoofer_Config']);

export default function DebugCard() {
  const { t, tf } = useLanguage();
  const { config, updateConfig } = useConfig();

  async function clearCache(successMessage: string) {
    try {
      await Promise.all([
        invoke('clear_asset_cache'),
        invoke('clear_plugin_cache'),
        invoke('clear_app_cache'),
      ]);
      const store = useSpooferStore.getState();
      store.setLastReplacements({});
      store.clearAssetStatuses();
      store.setAssetForcePlaceIds({});
      Object.keys(localStorage).forEach((key) => {
        if (KEEP_KEYS.has(key)) return;
        if (key.startsWith('TrapSpoofer_') || key.startsWith('preview-')) {
          localStorage.removeItem(key);
        }
      });
      sessionStorage.clear();
      store.showToast('success', successMessage);
      logIsm('success', successMessage);
    } catch (err) {
      const message = tf('prefs.debug.clearFailed', { error: String(err) });
      useSpooferStore.getState().showToast('error', message);
      logIsm('error', message);
    }
  }

  const handleCacheChange = async (enabled: boolean) => {
    updateConfig('debug', 'enableCache', enabled);
    if (enabled) {
      logIsm('success', t('prefs.debug.cacheEnabled'));
      return;
    }
    await clearCache(t('prefs.debug.cacheDisabled'));
  };

  return (
    <SettingCard icon={Bug} title={t('prefs.debug.title')} description={t('prefs.debug.desc')}>
      <SettingSwitchRow
        label={t('prefs.debug.debugMode')}
        description={t('prefs.debug.debugModeDesc')}
        checked={config.debug.debugMode}
        onCheckedChange={(v) => updateConfig('debug', 'debugMode', v)}
      />
      <SettingSwitchRow
        label={t('prefs.debug.cache')}
        description={t('prefs.debug.cacheDesc')}
        checked={config.debug.enableCache}
        onCheckedChange={(v) => void handleCacheChange(v)}
      />
      <div className="flex flex-wrap gap-2 px-5 py-3.5">
        <Button variant="outline" onClick={() => void clearCache(t('prefs.debug.cacheCleared'))}>
          <Trash2 />
          {t('prefs.debug.clearCache')}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            invoke('open_logs_folder').catch((err) =>
              logIsm('error', tf('prefs.debug.logsFailed', { error: String(err) })),
            )
          }
        >
          <FolderOpen />
          {t('prefs.debug.openLogs')}
        </Button>
      </div>
    </SettingCard>
  );
}
