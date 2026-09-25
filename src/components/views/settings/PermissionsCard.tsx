import { ShieldCheck } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { SettingCard, SettingFieldRow, SettingRow, SettingSwitchRow } from './SettingComponents';

type SubjectType = 'experience' | 'user' | 'group';

const PLACEHOLDERS: Record<SubjectType, string> = {
  experience: '1818, 924364',
  user: '12345678',
  group: '1089883489',
};

export default function PermissionsCard() {
  const { t } = useLanguage();
  const { config, updateConfig } = useConfig();
  const permissions = config.permissions;
  const subjectType = permissions.subjectType as SubjectType;
  const options: SubjectType[] = ['experience', 'group', 'user'];

  return (
    <SettingCard
      icon={ShieldCheck}
      title={t('prefs.permissions.title')}
      description={t('prefs.permissions.desc')}
    >
      <SettingSwitchRow
        label={t('prefs.permissions.enabled')}
        description={t('prefs.permissions.enabledDesc')}
        checked={permissions.enabled}
        onCheckedChange={(val) => updateConfig('permissions', 'enabled', val)}
      />
      {permissions.enabled && (
        <>
          <SettingRow
            label={t('prefs.permissions.subjectType')}
            description={t('prefs.permissions.subjectTypeDesc')}
          >
            <Select
              value={subjectType}
              onValueChange={(val) => {
                if (val === 'experience' || val === 'user' || val === 'group') {
                  updateConfig('permissions', 'subjectType', val);
                }
              }}
            >
              <SelectTrigger className="h-9 w-60 text-[13px]">
                <SelectValue>{t(`prefs.permissions.${subjectType}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent className="p-1">
                {options.map((opt) => (
                  <SelectItem key={opt} value={opt} className="text-[13px]">
                    {t(`prefs.permissions.${opt}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingFieldRow
            label={t('prefs.permissions.subjectIds')}
            description={t('prefs.permissions.subjectIdsDesc')}
            value={permissions.subjectIds}
            onChange={(val) => updateConfig('permissions', 'subjectIds', val)}
            placeholder={PLACEHOLDERS[subjectType]}
          />
        </>
      )}
    </SettingCard>
  );
}
