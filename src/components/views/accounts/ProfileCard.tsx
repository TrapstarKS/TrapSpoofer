import { Check, ChevronDown, KeyRound, Loader2, LogIn, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { cn } from '../../../lib/utils';
import { activateProfile, setUploadGroup } from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { loadCachedGroups, normalizeId } from '../../../utils/robloxProfiles';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  keyStatus,
  type Profile,
  removeProfile,
  revalidateProfile,
  saveProfileApiKey,
  saveProfileGroupKey,
  sessionStatus,
} from './profileActions';
import { type ChipTone, ProfileAvatar, StatusChip, UploadTargetSelect } from './ProfileBits';

function KeyField({
  label,
  hint,
  initial,
  onSave,
}: {
  label: string;
  hint?: string;
  initial: string;
  onSave: (value: string) => Promise<string | null>;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = value.trim() !== initial.trim();

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] font-semibold text-text-secondary">{label}</Label>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setSaved(false);
          }}
          placeholder={t('profiles.dialog.keyPlaceholder')}
          className="h-8 text-xs"
        />
        <Button
          variant="secondary"
          className="h-8"
          disabled={!dirty || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const err = await onSave(value);
              setError(err);
              setSaved(!err);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? <Loader2 className="animate-spin" /> : saved && !dirty ? <Check /> : null}
          {t('common.save')}
        </Button>
      </div>
      {error && <p className="text-[11px] text-red-500">{error}</p>}
      {hint && !error && <p className="text-[11px] text-text-muted leading-snug">{hint}</p>}
    </div>
  );
}

