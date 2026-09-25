import { FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { isMemoryInjectionSupported } from '../../../utils/tauriRuntime';
import { SettingCard, SettingSwitchRow } from './SettingComponents';

export default function AdvancedSection() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();
  const [memorySupported, setMemorySupported] = useState(false);

  useEffect(() => {
    isMemoryInjectionSupported().then(setMemorySupported);
  }, []);

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
      <SettingSwitchRow
        label={t('prefs.features.memory')}
        description={
          memorySupported
            ? t('prefs.features.memoryDescSupported')
            : t('prefs.features.memoryDescUnsupported')
        }
        disabled={!memorySupported}
        checked={memorySupported ? config.advanced.memoryInjectionEnabled : false}
        onCheckedChange={(v) => {
          if (memorySupported) updateConfig('advanced', 'memoryInjectionEnabled', v);
        }}
      />
    </SettingCard>
  );
}
