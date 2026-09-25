import { Check } from 'lucide-react';
import { useMemo } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { cn } from '../../../lib/utils';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import ApplyStep from './ApplyStep';
import { type FlowStep, useFlowStore } from './flowStore';
import ReviewStep from './ReviewStep';
import SendStep from './SendStep';
import SourceStep from './SourceStep';

const STEPS: { id: FlowStep; key: string }[] = [
  { id: 0, key: 'source' },
  { id: 1, key: 'review' },
  { id: 2, key: 'send' },
  { id: 3, key: 'apply' },
];

function useReachable(): boolean[] {
  const hasAssets = useSessionStore((s) => s.assets.length > 0);
  const isSpoofing = useSpooferStore((s) => s.isSpoofing);
  const hasResults = useSpooferStore(
    (s) => s.lastAssetResults.length > 0 || Object.keys(s.lastReplacements).length > 0,
  );
  const hasFileWrite = useSessionStore((s) => s.lastFileWrite !== null);
  return useMemo(
    () => [
      !isSpoofing,
      hasAssets && !isSpoofing,
      hasAssets || isSpoofing,
      !isSpoofing && (hasResults || hasFileWrite),
    ],
    [hasAssets, isSpoofing, hasResults, hasFileWrite],
  );
}

function Stepper({ step, reachable }: { step: FlowStep; reachable: boolean[] }) {
  const { t } = useLanguage();
  const setStep = useFlowStore((s) => s.setStep);

  return (
    <ol className="flex w-full items-center gap-1.5" aria-label={t('flow.steps.label')}>
      {STEPS.map((s, i) => {
        const active = s.id === step;
        const done = s.id < step;
        const enabled = reachable[s.id] && !active;
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              disabled={!enabled}
              aria-current={active ? 'step' : undefined}
              onClick={() => setStep(s.id)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2.5 rounded-xl border px-3 py-2 text-left outline-none transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default',
                active
                  ? 'border-brand/40 bg-brand/10'
                  : enabled
                    ? 'cursor-pointer border-border-subtle bg-bg-surface/60 hover:border-border-strong hover:bg-bg-elevated/60'
                    : 'border-transparent bg-transparent opacity-60',
              )}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold',
                  active
                    ? 'bg-brand text-brand-foreground'
                    : done
                      ? 'bg-success/15 text-success'
                      : 'bg-bg-elevated text-text-muted',
                )}
              >
                {done ? <Check size={13} strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'block truncate text-[13px] font-semibold',
                    active ? 'text-text-primary' : 'text-text-secondary',
                  )}
                >
                  {t(`flow.steps.${s.key}`)}
                </span>
                <span className="hidden truncate text-[11px] text-text-muted xl:block">
                  {t(`flow.steps.${s.key}Hint`)}
                </span>
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span className="hidden h-px w-4 shrink-0 bg-border-strong lg:block" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function SpoofPage() {
  const step = useFlowStore((s) => s.step);
  const reachable = useReachable();
  const isSpoofing = useSpooferStore((s) => s.isSpoofing);
  // While a job runs the only meaningful screen is "Enviar" (progress).
  const current: FlowStep = isSpoofing ? 2 : step;

  return (
    <div className="app-glow flex h-full w-full flex-col">
      <div className="shrink-0 border-b border-border-subtle/70 bg-bg-base/40 px-6 py-3 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <Stepper step={current} reachable={reachable} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <>
          {current === 0 && <SourceStep />}
          {current === 1 && <ReviewStep />}
          {current === 2 && <SendStep />}
          {current === 3 && <ApplyStep />}
        </>
      </div>
    </div>
  );
}
