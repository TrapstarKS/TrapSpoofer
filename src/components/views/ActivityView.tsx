import { invoke } from '@tauri-apps/api/core';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  History,
  Play,
  RotateCcw,
  Search,
  SkipForward,
  Trash2,
  User2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { buildExplorerTree, type SpoofAsset, type SpoofAssetType } from '../../services/assets';
import { activateProfile, setUploadGroup } from '../../services/spoofer';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSpooferStore } from '../../stores/spooferStore';
import type { SpoofJob } from '../../utils/jobTypes';
import { logIsm } from '../../utils/robloxProfiles';
import { goTo } from '../app/nav';
import { useFlowStore } from '../app/spoof/flowStore';
import {
  Badge,
  EmptyState,
  formatDuration,
  formatRelative,
  PageShell,
  Panel,
  Skeleton,
} from '../app/ui';
import { VirtualList } from '../app/VirtualList';
import { Button } from '../ui/button';

type JobFilter = 'all' | 'failed';

const TYPE_ALIASES: Record<string, SpoofAssetType> = {
  animation: 'animation',
  audio: 'audio',
  sound: 'audio',
  image: 'image',
  decal: 'image',
  mesh: 'mesh',
  video: 'video',
};

/** Loads a past job's assets into the Spoofar flow (step "Enviar") so the user can confirm. */
async function loadJobIntoFlow(job: SpoofJob, onlyFailed: boolean, label: string) {
  const results = (job.assetResults ?? []).filter((r) =>
    onlyFailed ? !r.success && !r.skipped : true,
  );
  const assets: SpoofAsset[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const id = String(r.id ?? '').replace(/\D/g, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const type = TYPE_ALIASES[String(r.type || r.assetType || '').toLowerCase()] ?? 'animation';
    assets.push({ id, type, name: r.name || `Asset ${id}`, usages: [], fromScript: false });
  }
  if (assets.length === 0) return;

  // Switch to the profile / group the job used, when we still have it.
  const { config } = useConfigStore.getState();
  const accountId = job.account?.id;
  const groupId = job.group?.id ?? job.config?.groupId ?? null;
  try {
    if (accountId && config.accounts.some((a) => a.id === accountId)) {
      if (config.spoofing.selectedUser !== accountId) await activateProfile(accountId, groupId);
      else if ((config.spoofing.selectedGroup || 'none') !== (groupId || 'none'))
        await setUploadGroup(groupId);
    }
  } catch (e) {
    logIsm('warn', String(e), false);
  }

  const session = useSessionStore.getState();
  session.setSource({ kind: 'manual', label, scannedAt: Date.now() }, assets);
  const spoofer = useSpooferStore.getState();
  spoofer.setRootInstances([buildExplorerTree(assets, label)]);
  spoofer.setLoadedFileName(label);
  spoofer.setLoadedFilePath(null);
  spoofer.setSelectedAssetIds(new Set(assets.map((a) => a.id)));
  spoofer.clearAssetStatuses();

  goTo('spoof');
  useFlowStore.getState().setStep(2);
}

function JobCard({
  job,
  open,
  onToggle,
  onDelete,
}: {
  job: SpoofJob;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t, lang } = useLanguage();
  const results = job.assetResults ?? [];
  const ok = results.filter((r) => r.success).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.success && !r.skipped).length;
  const locale = lang === 'pt' ? 'pt-BR' : lang;
  const date = new Date(job.startTime);
  const dateText = Number.isFinite(date.getTime())
    ? date.toLocaleString(locale, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : job.startTime;

  const openLog = async () => {
    if (!job.logFilePath) return;
    try {
      await invoke('open_job_log', { logPath: job.logFilePath });
    } catch (error) {
      logIsm('error', `${t('history.logFailed')} ${String(error)}`, true);
    }
  };

  const name = job.group?.name || job.account?.name || t('history.unknown');

  return (
    <Panel className={cn('overflow-hidden transition-colors', open && 'border-border-strong')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-4 px-4 py-3.5 text-left outline-none hover:bg-bg-elevated/30 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <div className="relative size-10 shrink-0">
          {job.account?.avatarUrl ? (
            <img
              src={job.account.avatarUrl}
              alt=""
              className="size-10 rounded-full border border-border-subtle bg-bg-base object-cover"
            />
          ) : (
            <div className="flex size-10 items-center justify-center rounded-full border border-border-subtle bg-bg-base">
              <User2 size={16} className="text-text-muted" />
            </div>
          )}
          {job.group?.iconUrl && (
            <img
              src={job.group.iconUrl}
              alt=""
              className="absolute -right-1 -bottom-1 size-5 rounded-full border-2 border-bg-surface bg-bg-base object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-text-primary">
            {t('history.to').replace('{name}', name)}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-text-muted">
            <span>{dateText}</span>
            <span aria-hidden>·</span>
            <span>{formatRelative(job.startTime, lang)}</span>
            {job.durationMs > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  {formatDuration(job.durationMs)}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="hidden items-center gap-1.5 sm:flex">
          <Badge tone="ok">
            <CheckCircle2 size={11} />
            {ok}
          </Badge>
          {skipped > 0 && (
            <Badge tone="warn">
              <SkipForward size={11} />
              {skipped}
            </Badge>
          )}
          {failed > 0 && (
            <Badge tone="error">
              <XCircle size={11} />
              {failed}
            </Badge>
          )}
        </div>
        <ChevronDown
          size={16}
          className={cn('shrink-0 text-text-muted transition-transform', !open && '-rotate-90')}
        />
      </button>

      {open && (
        <div className="border-t border-border-subtle/70 bg-bg-base/30 px-4 pt-3 pb-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void loadJobIntoFlow(job, false, t('history.redoLabel'))}
            >
              <Play />
              {t('history.redo')}
            </Button>
            {failed > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadJobIntoFlow(job, true, t('history.retryLabel'))}
              >
                <RotateCcw />
                {t('history.retryFailed').replace('{count}', String(failed))}
              </Button>
            )}
            {job.logFilePath && (
              <Button size="sm" variant="outline" onClick={() => void openLog()}>
                <FileText />
                {t('history.viewLog')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-danger hover:text-danger"
              onClick={onDelete}
            >
              <Trash2 />
              {t('history.delete')}
            </Button>
          </div>

          <div className="overflow-hidden rounded-lg border border-border-subtle/70 bg-bg-base/40">
            <VirtualList
              className={cn('py-1', results.length > 7 ? 'h-[288px]' : '')}
              items={results}
              rowHeight={40}
              getKey={(r, i) => `${r.id}-${i}`}
              renderRow={(res) => (
                <div className="mx-1 flex h-[40px] items-center gap-3 rounded-md px-2.5 text-[12px] hover:bg-bg-elevated/40">
                  {res.success ? (
                    <CheckCircle2 size={14} className="shrink-0 text-success" />
                  ) : res.skipped ? (
                    <SkipForward size={14} className="shrink-0 text-warning" />
                  ) : (
                    <XCircle size={14} className="shrink-0 text-danger" />
                  )}
                  <span className="w-[120px] shrink-0 font-mono text-text-muted">{res.id}</span>
                  <span className="min-w-0 flex-1 truncate text-text-primary">
                    {res.name || t('history.unknownAsset')}
                  </span>
                  {res.newId && (
                    <span className="flex shrink-0 items-center gap-1 font-mono text-success">
                      <ArrowRight size={12} />
                      {res.newId}
                    </span>
                  )}
                  {!res.success && (res.errorReason || res.reason) && (
                    <span
                      className={cn(
                        'max-w-[40%] shrink truncate',
                        res.skipped ? 'text-warning' : 'text-danger',
                      )}
                    >
                      {res.errorReason || res.reason}
                    </span>
                  )}
                </div>
              )}
              empty={
                <p className="px-4 py-6 text-center text-[12.5px] text-text-muted">
                  {t('history.noAssets')}
                </p>
              }
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function ActivityView() {
  const { t } = useLanguage();
  const [jobs, setJobs] = useState<SpoofJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<JobFilter>('all');
  const completion = useSpooferStore((s) => s.spoofCompletionVersion);

  useEffect(() => {
    let cancelled = false;
    invoke<SpoofJob[]>('get_jobs')
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? [...data] : [];
        list.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
        setJobs(list);
      })
      .catch((e) => logIsm('error', `${t('history.loadFailed')} ${String(e)}`, true))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [completion]);

  const handleDelete = async (jobId: string) => {
    try {
      await invoke('delete_job', { jobId });
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch (error) {
      logIsm('error', `${t('history.deleteFailed')} ${String(error)}`, true);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const results = job.assetResults ?? [];
      if (filter === 'failed' && !results.some((r) => !r.success && !r.skipped)) return false;
      if (!q) return true;
      return (
        (job.account?.name ?? '').toLowerCase().includes(q) ||
        (job.group?.name ?? '').toLowerCase().includes(q) ||
        results.some(
          (r) =>
            String(r.id ?? '').includes(q) ||
            String(r.newId ?? '').includes(q) ||
            (r.name ?? '').toLowerCase().includes(q),
        )
      );
    });
  }, [jobs, query, filter]);

  return (
    <PageShell title={t('history.title')} description={t('history.subtitle')}>
      {!isLoading && jobs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('history.search')}
              aria-label={t('history.search')}
              className="h-9 w-full rounded-lg border border-border-strong bg-bg-base/50 pr-3 pl-8 text-[13px] text-text-primary outline-none placeholder:text-text-muted/70 focus:border-brand/50 focus:ring-2 focus:ring-brand/15"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-surface/60 p-0.5">
            {(['all', 'failed'] as JobFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'h-8 cursor-pointer rounded-md px-3 text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  filter === f
                    ? 'bg-bg-elevated text-text-primary'
                    : 'text-text-muted hover:text-text-primary',
                )}
              >
                {t(`history.filter.${f}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] rounded-xl" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<History size={20} />}
            title={t('history.empty')}
            description={t('history.emptyHelp')}
            action={
              <Button onClick={() => goTo('spoof')}>
                {t('history.startFirst')}
                <ArrowRight />
              </Button>
            }
          />
        </Panel>
      ) : visible.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Search size={20} />}
            title={t('history.noMatch')}
            description={t('history.noMatchHelp')}
          />
        </Panel>
      ) : (
        <div className="flex flex-col gap-2.5 pb-6">
          {visible.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              open={openId === job.id}
              onToggle={() => setOpenId((cur) => (cur === job.id ? null : job.id))}
              onDelete={() => void handleDelete(job.id)}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
