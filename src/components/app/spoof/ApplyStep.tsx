import {
  ArrowRight,
  CheckCircle2,
  FileDown,
  FolderOpen,
  Loader2,
  MonitorUp,
  Plus,
  RotateCcw,
  Save,
  SkipForward,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useStudioConnectionState } from '../../../contexts/StudioConnectionContext';
import { cn } from '../../../lib/utils';
import { pushToStudio, retryFailed, writeSpoofedFile } from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { applyReplacements, useSpooferStore } from '../../../stores/spooferStore';
import { isTauriRuntime } from '../../../utils/tauriRuntime';
import { Button } from '../../ui/button';
import { useCopy } from '../hooks';
import { Badge, CopyButton, EmptyState, Panel, PanelHeader, ProgressBar, Stat } from '../ui';
import { VirtualList } from '../VirtualList';
import { errorText, resetFlow } from './actions';
import { QuotaDialog, RunFailureAlert, useRunLauncher } from './runLauncher';
import { LiveLog } from './RunningPanel';

type Mapping = { oldId: string; newId: string; name: string };

/** Mappings of the last job (falls back to the saved mappings for the current session). */
function useJobMappings(): Mapping[] {
  const results = useSpooferStore((s) => s.lastAssetResults);
  const replacements = useSpooferStore((s) => s.lastReplacements);
  const meta = useSpooferStore((s) => s.assetMetadataMap);
  const assets = useSessionStore((s) => s.assets);

  return useMemo(() => {
    const names = new Map(assets.map((a) => [a.id, a.name]));
    const nameOf = (id: string) => meta[id]?.name ?? names.get(id) ?? `Asset ${id}`;
    const fromResults: Mapping[] = [];
    for (const r of results) {
      const oldId = String(r.id ?? '');
      const newId = r.newId ? String(r.newId) : replacements[oldId];
      if (r.success && oldId && newId)
        fromResults.push({ oldId, newId, name: r.name || nameOf(oldId) });
    }
    if (fromResults.length > 0) return fromResults;
    const scope = assets.length > 0 ? assets.map((a) => a.id) : Object.keys(replacements);
    return scope
      .filter((id) => replacements[id])
      .map((id) => ({ oldId: id, newId: replacements[id], name: nameOf(id) }));
  }, [results, replacements, meta, assets]);
}

function Summary() {
  const { t } = useLanguage();
  const results = useSpooferStore((s) => s.lastAssetResults);
  const stats = useMemo(() => {
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of results) {
      if (r.success) ok += 1;
      else if (r.skipped) skipped += 1;
      else failed += 1;
    }
    return { ok, skipped, failed };
  }, [results]);
  if (results.length === 0) return null;
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat
        label={
          <span className="flex items-center gap-1.5">
            <CheckCircle2 size={13} className="text-success" />
            {t('flow.apply.succeeded')}
          </span>
        }
        value={stats.ok}
      />
      <Stat
        label={
          <span className="flex items-center gap-1.5">
            <SkipForward size={13} className="text-warning" />
            {t('flow.apply.skipped')}
          </span>
        }
        value={stats.skipped}
      />
      <Stat
        label={
          <span className="flex items-center gap-1.5">
            <XCircle size={13} className="text-danger" />
            {t('flow.apply.failed')}
          </span>
        }
        value={stats.failed}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Apply targets                                                       */
/* ------------------------------------------------------------------ */

