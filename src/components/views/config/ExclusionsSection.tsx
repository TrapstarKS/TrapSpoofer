import { Ban } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { SettingCard, SettingFieldRow } from '../settings/SettingComponents';

export default function ExclusionsSection() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();

  return (
    <SettingCard
      icon={Ban}
      title={t('prefs.exclusions.title')}
      description={t('prefs.exclusions.desc')}
    >
      <SettingFieldRow
        label={t('prefs.exclusions.users')}
        description={t('prefs.exclusions.usersDesc')}
        value={config.advanced.excludedUserIds}
        onChange={(val) => updateConfig('advanced', 'excludedUserIds', val)}
        placeholder="12345, 67890"
      />
      <SettingFieldRow
        label={t('prefs.exclusions.groups')}
        description={t('prefs.exclusions.groupsDesc')}
        value={config.advanced.excludedGroupIds}
        onChange={(val) => updateConfig('advanced', 'excludedGroupIds', val)}
        placeholder="54321, 98765"
      />
    </SettingCard>
  );
}