export default function ProfileCard({
  profile,
  onReconnect,
}: {
  profile: Profile;
  onReconnect: () => void;
}) {
  const { t, tf } = useLanguage();
  const secrets = useConfigStore((s) => s.accountSecrets[profile.id]);
  const secretsLoaded = useConfigStore((s) => s.secretsLoaded);
  const selectedUser = useConfigStore((s) => s.config.spoofing.selectedUser);
  const selectedGroup = useConfigStore((s) => s.config.spoofing.selectedGroup);
  const isActive = selectedUser === profile.id;

  const [pendingGroup, setPendingGroup] = useState<string>('none');
  const [busy, setBusy] = useState<'use' | 'check' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

  const session = sessionStatus(profile, secrets?.cookie);
  const key = keyStatus(profile, secrets?.apiKey);
  const targetValue = isActive ? selectedGroup : pendingGroup;

  const sessionChip: Record<typeof session, [ChipTone, string]> = {
    ok: ['ok', t('profiles.chip.sessionOk')],
    expired: ['bad', t('profiles.chip.sessionExpired')],
    missing: ['bad', t('profiles.chip.sessionMissing')],
    unchecked: ['neutral', t('profiles.chip.sessionUnchecked')],
  };
  const keyChip: Record<typeof key, [ChipTone, string]> = {
    ok: ['ok', t('profiles.chip.keyOk')],
    invalid: ['bad', t('profiles.chip.keyInvalid')],
    missing: ['warn', t('profiles.chip.keyMissing')],
    unchecked: ['neutral', t('profiles.chip.keyUnchecked')],
  };

  const targetName = (groupId: string | null) => {
    if (!groupId) return t('profiles.card.personal');
    const g = loadCachedGroups(profile.id).find((x) => normalizeId(x.id) === normalizeId(groupId));
    return g?.name ?? `#${groupId}`;
  };

  const handleUse = async () => {
    setBusy('use');
    try {
      await activateProfile(profile.id, pendingGroup === 'none' ? null : pendingGroup);
      window.ismLog?.('success', tf('profiles.toast.activated', { name: profile.name }), true);
    } catch (e) {
      window.ismLog?.('error', String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(null);
    }
  };

  const handleTarget = async (groupId: string | null) => {
    if (isActive) {
      await setUploadGroup(groupId);
      window.ismLog?.('info', tf('profiles.toast.targetChanged', { target: targetName(groupId) }));
    } else {
      setPendingGroup(groupId ?? 'none');
    }
  };

  const handleCheck = async () => {
    setBusy('check');
    try {
      await revalidateProfile(profile.id);
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    setBusy('remove');
    try {
      await removeProfile(profile.id);
      window.ismLog?.('info', t('profiles.toast.removed'), true);
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  const saveKey = async (value: string) => {
    const check = await saveProfileApiKey(profile.id, value);
    return check?.state === 'invalid' ? t('profiles.dialog.keyInvalid') : null;
  };
  const saveGroupKey = async (value: string) => {
    const check = await saveProfileGroupKey(profile.id, value);
    return check?.state === 'invalid' ? t('profiles.dialog.keyInvalid') : null;
  };

  const needsReconnect = secretsLoaded && (session === 'expired' || session === 'missing');

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-2xl border bg-bg-surface/60 transition-colors',
        isActive
          ? 'border-primary/50 shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_25%,transparent)]'
          : 'border-border-subtle hover:border-border-strong',
      )}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="relative">
          <ProfileAvatar
            url={profile.avatarUrl}
            name={profile.name}
            size={48}
            className={isActive ? 'ring-2 ring-primary' : undefined}
          />
          {isActive && (
            <span className="absolute -bottom-0.5 -right-0.5 size-4 rounded-full bg-primary text-primary-foreground flex items-center justify-center ring-2 ring-bg-surface">
              <Check size={10} strokeWidth={3} />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{profile.name}</h3>
            {isActive && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                {t('profiles.card.active')}
              </span>
            )}
          </div>
          <p className="text-[11px] text-text-muted">
            {tf('profiles.card.id', { id: profile.id })}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {secretsLoaded && (
              <>
                <StatusChip tone={sessionChip[session][0]}>{sessionChip[session][1]}</StatusChip>
                <StatusChip tone={keyChip[key][0]}>{keyChip[key][1]}</StatusChip>
                {secrets?.groupApiKey?.trim() && (
                  <StatusChip tone="neutral">{t('profiles.chip.groupKey')}</StatusChip>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('profiles.card.revalidate')}
            disabled={busy !== null}
            onClick={() => void handleCheck()}
          >
            <RefreshCw className={busy === 'check' ? 'animate-spin' : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('profiles.card.remove')}
            className="text-text-muted hover:text-red-500"
            disabled={busy !== null}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {confirmRemove ? (
        <div className="mx-4 mb-4 flex flex-col gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-[12px] leading-relaxed text-text-primary">
            {tf('profiles.card.removeConfirm', { name: profile.name })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy === 'remove'}
              onClick={() => void handleRemove()}
            >
              {busy === 'remove' && <Loader2 className="animate-spin" />}
              {t('profiles.card.removeYes')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 px-4">
            <Label className="text-[11px] font-semibold text-text-secondary">
              {t('profiles.card.uploadTo')}
            </Label>
            <UploadTargetSelect
              accountId={profile.id}
              value={targetValue}
              onChange={(g) => void handleTarget(g)}
            />
          </div>

          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => setKeysOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[11.5px] font-medium text-text-secondary hover:text-text-primary"
            >
              <KeyRound size={12} />
              {keysOpen ? t('profiles.card.hideKeys') : t('profiles.card.editKeys')}
              <ChevronDown
                size={12}
                className={cn('transition-transform', keysOpen && 'rotate-180')}
              />
            </button>
            {keysOpen && (
              <div className="mt-2 flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-base/50 p-3">
                <KeyField
                  label={t('profiles.dialog.keyLabel')}
                  initial={secrets?.apiKey ?? ''}
                  onSave={saveKey}
                />
                <KeyField
                  label={t('profiles.dialog.groupKeyLabel')}
                  hint={t('profiles.card.groupKeyHint')}
                  initial={secrets?.groupApiKey ?? ''}
                  onSave={saveGroupKey}
                />
              </div>
            )}
          </div>

          <div className="mt-auto flex items-center gap-2 p-4 pt-3">
            {needsReconnect && (
              <Button variant="outline" className="flex-1" onClick={onReconnect}>
                <LogIn />
                {t('profiles.card.reconnect')}
              </Button>
            )}
            {isActive ? (
              <div className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 text-[12px] font-semibold text-primary">
                <Check size={14} />
                {t('profiles.card.inUse')}
              </div>
            ) : (
              <Button
                className="flex-1 font-semibold"
                disabled={busy !== null}
                onClick={() => void handleUse()}
              >
                {busy === 'use' && <Loader2 className="animate-spin" />}
                {t('profiles.card.use')}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
