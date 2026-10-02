import { UploadCloud } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { SettingCard, SettingRow, SettingSwitchRow } from '../settings/SettingComponents';

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
      <SettingRow
        label={t('prefs.upload.animationMode')}
        description={t('prefs.upload.animationModeDesc')}
        htmlFor="animation-mode"
      >
        <select
          id="animation-mode"
          value={config.spoofing.animationMode}
          onChange={(event) => {
            const mode = event.target.value;
            if (
              mode === 'animation' ||
              mode === 'clip_replace' ||
              mode === 'clip_parent' ||
              mode === 'clip_parent_id'
            )
              updateConfig('spoofing', 'animationMode', mode);
          }}
          className="max-w-60 rounded-lg border border-border-subtle bg-bg-base px-2 py-2 text-[12px] text-text-primary"
        >
          <option value="animation">{t('prefs.upload.animationId')}</option>
          <option value="clip_replace">{t('prefs.upload.clipReplace')}</option>
          <option value="clip_parent">{t('prefs.upload.clipParent')}</option>
          <option value="clip_parent_id">{t('prefs.upload.clipParentId')}</option>
        </select>
      </SettingRow>
      <SettingRow
        label={t('prefs.upload.failedRecovery')}
        description={t('prefs.upload.failedRecoveryDesc')}
      />
    </SettingCard>
  );
}
