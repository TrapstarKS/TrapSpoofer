import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  CircleDashed,
  Loader2,
  User2,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { cn } from '../../../lib/utils';
import { fetchGroups } from '../../../services/spoofer';
import { loadCachedGroups, normalizeId, type RobloxGroup } from '../../../utils/robloxProfiles';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

export type ChipTone = 'ok' | 'warn' | 'bad' | 'neutral';

const TONE: Record<ChipTone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20',
  warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/20',
  bad: 'bg-red-500/10 text-red-600 dark:text-red-400 ring-red-500/20',
  neutral: 'bg-bg-elevated text-text-secondary ring-border-subtle',
};

const TONE_ICON: Record<ChipTone, ReactNode> = {
  ok: <CheckCircle2 size={12} />,
  warn: <AlertTriangle size={12} />,
  bad: <XCircle size={12} />,
  neutral: <CircleDashed size={12} />,
};

export function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap',
        TONE[tone],
      )}
    >
      {TONE_ICON[tone]}
      {children}
    </span>
  );
}

export function ProfileAvatar({
  url,
  name,
  size = 40,
  className,
}: {
  url?: string;
  name?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        style={style}
        onError={() => setFailed(true)}
        className={cn(
          'rounded-full object-cover bg-bg-elevated ring-1 ring-border-subtle shrink-0',
          className,
        )}
      />
    );
  }
  const initial = name?.trim().charAt(0).toUpperCase();
  return (
    <div
      style={style}
      className={cn(
        'rounded-full bg-bg-elevated ring-1 ring-border-subtle flex items-center justify-center shrink-0 text-text-secondary font-semibold',
        className,
      )}
    >
      {initial || <User2 size={Math.round(size * 0.5)} />}
    </div>
  );
}

/** Groups for an account: cached first, then refreshed from Roblox. */
export function useProfileGroups(accountId: string | null, enabled = true) {
  const [groups, setGroups] = useState<RobloxGroup[]>(() =>
    accountId ? loadCachedGroups(accountId) : [],
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accountId || accountId === 'none' || !enabled) {
      setGroups([]);
      return;
    }
    setGroups(loadCachedGroups(accountId));
    let cancelled = false;
    setLoading(true);
    fetchGroups(accountId)
      .then((list) => {
        if (!cancelled) setGroups(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, enabled]);

  return { groups, loading };
}

/** "Enviar para": personal account or one of the manageable groups. */
export function UploadTargetSelect({
  accountId,
  value,
  onChange,
  disabled,
  className,
}: {
  accountId: string;
  value: string;
  onChange: (groupId: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useLanguage();
  const { groups, loading } = useProfileGroups(accountId);
  const current =
    value === 'none' ? null : groups.find((g) => normalizeId(g.id) === normalizeId(value));

  const renderOption = (group: RobloxGroup | null, fallbackId?: string) => (
    <span className="flex items-center gap-2 min-w-0">
      {group?.iconUrl ? (
        <img src={group.iconUrl} alt="" className="size-4 rounded-sm object-cover shrink-0" />
      ) : group || fallbackId ? (
        <Building2 size={14} className="text-text-muted shrink-0" />
      ) : (
        <User2 size={14} className="text-text-muted shrink-0" />
      )}
      <span className="truncate">
        {group ? group.name : fallbackId ? `#${fallbackId}` : t('profiles.card.personal')}
      </span>
    </span>
  );

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (typeof v !== 'string') return;
        onChange(v === 'none' ? null : v);
      }}
      disabled={disabled}
    >
      <SelectTrigger className={cn('h-8 w-full text-xs', className)}>
        <SelectValue>
          {value === 'none'
            ? renderOption(null)
            : renderOption(current ?? null, current ? undefined : value)}
        </SelectValue>
        {loading && <Loader2 size={12} className="animate-spin text-text-muted" />}
      </SelectTrigger>
      <SelectContent className="p-1">
        <SelectItem value="none" className="text-xs">
          {renderOption(null)}
        </SelectItem>
        {groups.map((g) => (
          <SelectItem key={g.id} value={String(g.id)} className="text-xs">
            {renderOption(g)}
          </SelectItem>
        ))}
        {!loading && groups.length === 0 && (
          <div className="px-2 py-1.5 text-[11px] text-text-muted">
            {t('profiles.card.noGroups')}
          </div>
        )}
        {loading && groups.length === 0 && (
          <div className="px-2 py-1.5 text-[11px] text-text-muted">
            {t('profiles.card.loadingGroups')}
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
