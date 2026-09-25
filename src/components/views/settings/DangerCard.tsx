import { RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { activateProfile } from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { Button } from '../../ui/button';
import { SettingCard, SettingRow } from './SettingComponents';

export default function DangerCard() {
  const { t } = useLanguage();
  const [confirming, setConfirming] = useState(false);

  const handleReset = async () => {
    const store = useConfigStore.getState();
    // Profiles are not preferences: keep them (and the active one) across a reset.
    const accounts = store.config.accounts;
    const { selectedUser, selectedGroup } = store.config.spoofing;
    store.resetConfig();
    const fresh = useConfigStore.getState();
    fresh.updateAccountsList(accounts);
    fresh.updateCategory('ui', { tutorialCompleted: true, activeTab: 'settings' });
    if (accounts.some((a) => a.id === selectedUser)) {
      await activateProfile(selectedUser, selectedGroup === 'none' ? null : selectedGroup);
    }
    setConfirming(false);
    window.ismLog?.('success', t('prefs.danger.done'), true);
  };

  return (
    <SettingCard
      tone="danger"
      icon={RotateCcw}
      title={t('prefs.danger.title')}
      description={t('prefs.danger.desc')}
    >
      <SettingRow
        label={t('prefs.danger.reset')}
        description={confirming ? t('prefs.danger.confirm') : t('prefs.danger.resetDesc')}
      >
        {confirming ? (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              className="bg-red-500 text-white hover:bg-red-600"
              onClick={() => void handleReset()}
            >
              {t('prefs.danger.confirmYes')}
            </Button>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            {t('prefs.danger.button')}
          </Button>
        )}
      </SettingRow>
    </SettingCard>
  );
}
