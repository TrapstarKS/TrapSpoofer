import { invoke } from '@tauri-apps/api/core';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardPaste,
  FileBox,
  History,
  KeyRound,
  Loader2,
  MonitorPlay,
  PartyPopper,
  ScanSearch,
  UserRound,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { useStudioConnectionState } from '../../contexts/StudioConnectionContext';
import { cn } from '../../lib/utils';
import { useSessionStore } from '../../stores/sessionStore';
import { useSpooferStore } from '../../stores/spooferStore';
import type { SpoofJob } from '../../utils/jobTypes';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { Button } from '../ui/button';
import { useActiveTarget } from './hooks';
import { goTo } from './nav';
import { openPasteIds, startFileScan, startStudioScan } from './spoof/actions';
import { PluginActions } from './StudioHelp';
import {
  Badge,
  EmptyState,
  formatNumber,
  formatRelative,
  PageShell,
  Panel,
  PanelHeader,
  Skeleton,
  Stat,
} from './ui';

/* ------------------------------------------------------------------ */
/* Checklist                                                           */
/* ------------------------------------------------------------------ */

function ChecklistStep({
  index,
  done,
  icon,
  title,
  description,
  children,
  last,
}: {
  index: number;
  done: boolean;
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-4 pb-5 last:pb-0">
      {!last && (
        <span
          className={cn(
            'absolute top-9 bottom-1 left-[15px] w-px',
            done ? 'bg-success/40' : 'bg-border-subtle',
          )}
          aria-hidden
        />
      )}
      <div
        className={cn(
          'relative flex size-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold',
          done
            ? 'border-success/40 bg-success/15 text-success'
            : 'border-border-strong bg-bg-elevated text-text-secondary',
        )}
        aria-hidden
      >
        {done ? <Check size={15} strokeWidth={2.5} /> : index}
      </div>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-muted">{icon}</span>
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <DoneBadge done={done} />
        </div>
        <p className="text-[13px] leading-relaxed text-text-muted">{description}</p>
        {children}
      </div>
    </li>
  );
}

function DoneBadge({ done }: { done: boolean }) {
  const { t } = useLanguage();
  return done ? (
    <Badge tone="ok">{t('home.checklist.done')}</Badge>
  ) : (
    <Badge tone="warn">{t('home.checklist.pending')}</Badge>
  );
}

function SetupChecklist() {
  const { t } = useLanguage();
  const target = useActiveTarget();
  const { studioConnected, studioPlaceName } = useStudioConnectionState();

  const hasAccount = target.userId !== 'none' && target.cookie.length > 0;
  const hasApiKey = target.apiKey.length >= 20;
  const ready = hasAccount && hasApiKey && studioConnected;
  const doneCount = [hasAccount, hasApiKey, studioConnected].filter(Boolean).length;

  return (
    <Panel>
      <PanelHeader
        icon={<CheckCircle2 size={16} />}
        title={t('home.checklist.title')}
        description={t('home.checklist.subtitle')}
        actions={
          <Badge tone={ready ? 'ok' : 'idle'} className="tabular-nums">
            {doneCount}/3
          </Badge>
        }
      />
      <ol className="px-5 pt-5 pb-5">
        <ChecklistStep
          index={1}
          done={hasAccount}
          icon={<UserRound size={14} />}
          title={t('home.checklist.account')}
          description={
            hasAccount
              ? t('home.checklist.accountOk').replace('{name}', target.accountName)
              : t('home.checklist.accountHelp')
          }
        >
          <Button
            size="sm"
            variant={hasAccount ? 'outline' : 'default'}
            onClick={() => goTo('accounts')}
          >
            {hasAccount ? t('home.checklist.manageAccounts') : t('home.checklist.connectAccount')}
            <ArrowRight />
          </Button>
        </ChecklistStep>

        <ChecklistStep
          index={2}
          done={hasApiKey}
          icon={<KeyRound size={14} />}
          title={t('home.checklist.apiKey')}
          description={hasApiKey ? t('home.checklist.apiKeyOk') : t('home.checklist.apiKeyHelp')}
        >
          {!hasApiKey && (
            <Button
              size="sm"
              variant={hasAccount ? 'default' : 'outline'}
              onClick={() => goTo('accounts')}
            >
              {t('home.checklist.addApiKey')}
              <ArrowRight />
            </Button>
          )}
        </ChecklistStep>

        <ChecklistStep
          index={3}
          done={studioConnected}
          icon={<MonitorPlay size={14} />}
          title={t('home.checklist.plugin')}
          description={
            studioConnected
              ? studioPlaceName
                ? t('home.checklist.pluginOkPlace').replace('{place}', studioPlaceName)
                : t('home.checklist.pluginOk')
              : t('home.checklist.pluginHelp')
          }
        >
          {!studioConnected && <PluginActions />}
        </ChecklistStep>

        <ChecklistStep
          index={4}
          done={ready}
          last
          icon={<PartyPopper size={14} />}
          title={t('home.checklist.ready')}
          description={ready ? t('home.checklist.readyOk') : t('home.checklist.readyHelp')}
        >
          {ready && (
            <Button size="sm" onClick={() => goTo('spoof')}>
              {t('home.checklist.startSpoof')}
              <ArrowRight />
            </Button>
          )}
        </ChecklistStep>
      </ol>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Action cards                                                        */
/* ------------------------------------------------------------------ */

function ActionCard({
  icon,
  title,
  description,
  hint,
  onClick,
  disabled,
  busy,
  accent,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  hint?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group relative flex min-h-[152px] cursor-pointer flex-col items-start gap-3 overflow-hidden rounded-xl border p-5 text-left outline-none transition-all',
        'focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
        accent
          ? 'border-brand/35 bg-gradient-to-br from-brand/15 via-bg-surface/80 to-bg-surface/80 hover:border-brand/60'
          : 'border-border-subtle bg-bg-surface/70 hover:border-border-strong hover:bg-bg-elevated/50',
      )}
    >
      <div
        className={cn(
          'flex size-10 items-center justify-center rounded-xl border',
          accent
            ? 'border-brand/40 bg-brand/15 text-brand'
            : 'border-border-subtle bg-bg-elevated/70 text-text-secondary',
        )}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : icon}
      </div>
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-[15px] font-semibold text-text-primary">
          {title}
          <ArrowRight
            size={15}
            className="-translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
          />
        </p>
        <p className="text-[13px] leading-relaxed text-text-muted">{description}</p>
      </div>
      {hint && <div className="mt-auto">{hint}</div>}
    </button>
  );
}

