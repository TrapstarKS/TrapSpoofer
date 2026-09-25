import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { useSpooferStore } from '../../stores/spooferStore';

export const Toast = () => {
  const { t } = useLanguage();
  const toast = useSpooferStore((s) => s.toast);
  const dismiss = useSpooferStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, dismiss]);

  if (!toast) return null;

  const { level, message } = toast;
  const Icon = level === 'success' ? CheckCircle2 : level === 'error' ? XCircle : Info;
  const accent =
    level === 'success' ? 'text-success' : level === 'error' ? 'text-danger' : 'text-info';
  const bar = level === 'success' ? 'bg-success' : level === 'error' ? 'bg-danger' : 'bg-info';

  return (
    <div
      role={level === 'error' ? 'alert' : 'status'}
      aria-live={level === 'error' ? 'assertive' : 'polite'}
      className="pointer-events-auto fixed right-4 top-14 z-[100]"
    >
      <div
        key={toast.id}
        className="relative flex max-w-sm items-start gap-3 overflow-hidden rounded-xl border border-border-strong bg-bg-surface py-3 pr-3 pl-4 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.45)] animate-in fade-in slide-in-from-top-2"
      >
        <span className={cn('absolute inset-y-0 left-0 w-1', bar)} aria-hidden />
        <Icon size={17} className={cn('mt-0.5 shrink-0', accent)} />
        <p className="flex-1 text-[13px] leading-snug font-medium text-text-primary">{message}</p>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 cursor-pointer rounded-md p-0.5 text-text-muted transition-colors hover:text-text-primary"
          aria-label={t('shell.common.dismiss')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
