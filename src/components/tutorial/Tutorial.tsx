import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Home,
  Languages,
  Loader2,
  MonitorPlay,
  Repeat2,
  ScanSearch,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { useStudioConnectionState } from '../../contexts/StudioConnectionContext';
import { cn } from '../../lib/utils';
import { useConfigStore } from '../../stores/configStore';
import { SUPPORTED_LANGUAGES } from '../../utils/i18n';
import { Button } from '../ui/button';
import AddProfileFlow from '../views/accounts/AddProfileFlow';
import { keyStatus } from '../views/accounts/profileActions';
import { ProfileAvatar } from '../views/accounts/ProfileBits';

type StepId = 'intro' | 'profile' | 'studio' | 'done';
const STEPS: StepId[] = ['intro', 'profile', 'studio', 'done'];

export interface OnboardingWizardProps {
  /** `tab` is where to go after closing (undefined = stay). */
  onClose: (tab?: 'spoof' | 'home') => void;
}

function Numbered({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
            {i + 1}
          </span>
          <span className="text-[13px] leading-relaxed text-text-secondary">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function IntroStep({ onNext }: { onNext: () => void }) {
  const { t, lang, setLang } = useLanguage();
  const how = [
    {
      icon: <ScanSearch size={18} />,
      title: t('welcome.intro.how1Title'),
      body: t('welcome.intro.how1'),
    },
    {
      icon: <UploadCloud size={18} />,
      title: t('welcome.intro.how2Title'),
      body: t('welcome.intro.how2'),
    },
    {
      icon: <Repeat2 size={18} />,
      title: t('welcome.intro.how3Title'),
      body: t('welcome.intro.how3'),
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Sparkles size={26} />
        </span>
        <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
          {t('welcome.intro.title')}
        </h2>
        <p className="max-w-md text-[14px] leading-relaxed text-text-secondary">
          {t('welcome.intro.body')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {how.map((h, i) => (
          <div
            key={h.title}
            className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-base/50 p-3.5"
          >
            <span className="flex items-center gap-2 text-primary">
              {h.icon}
              <span className="text-[13px] font-semibold text-text-primary">
                {i + 1}. {h.title}
              </span>
            </span>
            <p className="text-[12px] leading-snug text-text-secondary">{h.body}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Languages
          size={14}
          className="mr-1 text-text-muted"
          aria-label={t('welcome.intro.language')}
        />
        {SUPPORTED_LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => setLang(l.code)}
            aria-pressed={lang === l.code}
            className={cn(
              'rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors',
              lang === l.code
                ? 'bg-primary text-primary-foreground'
                : 'bg-bg-elevated text-text-secondary hover:text-text-primary',
            )}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col items-center gap-2">
        <Button size="lg" className="h-11 w-full max-w-xs text-sm font-semibold" onClick={onNext}>
          {t('welcome.intro.start')}
          <ArrowRight />
        </Button>
        <p className="text-[11.5px] text-text-muted">{t('welcome.intro.time')}</p>
      </div>
    </div>
  );
}

function ProfileStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t, tf } = useLanguage();
  const accounts = useConfigStore((s) => s.config.accounts);
  const selectedUser = useConfigStore((s) => s.config.spoofing.selectedUser);
  const secrets = useConfigStore((s) => s.accountSecrets);
  const active = accounts.find((a) => a.id === selectedUser);
  const [adding, setAdding] = useState(!active);

  if (active && !adding) {
    const hasKey = keyStatus(active, secrets[active.id]?.apiKey) !== 'missing';
    return (
      <div className="flex flex-col gap-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-text-primary">{t('welcome.profile.title')}</h2>
          <p className="text-[13px] text-text-secondary">{t('welcome.profile.body')}</p>
        </div>
        <div
          className={cn(
            'flex items-center gap-3 rounded-xl border p-4',
            hasKey
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : 'border-amber-500/30 bg-amber-500/5',
          )}
        >
          <ProfileAvatar url={active.avatarUrl} name={active.name} size={44} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">
              {hasKey
                ? tf('welcome.profile.ready', { name: active.name })
                : tf('welcome.profile.missingKey', { name: active.name })}
            </p>
            <p className="text-[12px] text-text-secondary">
              {hasKey ? t('welcome.profile.readyBody') : t('welcome.profile.fixLater')}
            </p>
          </div>
          {hasKey && <CheckCircle2 size={20} className="text-emerald-500" />}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft />
            {t('welcome.back')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAdding(true)}>
              {t('welcome.profile.addAnother')}
            </Button>
            <Button onClick={onNext}>
              {t('welcome.next')}
              <ArrowRight />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-text-primary">{t('welcome.profile.title')}</h2>
        <p className="text-[13px] text-text-secondary">{t('welcome.profile.body')}</p>
      </div>
      <div className="rounded-xl border border-border-subtle bg-bg-base/40 p-4">
        <AddProfileFlow
          finishLabel={t('welcome.next')}
          onCancel={active ? () => setAdding(false) : onBack}
          onFinish={(id) => {
            setAdding(false);
            if (id) onNext();
          }}
        />
      </div>
      <button
        type="button"
        onClick={onNext}
        className="self-center text-[12px] font-medium text-text-muted hover:text-text-primary"
      >
        {t('welcome.later')}
      </button>
    </div>
  );
}

function StudioStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t, tf } = useLanguage();
  const { studioConnected, studioPlaceName } = useStudioConnectionState();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <MonitorPlay size={20} />
        </span>
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-text-primary">{t('welcome.studio.title')}</h2>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            {t('welcome.studio.body')}
          </p>
        </div>
      </div>
      <Numbered
        items={[t('welcome.studio.step1'), t('welcome.studio.step2'), t('welcome.studio.step3')]}
      />
      <div
        role="status"
        className={cn(
          'flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px] font-medium',
          studioConnected
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border-subtle bg-bg-base/50 text-text-secondary',
        )}
      >
        {studioConnected ? (
          <CheckCircle2 size={16} />
        ) : (
          <Loader2 size={16} className="animate-spin text-text-muted" />
        )}
        {studioConnected
          ? studioPlaceName
            ? tf('welcome.studio.connected', { place: studioPlaceName })
            : t('welcome.studio.connectedNoPlace')
          : t('welcome.studio.waiting')}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft />
          {t('welcome.back')}
        </Button>
        <div className="flex items-center gap-3">
          {!studioConnected && (
            <span className="hidden text-[11.5px] text-text-muted sm:inline">
              {t('welcome.studio.skipHint')}
            </span>
          )}
          <Button variant={studioConnected ? 'default' : 'outline'} onClick={onNext}>
            {t('welcome.next')}
            <ArrowRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

function DoneStep({ onClose }: { onClose: (tab?: 'spoof' | 'home') => void }) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-500">
        <CheckCircle2 size={28} />
      </span>
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
          {t('welcome.done.title')}
        </h2>
        <p className="text-[14px] text-text-secondary">{t('welcome.done.body')}</p>
      </div>
      <div className="w-full max-w-md text-left">
        <Numbered
          items={[t('welcome.done.tip1'), t('welcome.done.tip2'), t('welcome.done.tip3')]}
        />
      </div>
      <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
        <Button variant="outline" size="lg" className="h-10 flex-1" onClick={() => onClose('home')}>
          <Home />
          {t('welcome.done.goHome')}
        </Button>
        <Button size="lg" className="h-10 flex-1 font-semibold" onClick={() => onClose('spoof')}>
          {t('welcome.done.goSpoof')}
          <ArrowRight />
        </Button>
      </div>
      <p className="text-[11.5px] text-text-muted">{t('welcome.done.replay')}</p>
    </div>
  );
}

/** Full-screen first-run wizard. */
export function OnboardingWizard({ onClose }: OnboardingWizardProps) {
  const { t, tf } = useLanguage();
  const [step, setStep] = useState<StepId>('intro');
  const index = STEPS.indexOf(step);
  const go = (delta: number) =>
    setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + delta))]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('welcome.intro.title')}
    >
      <div className="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-6 py-3">
          <div className="flex flex-1 items-center gap-3">
            <span className="text-[11.5px] font-medium text-text-muted">
              {tf('welcome.stepOf', { step: index + 1, total: STEPS.length })}
            </span>
            <div className="flex max-w-48 flex-1 gap-1">
              {STEPS.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'h-1 flex-1 rounded-full',
                    i <= index ? 'bg-primary' : 'bg-bg-elevated',
                  )}
                />
              ))}
            </div>
          </div>
          {step !== 'done' && (
            <button
              type="button"
              onClick={() => onClose()}
              className="flex items-center gap-1 text-[12px] font-medium text-text-muted hover:text-text-primary"
            >
              {t('welcome.skip')}
              <X size={14} />
            </button>
          )}
        </div>
        <div className="overflow-y-auto px-6 py-6 sm:px-8">
          {step === 'intro' && <IntroStep onNext={() => go(1)} />}
          {step === 'profile' && <ProfileStep onNext={() => go(1)} onBack={() => go(-1)} />}
          {step === 'studio' && <StudioStep onNext={() => go(1)} onBack={() => go(-1)} />}
          {step === 'done' && <DoneStep onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}
