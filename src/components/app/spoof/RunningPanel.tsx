import {
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Download,
  Loader2,
  Pause,
  Play,
  Search,
  SkipForward,
  Square,
  Upload,
  XCircle,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { cn } from '../../../lib/utils';
import { cancelJob, forceReset, pauseJob, resumeJob } from '../../../services/spoofer';
import { type AssetStage, useSpooferStore } from '../../../stores/spooferStore';
import { Button } from '../../ui/button';
import { useActiveTarget, useNow } from '../hooks';
import { Badge, formatDuration, Panel, ProgressBar } from '../ui';
import { VirtualList } from '../VirtualList';

/* ------------------------------------------------------------------ */
/* Header / progress                                                   */
/* ------------------------------------------------------------------ */

function ProgressHeader() {
  const { t } = useLanguage();
  const target = useActiveTarget();
  const progress = useSpooferStore((s) => s.spoofProgress);
  const current = useSpooferStore((s) => s.spoofCurrentCount);
  const total = useSpooferStore((s) => s.spoofTotalCount);
  const status = useSpooferStore((s) => s.spoofStatusText);
  const startTime = useSpooferStore((s) => s.spoofStartTime);
  const paused = useSpooferStore((s) => s.isJobPaused);
  const jobId = useSpooferStore((s) => s.activeSpooferJobId);
  const now = useNow(!paused);
  const [cancelling, setCancelling] = useState(false);

  const elapsed = startTime ? now - startTime : 0;
  const eta =
    startTime && current > 0 && total > current && !paused
      ? (elapsed / current) * (total - current)
      : null;

  const cancel = async () => {
    setCancelling(true);
    const ok = await cancelJob();
    if (!ok) setCancelling(false);
  };

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-text-primary">
            {paused ? (
              <Pause size={16} className="text-warning" />
            ) : (
              <Loader2 size={16} className="animate-spin text-brand" />
            )}
            {paused ? t('flow.run.paused') : t('flow.run.title')}
          </p>
          <p className="truncate text-[13px] text-text-muted">
            {t('flow.run.to').replace('{target}', target.groupName ?? target.accountName)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {paused ? (
            <Button variant="outline" onClick={() => resumeJob()} disabled={!jobId}>
              <Play />
              {t('flow.run.resume')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => pauseJob()} disabled={!jobId}>
              <Pause />
              {t('flow.run.pause')}
            </Button>
          )}
          <Button
            variant="destructive"
            onClick={() => void cancel()}
            disabled={!jobId || cancelling}
          >
            {cancelling ? <Loader2 className="animate-spin" /> : <Square />}
            {cancelling ? t('flow.run.cancelling') : t('flow.run.cancel')}
          </Button>
        </div>
      </div>

      <div className="mt-5 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-text-primary">
            {Math.round(progress)}%
          </span>
          <span className="text-[13px] tabular-nums text-text-secondary">
            {t('flow.run.count')
              .replace('{current}', String(current))
              .replace('{total}', String(total || '—'))}
          </span>
        </div>
        <ProgressBar value={progress} tone={paused ? 'warn' : 'brand'} className="h-2" />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-text-muted">
          <span className="min-w-0 truncate">{status || t('flow.run.preparing')}</span>
          <span className="flex shrink-0 items-center gap-3 tabular-nums">
            <span>
              {t('flow.run.elapsed')} {formatDuration(elapsed)}
            </span>
            <span>
              {t('flow.run.eta')} {eta !== null ? formatDuration(eta) : '—'}
            </span>
          </span>
        </div>
      </div>

      {cancelling && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2 text-[12.5px] text-text-secondary">
          <span>{t('flow.run.cancelHelp')}</span>
          <Button size="sm" variant="ghost" onClick={() => void forceReset()}>
            <AlertOctagon />
            {t('flow.run.forceReset')}
          </Button>
        </div>
      )}
      {!jobId && <p className="mt-3 text-[12px] text-text-muted">{t('flow.run.starting')}</p>}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Per-asset statuses                                                  */
/* ------------------------------------------------------------------ */

type Bucket = 'active' | 'error' | 'done' | 'queued';

const ACTIVE: AssetStage[] = [
  'resolving_location',
  'discovering_usage',
  'discovering_graph',
  'downloading',
  'uploading',
];

function bucketOf(stage: AssetStage, message?: string): Bucket {
  if (stage === 'error') return 'error';
  if (stage === 'done' || stage === 'skipped') return 'done';
  if (stage === 'downloading' && message && /fila|queue/i.test(message)) return 'queued';
  if (ACTIVE.includes(stage)) return 'active';
  return 'queued';
}

const ORDER: Record<Bucket, number> = { active: 0, error: 1, queued: 2, done: 3 };

function StageIcon({ stage, bucket }: { stage: AssetStage; bucket: Bucket }) {
  if (bucket === 'queued') return <CircleDashed size={15} className="text-text-muted" />;
  if (stage === 'done') return <CheckCircle2 size={15} className="text-success" />;
  if (stage === 'skipped') return <SkipForward size={15} className="text-warning" />;
  if (stage === 'error') return <XCircle size={15} className="text-danger" />;
  if (stage === 'uploading') return <Upload size={15} className="text-brand" />;
  if (stage === 'downloading') return <Download size={15} className="text-info" />;
  return <Search size={15} className="text-info" />;
}

const StatusRow = memo(function StatusRow({
  id,
  name,
  stage,
  message,
  bucket,
}: {
  id: string;
  name: string;
  stage: AssetStage;
  message?: string;
  bucket: Bucket;
}) {
  const { t } = useLanguage();
  const label = bucket === 'queued' ? t('flow.stage.queued') : t(`flow.stage.${stage}`);
  return (
    <div className="mx-2 flex h-[40px] items-center gap-3 rounded-lg px-3 hover:bg-bg-elevated/40">
      <StageIcon stage={stage} bucket={bucket} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-text-primary">{name}</p>
        <p className="truncate font-mono text-[11px] text-text-muted">{id}</p>
      </div>
      <span
        className={cn(
          'max-w-[45%] truncate text-right text-[12px]',
          stage === 'error' ? 'text-danger' : 'text-text-muted',
        )}
      >
        {stage === 'error' && message ? message : label}
      </span>
    </div>
  );
});

function AssetStatusList() {
  const { t } = useLanguage();
  const statuses = useSpooferStore((s) => s.assetStatuses);
  const meta = useSpooferStore((s) => s.assetMetadataMap);
  const [filter, setFilter] = useState<'all' | Bucket>('all');

  const rows = useMemo(() => {
    const list = Object.entries(statuses).map(([id, st]) => ({
      id,
      name: meta[id]?.name ?? `Asset ${id}`,
      stage: st.stage,
      message: st.message,
      bucket: bucketOf(st.stage, st.message),
    }));
    list.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket]);
    return list;
  }, [statuses, meta]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { active: 0, error: 0, done: 0, queued: 0 };
    for (const r of rows) c[r.bucket] += 1;
    return c;
  }, [rows]);

  const shown = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.bucket === filter)),
    [rows, filter],
  );

  const tabs: { id: 'all' | Bucket; count: number }[] = [
    { id: 'all', count: rows.length },
    { id: 'active', count: counts.active },
    { id: 'queued', count: counts.queued },
    { id: 'error', count: counts.error },
    { id: 'done', count: counts.done },
  ];

  return (
    <Panel className="flex min-h-[280px] flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-subtle/70 px-4 py-2.5">
        <p className="text-[13px] font-semibold text-text-primary">{t('flow.run.assets')}</p>
        <div className="flex flex-wrap items-center gap-1" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                filter === tab.id
                  ? 'bg-bg-elevated font-medium text-text-primary'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t(`flow.run.filter.${tab.id}`)}
              <span className="tabular-nums text-text-muted">{tab.count}</span>
            </button>
          ))}
        </div>
      </div>
      <VirtualList
        className="min-h-0 flex-1 py-1"
        items={shown}
        rowHeight={40}
        getKey={(r) => r.id}
        renderRow={(r) => (
          <StatusRow
            id={r.id}
            name={r.name}
            stage={r.stage}
            message={r.message}
            bucket={r.bucket}
          />
        )}
        empty={
          <p className="px-5 py-8 text-center text-[13px] text-text-muted">
            {t('flow.run.noneHere')}
          </p>
        }
      />
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Live log                                                            */
/* ------------------------------------------------------------------ */

