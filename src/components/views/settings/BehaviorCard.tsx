import { invoke } from '@tauri-apps/api/core';
import { GraduationCap, Laptop } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { logIsm } from '../../../utils/robloxProfiles';
import { Button } from '../../ui/button';
import { SettingCard, SettingRow, SettingSwitchRow } from './SettingComponents';

/** Event the TutorialGate listens to (re-opens the welcome guide). */
const START_TUTORIAL_EVENT = 'ism-start-tutorial';

export default function BehaviorCard() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();

  const handleNotifications = async (enabled: boolean) => {
    updateConfig('general', 'desktopNotifications', enabled);
    if (!enabled) {
      logIsm('info', t('prefs.behavior.notificationsOff'));
      return;
    }
    try {
      const shown = await invoke<boolean>('show_notification', {
        options: { title: 'TrapSpoofer', body: t('prefs.behavior.notificationsOn') },
      });
      logIsm(
        shown ? 'success' : 'warn',
        shown ? t('prefs.behavior.notificationsOn') : t('prefs.behavior.notificationsFailed'),
      );
    } catch {
      logIsm('warn', t('prefs.behavior.notificationsFailed'));
    }
  };

  const handleShowTutorial = () => {
    updateConfig('ui', 'tutorialCompleted', false);
    window.dispatchEvent(new Event(START_TUTORIAL_EVENT));
  };

  return (
    <SettingCard
      icon={Laptop}
      title={t('prefs.behavior.title')}
      description={t('prefs.behavior.desc')}
    >
      <SettingSwitchRow
        label={t('prefs.behavior.notifications')}
        description={t('prefs.behavior.notificationsDesc')}
        checked={config.general.desktopNotifications}
        onCheckedChange={(v) => void handleNotifications(v)}
      />
      <SettingSwitchRow
        label={t('prefs.behavior.tray')}
        description={t('prefs.behavior.trayDesc')}
        checked={config.general.hideToTrayOnClose}
        onCheckedChange={(v) => updateConfig('general', 'hideToTrayOnClose', v)}
      />
      <SettingSwitchRow
        label={t('prefs.behavior.telemetry')}
        description={t('prefs.behavior.telemetryDesc')}
        checked={config.general.telemetryEnabled}
        onCheckedChange={(v) => updateConfig('general', 'telemetryEnabled', v)}
      />
      <SettingRow
        label={t('prefs.behavior.tutorial')}
        description={t('prefs.behavior.tutorialDesc')}
      >
        <Button variant="outline" onClick={handleShowTutorial}>
          <GraduationCap />
          {t('prefs.behavior.tutorialButton')}
        </Button>
      </SettingRow>
    </SettingCard>
  );
}
