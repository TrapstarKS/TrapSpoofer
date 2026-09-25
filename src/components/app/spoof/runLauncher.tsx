import { AlertTriangle, ArrowRight, Terminal, Volume2 } from 'lucide-react';
import { useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { type RunFailure, type RunResult, runSpoof } from '../../../services/spoofer';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { goTo, setConsoleOpen } from '../nav';
import { useFlowStore } from './flowStore';

type Failure = { reason: RunFailure; message: string };
type QuotaPrompt = { audioCount: number; remaining: number };

/** Runs a spoof and keeps the failure / quota-confirmation state for the UI. */
export function useRunLauncher() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [quota, setQuota] = useState<QuotaPrompt | null>(null);
  const [launching, setLaunching] = useState(false);

  const handle = (result: RunResult) => {
    if (result.ok) {
      setFailure(null);
      return;
    }
    if (result.reason === 'quota' && result.quota) {
      setQuota(result.quota);
      return;
    }
    setFailure({ reason: result.reason, message: result.message });
  };

  const launch = async (run: () => Promise<RunResult> = () => runSpoof()) => {
    setLaunching(true);
    setFailure(null);
    try {
      handle(await run());
    } catch (e) {
      setFailure({ reason: 'launch_failed', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLaunching(false);
    }
  };

  const confirmQuota = async () => {
    setQuota(null);
    await launch(() => runSpoof({ ignoreQuota: true }));
  };

  return {
    failure,
    launching,
    launch,
    dismissFailure: () => setFailure(null),
    quota,
    confirmQuota,
    cancelQuota: () => setQuota(null),
  };
}

export function RunFailureAlert({
  failure,
  onDismiss,
}: {
  failure: Failure;
  onDismiss: () => void;
}) {
  const { t } = useLanguage();
  const setStep = useFlowStore((s) => s.setStep);
  const toAccounts = ['no_profile', 'bad_cookie', 'no_api_key', 'bad_api_key'].includes(
    failure.reason,
  );

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.07] px-4 py-3.5"
    >
      <AlertTriangle size={17} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-semibold text-text-primary">
          {t(`flow.fail.${failure.reason}.title`)}
        </p>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {t(`flow.fail.${failure.reason}.help`)}
        </p>
        {failure.message && (
          <p className="text-[12px] leading-relaxed break-words text-text-muted">
            {t('flow.fail.detail')} {failure.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {toAccounts && (
            <Button size="sm" onClick={() => goTo('accounts')}>
              {t('flow.fail.goAccounts')}
              <ArrowRight />
            </Button>
          )}
          {failure.reason === 'no_assets' && (
            <Button size="sm" onClick={() => setStep(1)}>
              {t('flow.fail.goReview')}
            </Button>
          )}
          {failure.reason === 'launch_failed' && (
            <Button size="sm" variant="outline" onClick={() => setConsoleOpen(true)}>
              <Terminal />
              {t('flow.fail.openConsole')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('flow.common.dismiss')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function QuotaDialog({
  quota,
  onConfirm,
  onCancel,
}: {
  quota: QuotaPrompt | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Dialog open={quota !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="border border-border-subtle bg-bg-surface sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Volume2 size={17} className="text-warning" />
            {t('flow.quota.title')}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t('flow.quota.body')
              .replace('{count}', String(quota?.audioCount ?? 0))
              .replace('{remaining}', String(quota?.remaining ?? 0))}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="bg-bg-base/40">
          <Button variant="outline" onClick={onCancel}>
            {t('flow.quota.cancel')}
          </Button>
          <Button onClick={onConfirm}>{t('flow.quota.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