function logTone(line: string) {
  if (/\[(ERROR|FATAL)\]/i.test(line)) return 'text-danger';
  if (/\[WARN/i.test(line)) return 'text-warning';
  if (/\[SUCCESS\]/i.test(line)) return 'text-success';
  return 'text-text-secondary';
}

export function LiveLog({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(defaultOpen);
  const logs = useSpooferStore((s) => s.spoofingLogs);
  const ref = useRef<HTMLDivElement>(null);
  const tail = useMemo(() => logs.slice(-300), [logs]);

  useEffect(() => {
    if (!open || !ref.current) return;
    const el = ref.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [tail, open]);

  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
          <ChevronDown size={15} className={cn('transition-transform', !open && '-rotate-90')} />
          {t('flow.run.log')}
        </span>
        <Badge>{tail.length}</Badge>
      </button>
      {open && (
        <div
          ref={ref}
          className="max-h-64 overflow-y-auto border-t border-border-subtle/70 bg-bg-base/50 px-4 py-2.5 font-mono text-[11.5px] leading-relaxed"
        >
          {tail.length === 0 ? (
            <p className="text-text-muted">{t('flow.run.logEmpty')}</p>
          ) : (
            tail.map((line, i) => (
              <div key={i} className={cn('break-words whitespace-pre-wrap', logTone(line))}>
                {line.trimEnd()}
              </div>
            ))
          )}
        </div>
      )}
    </Panel>
  );
}

export default function RunningPanel() {
  return (
    <div className="flex h-full flex-col gap-4">
      <ProgressHeader />
      <AssetStatusList />
      <LiveLog />
    </div>
  );
}
