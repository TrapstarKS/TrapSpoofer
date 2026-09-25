import { AlertTriangle, Check, ChevronsUpDown, Plus, Settings2, UserCircle } from 'lucide-react';
import { useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { activateProfile, setUploadGroup } from '../../services/spoofer';
import { useConfigStore } from '../../stores/configStore';
import { loadCachedGroups, loadCachedUsers, normalizeId } from '../../utils/robloxProfiles';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import AddProfileDialog from '../views/accounts/AddProfileDialog';
import { keyStatus, sessionStatus } from '../views/accounts/profileActions';
import { ProfileAvatar, UploadTargetSelect } from '../views/accounts/ProfileBits';

export default function ProfilePopup({ collapsed = false }: { collapsed?: boolean }) {
  const { t, tf } = useLanguage();
  const accounts = useConfigStore((s) => s.config.accounts);
  const selectedUser = useConfigStore((s) => s.config.spoofing.selectedUser);
  const selectedGroup = useConfigStore((s) => s.config.spoofing.selectedGroup);
  const accountSecrets = useConfigStore((s) => s.accountSecrets);
  const secretsLoaded = useConfigStore((s) => s.secretsLoaded);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const active = accounts.find((a) => a.id === selectedUser);
  // Legacy auto-detected session that isn't a saved profile yet.
  const legacyUser =
    !active && selectedUser !== 'none'
      ? loadCachedUsers().find((u) => normalizeId(u.id) === normalizeId(selectedUser))
      : undefined;
  const name = active?.name || legacyUser?.displayName || legacyUser?.name;
  const avatarUrl = active?.avatarUrl || legacyUser?.avatarUrl;

  const needsAttention = (id: string) => {
    const profile = accounts.find((a) => a.id === id);
    if (!profile || !secretsLoaded) return false;
    const s = sessionStatus(profile, accountSecrets[id]?.cookie);
    const k = keyStatus(profile, accountSecrets[id]?.apiKey);
    return s === 'expired' || s === 'missing' || k === 'invalid' || k === 'missing';
  };

  const targetLabel = (() => {
    if (!name) return t('profiles.popup.noneHint');
    if (selectedGroup === 'none') return t('profiles.card.personal');
    const group = loadCachedGroups(selectedUser).find(
      (g) => normalizeId(g.id) === normalizeId(selectedGroup),
    );
    return group?.name ?? `#${selectedGroup}`;
  })();

  const activeWarn = active ? needsAttention(active.id) : false;

  const goToAccounts = () => {
    setOpen(false);
    updateConfig('ui', 'activeTab', 'accounts');
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={t('profiles.popup.label')}
              className={cn(
                'group flex w-full shrink-0 items-center rounded-lg transition-colors hover:bg-bg-elevated',
                collapsed
                  ? 'h-10 justify-center px-0'
                  : 'h-12 gap-2.5 border border-border-subtle bg-bg-surface/50 px-2.5',
              )}
            >
              <span className="relative shrink-0">
                {name ? (
                  <ProfileAvatar url={avatarUrl} name={name} size={collapsed ? 28 : 30} />
                ) : (
                  <UserCircle size={26} className="text-text-muted" />
                )}
                {activeWarn && (
                  <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-bg-surface" />
                )}
              </span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px] font-semibold leading-tight text-text-primary">
                      {name || t('profiles.popup.none')}
                    </span>
                    <span className="block truncate text-[10.5px] leading-tight text-text-muted">
                      {targetLabel}
                    </span>
                  </span>
                  <ChevronsUpDown size={14} className="shrink-0 text-text-muted" />
                </>
              )}
            </button>
          }
        />
        <PopoverContent
          align="start"
          side={collapsed ? 'right' : 'top'}
          sideOffset={8}
          className="w-72 gap-0 overflow-hidden p-0"
        >
          {active && (
            <div className="flex flex-col gap-2 border-b border-border-subtle p-3">
              <div className="flex items-center gap-2.5">
                <ProfileAvatar url={active.avatarUrl} name={active.name} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {t('profiles.popup.label')}
                  </p>
                  <p className="truncate text-sm font-semibold text-text-primary">{active.name}</p>
                </div>
              </div>
              {activeWarn && (
                <button
                  type="button"
                  onClick={goToAccounts}
                  className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-left text-[11.5px] font-medium text-amber-700 dark:text-amber-300"
                >
                  <AlertTriangle size={13} />
                  {t('profiles.popup.needsAttention')}
                </button>
              )}
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-text-secondary">
                  {t('profiles.popup.uploadTo')}
                </span>
                <UploadTargetSelect
                  accountId={active.id}
                  value={selectedGroup}
                  onChange={(g) => void setUploadGroup(g)}
                />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-0.5 p-1.5">
            {accounts.length > 0 && (
              <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t('profiles.popup.switchTo')}
              </p>
            )}
            {accounts.map((profile) => {
              const isActive = profile.id === selectedUser;
              const warn = needsAttention(profile.id);
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={async () => {
                    if (isActive) return;
                    await activateProfile(profile.id, null);
                    window.ismLog?.(
                      'success',
                      tf('profiles.toast.activated', { name: profile.name }),
                    );
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
                    isActive
                      ? 'bg-primary/10 text-text-primary'
                      : 'text-text-primary hover:bg-bg-elevated',
                  )}
                >
                  <ProfileAvatar url={profile.avatarUrl} name={profile.name} size={24} />
                  <span className="flex-1 truncate">{profile.name}</span>
                  {warn && <AlertTriangle size={13} className="text-amber-500" />}
                  {isActive && <Check size={14} className="text-primary" />}
                </button>
              );
            })}
            {accounts.length === 0 && (
              <p className="px-2 py-2 text-[12px] text-text-muted">
                {t('profiles.popup.noneHint')}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-0.5 border-t border-border-subtle p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setAdding(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
            >
              <Plus size={14} />
              {t('profiles.popup.add')}
            </button>
            <button
              type="button"
              onClick={goToAccounts}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
            >
              <Settings2 size={14} />
              {t('profiles.popup.manage')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <AddProfileDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
