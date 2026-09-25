import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardPaste,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  PartyPopper,
  ShieldAlert,
} from 'lucide-react';
import { useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { cn } from '../../../lib/utils';
import { activateProfile } from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { normalizeId, type RobloxUserInfo } from '../../../utils/robloxProfiles';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import {
  API_KEY_DASHBOARD_URL,
  detectStudioSession,
  openExternal,
  saveProfileApiKey,
  saveProfileGroupKey,
  upsertProfileFromSession,
  validateCookie,
} from './profileActions';
import { ProfileAvatar } from './ProfileBits';

type Step = 'session' | 'key' | 'done';
const STEPS: Step[] = ['session', 'key', 'done'];

export function StepDots({ step }: { step: Step }) {
  const { t } = useLanguage();
  const labels: Record<Step, string> = {
    session: t('profiles.dialog.stepSession'),
    key: t('profiles.dialog.stepKey'),
    done: t('profiles.dialog.stepDone'),
  };
  const index = STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={cn(
              'size-5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold ring-1',
              i < index && 'bg-primary text-primary-foreground ring-primary',
              i === index && 'bg-primary/15 text-primary ring-primary/50',
              i > index && 'bg-bg-elevated text-text-muted ring-border-subtle',
            )}
          >
            {i < index ? <Check size={11} /> : i + 1}
          </span>
          <span
            className={cn(
              'text-[11px] font-medium truncate',
              i === index ? 'text-text-primary' : 'text-text-muted',
            )}
          >
            {labels[s]}
          </span>
          {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border-subtle" />}
        </li>
      ))}
    </ol>
  );
}

export interface AddProfileFlowProps {
  /** Called after the last step. `profileId` is null when the flow was cancelled early. */
  onFinish: (profileId: string | null) => void;
  onCancel?: () => void;
  /** Hide the step indicator (the onboarding shows its own). */
  hideSteps?: boolean;
  /** Label of the final button. */
  finishLabel?: string;
}

