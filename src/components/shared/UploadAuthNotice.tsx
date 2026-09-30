import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { appWorkInProgress } from '../../services/updater';
import { useConfigStore } from '../../stores/configStore';
import { useSpooferStore } from '../../stores/spooferStore';
import { useUpdaterStore } from '../../stores/updaterStore';
import { profileUploadAuth, uploadAuthNoticeKey } from '../../utils/uploadAuth';
import { Switch } from '../ui/switch';

export default function UploadAuthNotice({
  accountId,
  groupId = 'none',
  className,
}: {
  accountId: string;
  groupId?: string | null;
  className?: string;
}) {
  const { t } = useLanguage();
  const { config, accountSecrets, secretsLoaded, importingStudioAccounts } = useConfigStore();
  useSpooferStore((state) =>
    [state.isPreparingJob, state.isSpoofing, state.isScanningStudio, state.isReplacing].join(':'),
  );
  const updateStatus = useUpdaterStore((state) => state.status);
  const profile = config.accounts.find((account) => account.id === accountId);
  if (!profile || !secretsLoaded) return null;
  const auth = profileUploadAuth(config, accountSecrets, accountId, groupId);
  const busy =
    importingStudioAccounts ||
    appWorkInProgress() ||
    updateStatus === 'installing' ||
    updateStatus === 'installed';
  const invalidKey =
    (auth.method === 'personal_key' && profile.apiKeyValidated === false) ||
    (auth.method === 'group_key' && profile.groupApiKeyValidated === false);
  const chooseSession = (checked: boolean) => {
    if (busy || appWorkInProgress()) return;
    const store = useConfigStore.getState();
    store.updateAccountsList(
      store.config.accounts.map((account) =>
        account.id === accountId
          ? { ...account, uploadAuthMode: checked ? 'session' : 'auto' }
          : account,
      ),
    );
  };
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border border-border-subtle bg-bg-base/40 p-3 text-[12px] text-text-secondary',
        className,
      )}
    >
      <p className="font-medium text-text-primary">{t(`uploadAuth.${auth.method}`)}</p>
      <p>{t(`uploadAuth.${uploadAuthNoticeKey(auth)}`)}</p>
      {invalidKey && (
        <p role="alert" className="text-warning">
          {t('uploadAuth.invalidKey')}
        </p>
      )}
      <label className="flex cursor-pointer items-start justify-between gap-3 border-t border-border-subtle pt-2">
        <span>
          <span className="block font-medium">{t('uploadAuth.sessionOnly')}</span>
          <span className="block text-text-muted">{t('uploadAuth.sessionOnlyHelp')}</span>
        </span>
        <Switch
          checked={profile.uploadAuthMode === 'session'}
          disabled={busy}
          onCheckedChange={chooseSession}
          aria-label={t('uploadAuth.sessionOnly')}
        />
      </label>
      <p className="text-[11.5px] leading-relaxed text-text-muted">{t('uploadAuth.timing')}</p>
    </div>
  );
}