function QuickActions() {
  const { t } = useLanguage();
  const { studioConnected } = useStudioConnectionState();
  const scanPhase = useSessionStore((s) => s.scanPhase);
  const sourceKind = useSessionStore((s) => s.source?.kind);
  const busy = scanPhase === 'scanning' || scanPhase === 'resolving';

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <ActionCard
        accent
        icon={<ScanSearch size={18} />}
        title={t('home.actions.scanStudio')}
        description={t('home.actions.scanStudioDesc')}
        busy={busy && sourceKind !== 'file'}
        onClick={() => void startStudioScan()}
        hint={
          studioConnected ? (
            <Badge tone="ok">{t('home.actions.studioReady')}</Badge>
          ) : (
            <Badge tone="warn">{t('home.actions.studioOffline')}</Badge>
          )
        }
      />
      <ActionCard
        icon={<FileBox size={18} />}
        title={t('home.actions.openFile')}
        description={t('home.actions.openFileDesc')}
        busy={busy && sourceKind === 'file'}
        onClick={() => void startFileScan()}
        hint={<Badge>.rbxl · .rbxlx · .rbxm · .rbxmx</Badge>}
      />
      <ActionCard
        icon={<ClipboardPaste size={18} />}
        title={t('home.actions.pasteIds')}
        description={t('home.actions.pasteIdsDesc')}
        onClick={openPasteIds}
        hint={<Badge>rbxassetid:// · URL · ID</Badge>}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Jobs + stats                                                        */
/* ------------------------------------------------------------------ */

function useJobs() {
  const [jobs, setJobs] = useState<SpoofJob[] | null>(null);
  const completion = useSpooferStore((s) => s.spoofCompletionVersion);
  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      setJobs([]);
      return;
    }
    invoke<SpoofJob[]>('get_jobs')
      .then((data) => {
        if (!cancelled) setJobs(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [completion]);
  return jobs;
}

function sortJobs(jobs: SpoofJob[]) {
  return [...jobs].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
}

function RecentJobs({ jobs }: { jobs: SpoofJob[] | null }) {
  const { t, lang } = useLanguage();
  const recent = useMemo(() => (jobs ? sortJobs(jobs).slice(0, 3) : null), [jobs]);

  return (
    <Panel className="flex flex-col">
      <PanelHeader
        icon={<History size={16} />}
        title={t('home.jobs.title')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => goTo('history')}>
            {t('home.jobs.seeAll')}
            <ArrowRight />
          </Button>
        }
      />
      <div className="px-3 pt-3 pb-3">
        {recent === null ? (
          <div className="space-y-2 px-2 py-1">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={<History size={20} />}
            title={t('home.jobs.empty')}
            description={t('home.jobs.emptyHelp')}
          />
        ) : (
          <ul className="flex flex-col">
            {recent.map((job) => {
              const total = job.assetResults?.length ?? 0;
              const ok = job.assetResults?.filter((r) => r.success).length ?? 0;
              const failed = job.assetResults?.filter((r) => !r.success && !r.skipped).length ?? 0;
              return (
                <li key={job.id}>
                  <button
                    type="button"
                    onClick={() => goTo('history')}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-bg-elevated/50 focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    {failed === 0 ? (
                      <CheckCircle2 size={16} className="shrink-0 text-success" />
                    ) : ok === 0 ? (
                      <XCircle size={16} className="shrink-0 text-danger" />
                    ) : (
                      <CheckCircle2 size={16} className="shrink-0 text-warning" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-text-primary">
                        {t('home.jobs.to').replace(
                          '{name}',
                          job.group?.name || job.account?.name || '—',
                        )}
                      </p>
                      <p className="truncate text-[11.5px] text-text-muted">
                        {formatRelative(job.startTime, lang)} ·{' '}
                        {t('home.jobs.summary')
                          .replace('{ok}', String(ok))
                          .replace('{total}', String(total))}
                      </p>
                    </div>
                    {failed > 0 && (
                      <Badge tone="error">
                        {t('home.jobs.failed').replace('{count}', String(failed))}
                      </Badge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function QuickStats({ jobs }: { jobs: SpoofJob[] | null }) {
  const { t, lang } = useLanguage();
  const mappings = useSpooferStore((s) => s.lastReplacements);
  const stats = useMemo(() => {
    const list = jobs ?? [];
    let assets = 0;
    let ok = 0;
    for (const job of list) {
      for (const r of job.assetResults ?? []) {
        assets += 1;
        if (r.success) ok += 1;
      }
    }
    return {
      jobs: list.length,
      ok,
      rate: assets > 0 ? Math.round((ok / assets) * 100) : null,
    };
  }, [jobs]);
  const mappingCount = useMemo(() => Object.keys(mappings).length, [mappings]);

  if (jobs === null) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[74px] rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat label={t('home.stats.jobs')} value={formatNumber(stats.jobs, lang)} />
      <Stat label={t('home.stats.assets')} value={formatNumber(stats.ok, lang)} />
      <Stat
        label={t('home.stats.successRate')}
        value={stats.rate === null ? '—' : `${stats.rate}%`}
      />
      <Stat label={t('home.stats.mappings')} value={formatNumber(mappingCount, lang)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function ResumeBanner() {
  const { t } = useLanguage();
  const source = useSessionStore((s) => s.source);
  const count = useSessionStore((s) => s.assets.length);
  const isSpoofing = useSpooferStore((s) => s.isSpoofing);
  if (!source && !isSpoofing) return null;
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-3 border-brand/30 bg-brand/[0.06] px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary">
          {isSpoofing ? t('home.resume.running') : t('home.resume.title')}
        </p>
        {source && (
          <p className="truncate text-[13px] text-text-muted">
            {t('home.resume.detail')
              .replace('{source}', source.label)
              .replace('{count}', String(count))}
          </p>
        )}
      </div>
      <Button size="sm" onClick={() => goTo('spoof')}>
        {t('home.resume.open')}
        <ArrowRight />
      </Button>
    </Panel>
  );
}

export default function HomePage() {
  const { t } = useLanguage();
  const target = useActiveTarget();
  const jobs = useJobs();
  const hasAccount = target.userId !== 'none' && target.cookie.length > 0;

  return (
    <PageShell
      title={
        hasAccount
          ? t('home.greetingName').replace('{name}', target.accountName)
          : t('home.greeting')
      }
      description={t('home.subtitle')}
    >
      <ResumeBanner />

      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold tracking-wide text-text-muted uppercase">
          {t('home.actions.title')}
        </h2>
        <QuickActions />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <SetupChecklist />
        <div className="flex min-w-0 flex-col gap-4">
          <QuickStats jobs={jobs} />
          <RecentJobs jobs={jobs} />
        </div>
      </div>
    </PageShell>
  );
}