export default function AddProfileFlow({
  onFinish,
  onCancel,
  hideSteps,
  finishLabel,
}: AddProfileFlowProps) {
  const { t, tf } = useLanguage();
  const [step, setStep] = useState<Step>('session');

  // Step 1
  const [detecting, setDetecting] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [cookie, setCookie] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [user, setUser] = useState<RobloxUserInfo | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);

  // Step 2
  const [apiKey, setApiKey] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupKey, setGroupKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  // Step 3
  const [useNow, setUseNow] = useState(() => {
    const { config } = useConfigStore.getState();
    const active = config.spoofing.selectedUser;
    return !active || active === 'none' || !config.accounts.some((a) => a.id === active);
  });
  const [finishing, setFinishing] = useState(false);

  const acceptSession = async (result: { user: RobloxUserInfo; cookie: string }) => {
    const id = await upsertProfileFromSession(result.user, result.cookie);
    setUser(result.user);
    setProfileId(id);
    const existingKey = useConfigStore.getState().accountSecrets[id]?.apiKey ?? '';
    setApiKey(existingKey);
    const existingGroupKey = useConfigStore.getState().accountSecrets[id]?.groupApiKey ?? '';
    setGroupKey(existingGroupKey);
    setGroupOpen(Boolean(existingGroupKey));
  };

  const handleStudio = async () => {
    setDetecting(true);
    setNotFound(false);
    setCookieError(null);
    try {
      const result = await detectStudioSession();
      if (!result) {
        setNotFound(true);
        return;
      }
      await acceptSession(result);
    } catch {
      setNotFound(true);
    } finally {
      setDetecting(false);
    }
  };

  const handleManual = async () => {
    setVerifying(true);
    setCookieError(null);
    try {
      const result = await validateCookie(cookie);
      await acceptSession(result);
      setCookie('');
    } catch {
      setCookieError(t('profiles.dialog.invalidCookie'));
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveKey = async () => {
    if (!profileId) return;
    setSavingKey(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      const check = await saveProfileApiKey(profileId, apiKey);
      if (check?.state === 'invalid') {
        setKeyError(t('profiles.dialog.keyInvalid'));
        return;
      }
      if (groupOpen) {
        const groupCheck = await saveProfileGroupKey(profileId, groupKey);
        if (groupCheck?.state === 'invalid') {
          setKeyError(t('profiles.dialog.keyInvalid'));
          return;
        }
      }
      let notice: string | null = null;
      if (check?.state === 'unknown') {
        notice = tf('profiles.dialog.keyUnverified', { message: check.message });
      } else if (
        check?.state === 'ok' &&
        check.ownerUserId &&
        normalizeId(check.ownerUserId) !== normalizeId(profileId)
      ) {
        notice = tf('profiles.dialog.keyOtherOwner', { owner: check.ownerUserId });
      }
      setKeySaved(true);
      setKeyNotice(notice);
      if (!notice) setStep('done');
    } finally {
      setSavingKey(false);
    }
  };

  const handleFinish = async () => {
    if (!profileId) {
      onFinish(null);
      return;
    }
    setFinishing(true);
    try {
      if (useNow) await activateProfile(profileId, null);
      const name = user?.displayName || user?.name || profileId;
      window.ismLog?.(
        'success',
        useNow ? tf('profiles.toast.activated', { name }) : tf('profiles.toast.added', { name }),
        true,
      );
    } finally {
      setFinishing(false);
      onFinish(profileId);
    }
  };

  const hasKey = Boolean(
    profileId && useConfigStore.getState().accountSecrets[profileId]?.apiKey?.trim(),
  );
  const displayName = user?.displayName || user?.name || '';

  return (
    <div className="flex flex-col gap-5">
      {!hideSteps && <StepDots step={step} />}

      {step === 'session' && (
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-text-primary">
              {t('profiles.dialog.sessionTitle')}
            </h3>
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {t('profiles.dialog.sessionBody')}
            </p>
          </div>

          {user ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
              <ProfileAvatar url={user.avatarUrl} name={displayName} size={44} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-text-muted">{t('profiles.dialog.found')}</p>
                <p className="text-sm font-semibold text-text-primary truncate">{displayName}</p>
                <p className="text-[11px] text-text-muted">@{user.name}</p>
              </div>
              <Check size={18} className="text-emerald-500" />
            </div>
          ) : (
            <>
              <Button
                size="lg"
                className="h-11 w-full text-sm font-semibold"
                onClick={() => void handleStudio()}
                disabled={detecting}
              >
                {detecting ? <Loader2 className="animate-spin" /> : <LogIn />}
                {detecting ? t('profiles.dialog.detecting') : t('profiles.dialog.useStudio')}
              </Button>

              {notFound && (
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
                  {t('profiles.dialog.notFound')}
                </p>
              )}

              <button
                type="button"
                onClick={() => setManualOpen((v) => !v)}
                className="flex items-center justify-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
              >
                <ClipboardPaste size={13} />
                {manualOpen ? t('profiles.dialog.hideManual') : t('profiles.dialog.manual')}
              </button>

              {manualOpen && (
                <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-base/50 p-3">
                  <Label className="text-xs font-semibold">
                    {t('profiles.dialog.cookieLabel')}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      value={cookie}
                      onChange={(e) => {
                        setCookie(e.target.value);
                        setCookieError(null);
                      }}
                      placeholder={t('profiles.dialog.cookiePlaceholder')}
                      className="h-9 text-xs"
                    />
                    <Button
                      variant="secondary"
                      className="h-9"
                      disabled={verifying || cookie.trim().length < 50}
                      onClick={() => void handleManual()}
                    >
                      {verifying && <Loader2 className="animate-spin" />}
                      {verifying ? t('profiles.dialog.verifying') : t('profiles.dialog.verify')}
                    </Button>
                  </div>
                  {cookieError && <p className="text-[12px] text-red-500">{cookieError}</p>}
                  <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-text-muted">
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-500" />
                    {t('profiles.dialog.safety')}
                  </p>
                </div>
              )}
            </>
          )}

          <div className="flex justify-between gap-2 pt-1">
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            ) : (
              <span />
            )}
            <Button disabled={!profileId} onClick={() => setStep('key')}>
              {t('profiles.dialog.continue')}
              <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {step === 'key' && (
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-text-primary">
              {t('profiles.dialog.keyTitle')}
            </h3>
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {t('profiles.dialog.keyBody')}
            </p>
          </div>

          <ol className="flex flex-col gap-2.5">
            {(['keyStep1', 'keyStep2', 'keyStep3'] as const).map((k, i) => (
              <li key={k} className="flex gap-3">
                <span className="mt-0.5 size-5 shrink-0 rounded-full bg-primary/15 text-primary text-[11px] font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-[12.5px] leading-relaxed text-text-secondary">
                  {t(`profiles.dialog.${k}`)}
                </span>
              </li>
            ))}
          </ol>

          <Button
            variant="outline"
            className="w-fit"
            onClick={() => void openExternal(API_KEY_DASHBOARD_URL)}
          >
            <ExternalLink />
            {t('profiles.dialog.openDashboard')}
          </Button>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold">{t('profiles.dialog.keyLabel')}</Label>
            <div className="relative">
              <KeyRound
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyError(null);
                  setKeySaved(false);
                  setKeyNotice(null);
                }}
                placeholder={t('profiles.dialog.keyPlaceholder')}
                className="h-9 pl-8 text-xs"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer w-fit">
            <Switch size="sm" checked={groupOpen} onCheckedChange={setGroupOpen} />
            {t('profiles.dialog.groupKeyToggle')}
          </label>
          {groupOpen && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold">{t('profiles.dialog.groupKeyLabel')}</Label>
              <Input
                type="password"
                autoComplete="off"
                value={groupKey}
                onChange={(e) => {
                  setGroupKey(e.target.value);
                  setKeySaved(false);
                }}
                placeholder={t('profiles.dialog.keyPlaceholder')}
                className="h-9 text-xs"
              />
              <p className="text-[11px] text-text-muted">{t('profiles.card.groupKeyHint')}</p>
            </div>
          )}

          {keyError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
              {keyError}
            </p>
          )}
          {keyNotice && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              {keyNotice}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" onClick={() => setStep('session')}>
              <ArrowLeft />
              {t('profiles.dialog.back')}
            </Button>
            <div className="flex items-center gap-2">
              {!keySaved && (
                <Button variant="ghost" className="text-text-muted" onClick={() => setStep('done')}>
                  {t('profiles.dialog.skip')}
                </Button>
              )}
              {keySaved ? (
                <Button onClick={() => setStep('done')}>
                  {t('profiles.dialog.continue')}
                  <ArrowRight />
                </Button>
              ) : (
                <Button
                  disabled={savingKey || apiKey.trim().length < 20}
                  onClick={() => void handleSaveKey()}
                >
                  {savingKey && <Loader2 className="animate-spin" />}
                  {t('profiles.dialog.verifyKey')}
                </Button>
              )}
            </div>
          </div>
          {!keySaved && (
            <p className="-mt-2 text-right text-[11px] text-text-muted">
              {t('profiles.dialog.skipHint')}
            </p>
          )}
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="relative">
            <ProfileAvatar url={user?.avatarUrl} name={displayName} size={64} />
            <span className="absolute -bottom-1 -right-1 size-6 rounded-full bg-emerald-500 text-white flex items-center justify-center ring-2 ring-popover">
              <Check size={14} />
            </span>
          </div>
          <div className="space-y-1">
            <h3 className="flex items-center justify-center gap-2 text-base font-semibold text-text-primary">
              <PartyPopper size={16} className="text-primary" />
              {t('profiles.dialog.doneTitle')}
            </h3>
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {tf('profiles.dialog.doneBody', { name: displayName })}
            </p>
            {!hasKey && (
              <p className="text-[12px] text-amber-600 dark:text-amber-400">
                {t('profiles.dialog.doneNoKey')}
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-base/50 px-3 py-2 text-[13px] text-text-primary cursor-pointer">
            <Switch checked={useNow} onCheckedChange={setUseNow} />
            {t('profiles.dialog.useNow')}
          </label>
          <Button
            size="lg"
            className="h-10 w-full font-semibold"
            disabled={finishing}
            onClick={() => void handleFinish()}
          >
            {finishing && <Loader2 className="animate-spin" />}
            {finishLabel ?? t('profiles.dialog.finish')}
          </Button>
        </div>
      )}
    </div>
  );
}