function StudioApply({ mappings }: { mappings: Mapping[] }) {
  const { t } = useLanguage();
  const { studioConnected } = useStudioConnectionState();
  const isReplacing = useSpooferStore((s) => s.isReplacing);
  const current = useSpooferStore((s) => s.replaceCurrentCount);
  const total = useSpooferStore((s) => s.replaceTotalCount);
  const replaceError = useSpooferStore((s) => s.replaceError);
  const autoApply = useConfigStore((s) => s.config.general.autoApplyResults);
  const toast = useSpooferStore((s) => s.showToast);
  const [applied, setApplied] = useState(false);

  const apply = async () => {
    try {
      if (mappings.length > 0) {
        // Apply only this job's pairs without overwriting the saved mapping history.
        await applyReplacements(Object.fromEntries(mappings.map((m) => [m.oldId, m.newId])), true);
      } else {
        await pushToStudio();
      }
      setApplied(true);
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const pct = total > 0 ? (current / total) * 100 : undefined;
  const alreadySent = autoApply || applied;

  return (
    <Panel>
      <PanelHeader
        icon={<MonitorUp size={16} />}
        title={t('flow.apply.studioTitle')}
        description={alreadySent ? t('flow.apply.studioAutoSent') : t('flow.apply.studioHelp')}
      />
      <div className="space-y-4 px-5 pt-4 pb-5">
        {isReplacing && (
          <div className="space-y-2" aria-live="polite">
            <div className="flex items-center justify-between text-[13px] text-text-secondary">
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-brand" />
                {t('flow.apply.patching')}
              </span>
              {total > 0 && (
                <span className="tabular-nums text-text-muted">
                  {current}/{total}
                </span>
              )}
            </div>
            <ProgressBar value={pct} indeterminate={pct === undefined} />
          </div>
        )}
        {replaceError && !isReplacing && (
          <p className="rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2 text-[12.5px] text-text-secondary">
            {t('flow.apply.patchError')}
          </p>
        )}
        {!studioConnected && (
          <p className="rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2 text-[12.5px] text-text-secondary">
            {t('flow.apply.studioOffline')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="lg"
            className="h-10 px-4"
            variant={alreadySent ? 'outline' : 'default'}
            disabled={isReplacing || mappings.length === 0}
            onClick={() => void apply()}
          >
            {isReplacing ? <Loader2 className="animate-spin" /> : <MonitorUp />}
            {alreadySent ? t('flow.apply.reapply') : t('flow.apply.apply')}
          </Button>
        </div>
        <div className="flex items-start gap-2.5 rounded-lg border border-info/25 bg-info/[0.06] px-3 py-2.5 text-[12.5px] leading-relaxed text-text-secondary">
          <Save size={14} className="mt-0.5 shrink-0 text-info" />
          <span>{t('flow.apply.saveReminder')}</span>
        </div>
      </div>
    </Panel>
  );
}

function FileApply() {
  const { t } = useLanguage();
  const source = useSessionStore((s) => s.source);
  const lastWrite = useSessionStore((s) => s.lastFileWrite);
  const hasMappings = useSpooferStore((s) => Object.keys(s.lastReplacements).length > 0);
  const toast = useSpooferStore((s) => s.showToast);
  const { copy } = useCopy();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!source?.filePath) return;
    let outputPath: string | undefined;
    if (isTauriRuntime()) {
      try {
        const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
        const ext = source.filePath.split('.').pop() ?? 'rbxl';
        const picked = await saveDialog({
          defaultPath: source.filePath.replace(/(\.[^.\\/]+)$/, '_spoofed$1'),
          filters: [{ name: 'Roblox', extensions: [ext] }],
        });
        if (!picked) return;
        outputPath = picked;
      } catch {
        outputPath = undefined;
      }
    }
    setSaving(true);
    try {
      const result = await writeSpoofedFile({ outputPath });
      toast('success', t('flow.apply.fileSaved').replace('{count}', String(result.patchesApplied)));
    } catch (e) {
      toast('error', `${t('flow.apply.fileFailed')} ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const openFolder = async (path: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_in_folder', { path });
    } catch {
      await copy(path);
      toast('info', t('flow.apply.pathCopied'));
    }
  };

  return (
    <Panel>
      <PanelHeader
        icon={<FileDown size={16} />}
        title={t('flow.apply.fileTitle')}
        description={t('flow.apply.fileHelp').replace('{file}', source?.label ?? '')}
      />
      <div className="space-y-4 px-5 pt-4 pb-5">
        <Button
          size="lg"
          className="h-10 px-4"
          disabled={saving || !hasMappings || !source?.filePath}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {saving ? t('flow.apply.fileSaving') : t('flow.apply.fileSave')}
        </Button>
        {lastWrite && (
          <div className="space-y-2 rounded-xl border border-success/25 bg-success/[0.06] px-4 py-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
              <CheckCircle2 size={15} className="text-success" />
              {t('flow.apply.fileDone')
                .replace('{applied}', String(lastWrite.patchesApplied))
                .replace('{failed}', String(lastWrite.patchesFailed))}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-bg-base/60 px-2 py-1 font-mono text-[12px] text-text-secondary">
                {lastWrite.outputPath}
              </code>
              <CopyButton text={lastWrite.outputPath} />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openFolder(lastWrite.outputPath)}
              >
                <FolderOpen />
                {t('flow.apply.openFolder')}
              </Button>
            </div>
            {lastWrite.warnings.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-warning">
                {lastWrite.warnings.slice(0, 5).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Results + failures                                                  */
/* ------------------------------------------------------------------ */

function ResultsTable({ mappings }: { mappings: Mapping[] }) {
  const { t } = useLanguage();
  const toast = useSpooferStore((s) => s.showToast);
  const text = useMemo(
    () => mappings.map((m) => `${m.oldId} -> ${m.newId}`).join('\n'),
    [mappings],
  );

  const exportTxt = async () => {
    try {
      if (isTauriRuntime()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const path = await save({
          defaultPath: `trapspoofer-ids-${new Date().toISOString().slice(0, 10)}.txt`,
          filters: [{ name: 'Texto', extensions: ['txt'] }],
        });
        if (!path) return;
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(path, text);
        toast('success', t('flow.apply.exported'));
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'trapspoofer-ids.txt';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  return (
    <Panel className="flex flex-col overflow-hidden">
      <PanelHeader
        title={t('flow.apply.resultsTitle')}
        description={t('flow.apply.resultsHelp').replace('{count}', String(mappings.length))}
        actions={
          mappings.length > 0 && (
            <>
              <CopyButton
                text={text}
                label={t('flow.apply.copyAll')}
                className="border border-border-subtle"
              />
              <Button size="sm" variant="outline" onClick={() => void exportTxt()}>
                <FileDown />
                {t('flow.apply.export')}
              </Button>
            </>
          )
        }
      />
      <div className="mt-4 border-t border-border-subtle/70">
        {mappings.length === 0 ? (
          <EmptyState
            className="py-8"
            title={t('flow.apply.noResults')}
            description={t('flow.apply.noResultsHelp')}
          />
        ) : (
          <VirtualList
            className={cn('py-1', mappings.length > 8 ? 'h-[320px]' : '')}
            items={mappings}
            rowHeight={40}
            getKey={(m) => m.oldId}
            renderRow={(m) => (
              <div className="group mx-2 flex h-[40px] items-center gap-3 rounded-lg px-3 hover:bg-bg-elevated/40">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-primary">
                  {m.name}
                </span>
                <span className="font-mono text-[12px] tabular-nums text-text-muted">
                  {m.oldId}
                </span>
                <ArrowRight size={13} className="shrink-0 text-text-muted" />
                <span className="font-mono text-[12px] font-medium tabular-nums text-success">
                  {m.newId}
                </span>
                <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <CopyButton text={m.newId} size="xs" />
                </span>
              </div>
            )}
          />
        )}
      </div>
    </Panel>
  );
}

function FailedList() {
  const { t } = useLanguage();
  const results = useSpooferStore((s) => s.lastAssetResults);
  const runner = useRunLauncher();
  const failed = useMemo(() => results.filter((r) => !r.success && !r.skipped), [results]);
  if (failed.length === 0) return null;

  return (
    <Panel className="overflow-hidden border-danger/25">
      <PanelHeader
        icon={<XCircle size={16} className="text-danger" />}
        title={t('flow.apply.failedTitle').replace('{count}', String(failed.length))}
        description={t('flow.apply.failedHelp')}
        actions={
          <Button onClick={() => void runner.launch(retryFailed)} disabled={runner.launching}>
            {runner.launching ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {t('flow.apply.retry')}
          </Button>
        }
      />
      <div className="mt-4 space-y-3 border-t border-border-subtle/70 px-2 py-2">
        {runner.failure && (
          <div className="px-3 pt-2">
            <RunFailureAlert failure={runner.failure} onDismiss={runner.dismissFailure} />
          </div>
        )}
        <ul className="max-h-[260px] overflow-y-auto">
          {failed.slice(0, 500).map((r, i) => (
            <li
              key={`${r.id}-${i}`}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg-elevated/40"
            >
              <XCircle size={14} className="shrink-0 text-danger" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-text-primary">
                  {r.name || `Asset ${r.id}`}{' '}
                  <span className="font-mono text-text-muted">{r.id}</span>
                </span>
                <span className="block truncate text-[12px] text-danger/90">
                  {r.errorReason || r.reason || t('flow.apply.unknownError')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <QuotaDialog
        quota={runner.quota}
        onConfirm={() => void runner.confirmQuota()}
        onCancel={runner.cancelQuota}
      />
    </Panel>
  );
}

export default function ApplyStep() {
  const { t } = useLanguage();
  const sourceKind = useSessionStore((s) => s.source?.kind);
  const downloadOnly = useConfigStore((s) => s.config.spoofing.downloadOnly);
  const mappings = useJobMappings();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-6 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">
              {t('flow.apply.title')}
            </h1>
            <p className="text-sm text-text-muted">
              {downloadOnly ? t('flow.apply.subtitleDownload') : t('flow.apply.subtitle')}
            </p>
          </div>
          <Button variant="outline" onClick={resetFlow}>
            <Plus />
            {t('flow.apply.newSpoof')}
          </Button>
        </div>

        <Summary />

        {!downloadOnly &&
          (sourceKind === 'file' ? <FileApply /> : <StudioApply mappings={mappings} />)}

        <FailedList />
        <ResultsTable mappings={mappings} />
        <LiveLog />

        <div className="flex justify-center pb-4">
          <Badge className="h-6 px-3 text-[12px]">{t('flow.apply.historyHint')}</Badge>
        </div>
      </div>
    </div>
  );
}
