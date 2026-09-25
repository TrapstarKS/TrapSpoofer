import React, { useId } from 'react';

import { cn } from '../../../lib/utils';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';

type IconLike = React.ComponentType<{ size?: number; className?: string }> | React.ReactNode;

function renderIcon(Icon: IconLike | undefined) {
  if (!Icon) return null;
  if (React.isValidElement(Icon)) return Icon;
  const Comp = Icon as React.ComponentType<{ size?: number; className?: string }>;
  return <Comp size={16} />;
}

export function SettingCard({
  icon,
  title,
  description,
  badge,
  children,
  className,
  tone = 'default',
}: {
  icon?: IconLike;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border bg-bg-surface/50',
        tone === 'danger' ? 'border-red-500/25' : 'border-border-subtle',
        className,
      )}
    >
      <header className="flex items-start gap-3 px-5 pb-3 pt-4">
        {icon && (
          <span
            className={cn(
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
              tone === 'danger' ? 'bg-red-500/10 text-red-500' : 'bg-primary/10 text-primary',
            )}
          >
            {renderIcon(icon)}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          {description && (
            <p className="text-[12.5px] leading-snug text-text-secondary">{description}</p>
          )}
        </div>
        {badge}
      </header>
      <div className="divide-y divide-border-subtle/60 border-t border-border-subtle/60">
        {children}
      </div>
    </section>
  );
}

/** Generic row: label + description on the left, control on the right. */
export function SettingRow({
  label,
  description,
  children,
  htmlFor,
  className,
}: {
  label: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-6 px-5 py-3.5', className)}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={htmlFor} className="block text-[13px] font-medium text-text-primary">
          {label}
        </Label>
        {description && (
          <p className="text-[12px] leading-snug text-text-secondary">{description}</p>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

export function SettingSwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </SettingRow>
  );
}

export function SettingFieldRow({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 px-5 py-3.5">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="block text-[13px] font-medium text-text-primary">
          {label}
        </Label>
        {description && (
          <p className="text-[12px] leading-snug text-text-secondary">{description}</p>
        )}
      </div>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn('h-9 text-[13px]', className)}
      />
    </div>
  );
}

export function SettingSliderItem({
  label,
  description,
  value,
  onChange,
  min = 1,
  max = 100,
  step = 1,
  ticks,
}: {
  label: string;
  description?: string;
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ticks?: (number | string)[];
}) {
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  return (
    <div className="flex flex-col gap-2 px-5 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="block text-[13px] font-medium text-text-primary">{label}</Label>
          {description && (
            <p className="text-[12px] leading-snug text-text-secondary">{description}</p>
          )}
        </div>
        <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-[12px] font-semibold text-primary">
          {value}
        </span>
      </div>

      <div className="relative flex w-full items-center py-1.5">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-elevated">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <div
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-base bg-primary shadow"
          style={{ left: `${pct}%` }}
        />
      </div>

      {ticks && (
        <div className="relative h-3 w-full select-none font-mono text-[10px] text-text-muted">
          {ticks.map((tick, i) => {
            const numVal = typeof tick === 'number' ? tick : parseFloat(String(tick));
            const tickPct = isNaN(numVal)
              ? (i / Math.max(1, ticks.length - 1)) * 100
              : Math.min(100, Math.max(0, ((numVal - min) / (max - min)) * 100));
            const isFirst = i === 0 || tickPct <= 2;
            const isLast = i === ticks.length - 1 || tickPct >= 98;
            return (
              <span
                key={i}
                className="pointer-events-none absolute top-0"
                style={{
                  left: `${tickPct}%`,
                  transform: isFirst ? 'none' : isLast ? 'translateX(-100%)' : 'translateX(-50%)',
                }}
              >
                {tick}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
