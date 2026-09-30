import { Download } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import {
  appWorkInProgress,
  checkAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
} from '../../../services/updater';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import { useUpdaterStore } from '../../../stores/updaterStore';
import { Button } from '../../ui/button';
import { SettingCard, SettingSwitchRow } from './SettingComponents';

export default function UpdatesCard() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();
  const update = useUpdaterStore();
  useSpooferStore((state) =>
    [
      state.isPreparingJob,
      state.isSpoofing,
      state.isScanningStudio,
      state.isReplacing,
      state.isGrantingPermissions,
      state.isDiscoveringPlaceIds,
      state.parsingFileName,
    ].join(':'),
  );
  useSessionStore((state) => state.scanPhase);
  const busy = appWorkInProgress();
  const working = ['checking', 'downloading', 'installing'].includes(update.status);
  const percent =
    update.total > 0 ? Math.min(100, Math.round((update.downloaded / update.total) * 100)) : 0;
  return (
    <SettingCard
      icon={Download}
      title={t('prefs.updates.title')}
      description={t('prefs.updates.desc')}
    >
      <SettingSwitchRow
        label={t('prefs.updates.automatic')}
        description={t('prefs.updates.automaticDesc')}
        checked={config.general.autoUpdate}
        onCheckedChange={(value) => updateConfig('general', 'autoUpdate', value)}
      />
      <div className="flex flex-col gap-3 px-4 py-3">
        <p role="status" className="text-sm text-text-secondary">
          {t(`prefs.updates.${update.status}`)}
          {update.version ? ` · v${update.version}` : ''}
          {update.status === 'downloading' && update.total > 0 ? ` · ${percent}%` : ''}
        </p>
        {update.error && (
          <p role="alert" className="text-xs text-danger">
            {update.error === 'busy' ? t('prefs.updates.busy') : update.error}
          </p>
        )}
        {busy && update.status === 'ready' && (
          <p className="text-xs text-text-muted">{t('prefs.updates.busy')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={working || update.status === 'ready' || update.status === 'installed'}
            onClick={() => void checkAppUpdate(true)}
          >
            {t('prefs.updates.check')}
          </Button>
          {update.status === 'available' && (
            <Button size="sm" onClick={() => void downloadAppUpdate()}>
              {t('prefs.updates.download')}
            </Button>
          )}
          {(update.status === 'ready' || update.status === 'installed') && (
            <Button size="sm" disabled={busy} onClick={() => void installAppUpdate()}>
              {t('prefs.updates.restart')}
            </Button>
          )}
        </div>
      </div>
    </SettingCard>
  );
}
