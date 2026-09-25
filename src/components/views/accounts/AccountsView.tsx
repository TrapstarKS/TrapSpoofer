import {
  Building2,
  Cookie,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  UserPlus,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useConfigStore } from '../../../stores/configStore';
import { loadCachedUsers, normalizeId } from '../../../utils/robloxProfiles';
import { Button } from '../../ui/button';
import AddProfileDialog from './AddProfileDialog';
import {
  ADD_PROFILE_EVENT,
  legacySession,
  revalidateProfile,
  saveProfileApiKey,
  upsertProfileFromSession,
  validateCookie,
} from './profileActions';
import { ProfileAvatar } from './ProfileBits';
import ProfileCard from './ProfileCard';

function HowItWorks() {
  const { t } = useLanguage();
  const items = [
    {
      icon: <Cookie size={15} />,
      title: t('profiles.howItWorks.session'),
      body: t('profiles.howItWorks.sessionDesc'),
    },
    {
      icon: <KeyRound size={15} />,
      title: t('profiles.howItWorks.apiKey'),
      body: t('profiles.howItWorks.apiKeyDesc'),
    },
    {
      icon: <Building2 size={15} />,
      title: t('profiles.howItWorks.target'),
      body: t('profiles.howItWorks.targetDesc'),
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {items.map((item, i) => (
        <div
          key={item.title}
          className="flex gap-3 rounded-xl border border-border-subtle bg-bg-surface/40 p-3"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {item.icon}
          </span>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-text-primary">
              <span className="mr-1 text-text-muted">{i + 1}.</span>
              {item.title}
            </p>
            <p className="text-[11.5px] leading-snug text-text-secondary">{item.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function LegacySessionBanner() {
  const { t, tf } = useLanguage();
  const [saving, setSaving] = useState(false);
  // Subscribe so the banner reacts to profile/session changes.
  useConfigStore((s) => s.config);
  const legacy = legacySession();
  if (!legacy) return null;
  const cached = loadCachedUsers().find((u) => normalizeId(u.id) === normalizeId(legacy.userId));
  const name = cached?.displayName || cached?.name || legacy.userId;

  const save = async () => {
    setSaving(true);
    try {
      const result = await validateCookie(legacy.cookie);
      const id = await upsertProfileFromSession(result.user, result.cookie);
      if (legacy.apiKey) await saveProfileApiKey(id, legacy.apiKey);
      window.ismLog?.('success', tf('profiles.toast.added', { name }), true);
    } catch {
      window.ismLog?.('warn', t('profiles.dialog.invalidCookie'), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <ProfileAvatar url={cached?.avatarUrl} name={name} size={36} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-text-primary">
          {tf('profiles.legacy.title', { name })}
        </p>
        <p className="text-[12px] text-text-secondary">{t('profiles.legacy.body')}</p>
      </div>
      <Button size="sm" disabled={saving} onClick={() => void save()}>
        {saving ? <Loader2 className="animate-spin" /> : <Save />}
        {t('profiles.legacy.save')}
      </Button>
    </div>
  );
}

export default function AccountsView() {
  const { t, tf } = useLanguage();
  const accounts = useConfigStore((s) => s.config.accounts);
  const selectedUser = useConfigStore((s) => s.config.spoofing.selectedUser);
  const [dialog, setDialog] = useState<'add' | 'reconnect' | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  useEffect(() => {
    const open = () => setDialog('add');
    window.addEventListener(ADD_PROFILE_EVENT, open);
    return () => window.removeEventListener(ADD_PROFILE_EVENT, open);
  }, []);

  // Active profile first, then by name.
  const sorted = [...accounts].sort((a, b) => {
    if (a.id === selectedUser) return -1;
    if (b.id === selectedUser) return 1;
    return a.name.localeCompare(b.name);
  });

  const checkAll = async () => {
    setCheckingAll(true);
    let ok = 0;
    let bad = 0;
    try {
      for (const account of accounts) {
        if (await revalidateProfile(account.id)) ok++;
        else bad++;
      }
      window.ismLog?.('info', tf('profiles.toast.checked', { ok, bad }), true);
    } finally {
      setCheckingAll(false);
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 pb-16 lg:p-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              {t('profiles.title')}
            </h1>
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {t('profiles.subtitle')}
            </p>
          </div>
          <div className="flex gap-2">
            {accounts.length > 0 && (
              <Button variant="outline" disabled={checkingAll} onClick={() => void checkAll()}>
                <RefreshCw className={checkingAll ? 'animate-spin' : undefined} />
                {t('profiles.revalidateAll')}
              </Button>
            )}
            <Button className="font-semibold" onClick={() => setDialog('add')}>
              <Plus />
              {t('profiles.add')}
            </Button>
          </div>
        </header>

        <LegacySessionBanner />

        {accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-5 rounded-2xl border border-dashed border-border-strong bg-bg-surface/30 px-6 py-14 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <UserPlus size={26} />
            </span>
            <div className="max-w-md space-y-1.5">
              <h2 className="text-lg font-semibold text-text-primary">
                {t('profiles.empty.title')}
              </h2>
              <p className="text-[13px] leading-relaxed text-text-secondary">
                {t('profiles.empty.body')}
              </p>
            </div>
            <Button size="lg" className="h-10 px-5 font-semibold" onClick={() => setDialog('add')}>
              <Plus />
              {t('profiles.add')}
            </Button>
            <div className="mt-2 w-full max-w-3xl text-left">
              <HowItWorks />
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {sorted.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  onReconnect={() => setDialog('reconnect')}
                />
              ))}
            </div>
            <HowItWorks />
          </>
        )}
      </div>

      <AddProfileDialog
        open={dialog !== null}
        reconnect={dialog === 'reconnect'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
    </div>
  );
}
