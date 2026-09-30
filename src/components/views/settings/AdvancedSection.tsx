import { FlaskConical } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { SettingCard, SettingSwitchRow } from './SettingComponents';

export default function AdvancedSection() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();
  return (
    <SettingCard
      icon={FlaskConical}
      title={t('prefs.features.title')}
      description={t('prefs.features.desc')}
    >
      <SettingSwitchRow
        label={t('prefs.features.clipboard')}
        description={t('prefs.features.clipboardDesc')}
        checked={config.advanced.clipboardMonitoring}
        onCheckedChange={(v) => updateConfig('advanced', 'clipboardMonitoring', v)}
      />
    </SettingCard>
  );
}
