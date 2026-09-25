import { UploadCloud } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { SettingCard, SettingSwitchRow } from '../settings/SettingComponents';

export default function UploadSection() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();

  return (
    <SettingCard
      icon={UploadCloud}
      title={t('prefs.upload.title')}
      description={t('prefs.upload.desc')}
    >
      <SettingSwitchRow
        label={t('prefs.upload.skipOwned')}
        description={t('prefs.upload.skipOwnedDesc')}
        checked={config.advanced.skipOwned}
        onCheckedChange={(value) => updateConfig('advanced', 'skipOwned', value)}
      />
      <SettingSwitchRow
        label={t('prefs.upload.preserveMetadata')}
        description={t('prefs.upload.preserveMetadataDesc')}
        checked={config.spoofing.preserveMetadata}
        onCheckedChange={(value) => updateConfig('spoofing', 'preserveMetadata', value)}
      />
      <SettingSwitchRow
        label={t('prefs.upload.archiveRecovery')}
        description={t('prefs.upload.archiveRecoveryDesc')}
        checked={config.advanced.enableArchiveRecovery}
        onCheckedChange={(value) => updateConfig('advanced', 'enableArchiveRecovery', value)}
      />
    </SettingCard>
  );
}
