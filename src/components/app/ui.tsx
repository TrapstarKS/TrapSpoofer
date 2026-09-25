/** Small presentational building blocks shared by the TrapSpoofer pages. */
import { Box, Check, Clapperboard, Copy, Film, Image as ImageIcon, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import type { SpoofAssetType } from '../../services/assets';
import { useCopy } from './hooks';

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export function PageShell({
  title,
  description,
  actions,
  children,
  className,
  width = 'default',
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  width?: 'default' | 'wide';
}) {
  return (
    <div className="h-full w-full overflow-y-auto app-glow">
      <div
        className={cn(
          'mx-auto flex flex-col gap-6 px-6 py-6 lg:px-8',
          width === 'wide' ? 'max-w-6xl' : 'max-w-5xl',
          className,
        )}
      >
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{title}</h1>
            {description && (
              <p className="max-w-2xl text-sm leading-relaxed text-text-muted">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Panel({
  children,
  className,
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div';
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        'rounded-xl border border-border-subtle bg-bg-surface/70 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset] backdrop-blur-[2px]',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function PanelHeader({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-5', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-elevated/60 text-text-secondary">
            {icon}
          </div>
        )}
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-text-primary">{title}</h2>
          {description && (
            <p className="text-[13px] leading-relaxed text-text-muted">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'idle' | 'brand';

const DOT: Record<Tone, string> = {
  ok: 'bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_18%,transparent)]',
  warn: 'bg-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_18%,transparent)]',
  error: 'bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_18%,transparent)]',
  info: 'bg-info shadow-[0_0_0_3px_color-mix(in_srgb,var(--info)_18%,transparent)]',
  brand: 'bg-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)]',
  idle: 'bg-text-muted/60',
};

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && (
        <span
          className={cn(
            'absolute inset-0 animate-ping rounded-full opacity-60',
            DOT[tone].split(' ')[0],
          )}
        />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT[tone])} />
    </span>
  );
}

const BADGE: Record<Tone, string> = {
  ok: 'text-success bg-success/10 border-success/25',
  warn: 'text-warning bg-warning/10 border-warning/25',
  error: 'text-danger bg-danger/10 border-danger/25',
  info: 'text-info bg-info/10 border-info/25',
  brand: 'text-brand bg-brand/10 border-brand/25',
  idle: 'text-text-muted bg-bg-elevated/60 border-border-subtle',
};

export function Badge({
  tone = 'idle',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap',
        BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ProgressBar({
  value,
  indeterminate,
  tone = 'brand',
  className,
}: {
  value?: number;
  indeterminate?: boolean;
  tone?: 'brand' | 'ok' | 'warn';
  className?: string;
}) {
  const fill = tone === 'ok' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : 'bg-brand';
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated', className)}
    >
      {indeterminate ? (
        <div className={cn('ts-indeterminate absolute inset-y-0 w-2/5 rounded-full', fill)} />
      ) : (
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', fill)}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('ts-skeleton rounded-md', className)} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-elevated/50 text-text-muted">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-text-muted">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border-subtle bg-bg-surface/70 px-4 py-3">
      <p className="truncate text-[12px] text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-text-primary">
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

export function CopyButton({
  text,
  label,
  className,
  size = 'sm',
}: {
  text: string;
  label?: ReactNode;
  className?: string;
  size?: 'sm' | 'xs';
}) {
  const { t } = useLanguage();
  const { copied, copy } = useCopy();
  const done = copied !== null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copy(text);
      }}
      aria-label={typeof label === 'string' ? label : t('shell.common.copy')}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        size === 'xs' ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2 text-xs',
        done && 'text-success hover:text-success',
        className,
      )}
    >
      {done ? <Check size={size === 'xs' ? 12 : 13} /> : <Copy size={size === 'xs' ? 12 : 13} />}
      {label !== undefined && <span>{done ? t('shell.common.copied') : label}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Asset types                                                         */
/* ------------------------------------------------------------------ */

export const TYPE_META: Record<
  SpoofAssetType,
  { icon: typeof Film; className: string; key: string }
> = {
  animation: {
    icon: Film,
    className: 'text-violet-500 bg-violet-500/10',
    key: 'flow.types.animation',
  },
  audio: { icon: Volume2, className: 'text-sky-500 bg-sky-500/10', key: 'flow.types.audio' },
  image: {
    icon: ImageIcon,
    className: 'text-emerald-500 bg-emerald-500/10',
    key: 'flow.types.image',
  },
  mesh: { icon: Box, className: 'text-amber-500 bg-amber-500/10', key: 'flow.types.mesh' },
  video: { icon: Clapperboard, className: 'text-rose-500 bg-rose-500/10', key: 'flow.types.video' },
};

export function TypeIcon({ type, className }: { type: SpoofAssetType; className?: string }) {
  const meta = TYPE_META[type] ?? TYPE_META.animation;
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-lg',
        meta.className,
        className,
      )}
    >
      <Icon size={14} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatRelative(date: Date | number | string, lang: string) {
  const value = new Date(date).getTime();
  if (!Number.isFinite(value)) return '';
  const diff = value - Date.now();
  const abs = Math.abs(diff);
  const locale = lang === 'pt' ? 'pt-BR' : lang;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
  return new Date(value).toLocaleDateString(locale, { day: '2-digit', month: 'short' });
}

export function formatNumber(n: number, lang: string) {
  return n.toLocaleString(lang === 'pt' ? 'pt-BR' : lang);
}
