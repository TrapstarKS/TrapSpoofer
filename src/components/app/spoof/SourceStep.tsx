import {
  ArrowRight,
  ChevronDown,
  ClipboardPaste,
  FileBox,
  Loader2,
  MonitorPlay,
  Replace,
  ScanSearch,
  Trash2,
  Upload,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useStudioConnectionState } from '../../../contexts/StudioConnectionContext';
import { cn } from '../../../lib/utils';
import { ASSET_TYPES, parseAssetIds, type SpoofAssetType } from '../../../services/assets';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import { isTauriRuntime } from '../../../utils/tauriRuntime';
import PasteIdsModal from '../../modals/PasteIdsModal';
import { Button } from '../../ui/button';
import { PluginActions } from '../StudioHelp';
import { Badge, Panel, ProgressBar, StatusDot, TYPE_META } from '../ui';
import { resetFlow, startFileScan, startStudioScan, submitManualIds } from './actions';
import { type SourceTab, useFlowStore } from './flowStore';

const ROBLOX_FILE = /\.(rbxl|rbxlx|rbxm|rbxmx)$/i;

function SourceOption({
  id,
  active,
  icon,
  title,
  description,
  onSelect,
}: {
  id: SourceTab;
  active: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: (id: SourceTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={cn(
        'flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-xl border p-4 text-left outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring/40',
        active
          ? 'border-brand/45 bg-brand/[0.08] shadow-[0_0_0_1px_color-mix(in_srgb,var(--brand)_25%,transparent)]'
          : 'border-border-subtle bg-bg-surface/60 hover:border-border-strong hover:bg-bg-elevated/50',
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg border',
          active
            ? 'border-brand/40 bg-brand/15 text-brand'
            : 'border-border-subtle bg-bg-elevated/60 text-text-secondary',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="block text-sm font-semibold text-text-primary">{title}</span>
        <span className="block text-[12.5px] leading-snug text-text-muted">{description}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Studio                                                              */
/* ------------------------------------------------------------------ */

function StudioSource() {
  const { t } = useLanguage();
  const { studioConnected, studioPlaceName, scanStatus } = useStudioConnectionState();
  const scanPhase = useSessionStore((s) => s.scanPhase);
  const [showOptions, setShowOptions] = useState(false);
  const [types, setTypes] = useState<Set<SpoofAssetType>>(
    () => new Set(ASSET_TYPES.filter((type) => type !== 'video')),
  );

  const busy = scanPhase === 'scanning' || scanPhase === 'resolving';
  const scanned = scanStatus?.scanned ?? 0;
  const total = scanStatus?.total ?? 0;
  const pct = total > 0 ? (scanned / total) * 100 : undefined;

  const toggle = (type: SpoofAssetType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  return (
    <div className="flex flex-col gap-5">
      <div
        className={cn(
          'flex items-start gap-3 rounded-xl border px-4 py-3.5',
          studioConnected
            ? 'border-success/25 bg-success/[0.06]'
            : 'border-warning/30 bg-warning/[0.07]',
        )}
      >
        <span className="mt-1.5">
          <StatusDot tone={studioConnected ? 'ok' : 'warn'} pulse={busy} />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold text-text-primary">
            {studioConnected
              ? studioPlaceName
                ? t('flow.source.studioConnectedPlace').replace('{place}', studioPlaceName)
                : t('flow.source.studioConnected')
              : t('flow.source.studioOffline')}
          </p>
          <p className="text-[13px] leading-relaxed text-text-muted">
            {studioConnected ? t('flow.source.studioHelp') : t('flow.source.studioOfflineHelp')}
          </p>
          {!studioConnected && <PluginActions />}
        </div>
      </div>

      {busy && (
        <div
          className="space-y-2 rounded-xl border border-border-subtle bg-bg-base/40 px-4 py-3"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 text-text-secondary">
              <Loader2 size={14} className="shrink-0 animate-spin text-brand" />
              <span className="truncate">
                {scanPhase === 'resolving'
                  ? t('flow.source.resolving')
                  : scanStatus?.current_service
                    ? t('flow.source.scanningService').replace(
                        '{service}',
                        scanStatus.current_service,
                      )
                    : t('flow.source.scanning')}
              </span>
            </span>
            {total > 0 && scanPhase === 'scanning' && (
              <span className="shrink-0 tabular-nums text-text-muted">
                {scanned}/{total}
              </span>
            )}
          </div>
          <ProgressBar value={pct} indeterminate={pct === undefined || scanPhase === 'resolving'} />
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          aria-expanded={showOptions}
          className="flex cursor-pointer items-center gap-1.5 rounded-md text-[12.5px] font-medium text-text-muted outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronDown
            size={14}
            className={cn('transition-transform', !showOptions && '-rotate-90')}
          />
          {t('flow.source.options')}
        </button>
        {showOptions && (
          <div className="mt-3 space-y-2 rounded-xl border border-border-subtle bg-bg-base/30 p-4">
            <p className="text-[12.5px] text-text-muted">{t('flow.source.typesHelp')}</p>
            <div className="flex flex-wrap gap-2">
              {ASSET_TYPES.map((type) => {
                const meta = TYPE_META[type];
                const Icon = meta.icon;
                const on = types.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(type)}
                    className={cn(
                      'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                      on
                        ? 'border-brand/40 bg-brand/10 text-text-primary'
                        : 'border-border-subtle text-text-muted hover:text-text-primary',
                    )}
                  >
                    <Icon size={13} />
                    {t(meta.key)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="lg"
          className="h-10 px-4"
          disabled={!studioConnected || busy || types.size === 0}
          onClick={() => void startStudioScan(Array.from(types))}
        >
          {busy ? <Loader2 className="animate-spin" /> : <ScanSearch />}
          {busy ? t('flow.source.scanningShort') : t('flow.source.scanButton')}
        </Button>
        {!studioConnected && (
          <span className="text-[12.5px] text-text-muted">{t('flow.source.needsStudio')}</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* File                                                                */
/* ------------------------------------------------------------------ */

function FileSource() {
  const { t } = useLanguage();
  const scanPhase = useSessionStore((s) => s.scanPhase);
  const parsingFileName = useSpooferStore((s) => s.parsingFileName);
  const [dragOver, setDragOver] = useState(false);
  const busy = scanPhase === 'scanning' || scanPhase === 'resolving';

  // Native (Tauri) drag & drop gives us real file paths.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'over' || payload.type === 'enter') setDragOver(true);
          else if (payload.type === 'leave') setDragOver(false);
          else if (payload.type === 'drop') {
            setDragOver(false);
            const path = payload.paths.find((p) => ROBLOX_FILE.test(p));
            if (path) void startFileScan(path);
            else
              useSpooferStore
                .getState()
                .showToast('error', useLanguage.getState().t('flow.source.dropInvalid'));
          }
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        disabled={busy}
        onClick={() => void startFileScan()}
        className={cn(
          'flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-progress',
          dragOver
            ? 'border-brand bg-brand/10'
            : 'border-border-strong bg-bg-base/30 hover:border-brand/50 hover:bg-brand/[0.04]',
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-elevated/70 text-text-secondary">
          {busy ? <Loader2 size={20} className="animate-spin text-brand" /> : <Upload size={20} />}
        </span>
        <span className="space-y-1">
          <span className="block text-sm font-semibold text-text-primary">
            {busy
              ? t('flow.source.fileReading').replace('{file}', parsingFileName ?? '')
              : dragOver
                ? t('flow.source.fileDropNow')
                : t('flow.source.fileDrop')}
          </span>
          <span className="block text-[12.5px] text-text-muted">{t('flow.source.fileHelp')}</span>
        </span>
        <span className="flex flex-wrap justify-center gap-1.5">
          {['.rbxl', '.rbxlx', '.rbxm', '.rbxmx'].map((ext) => (
            <Badge key={ext}>{ext}</Badge>
          ))}
        </span>
      </button>
      <p className="text-[12.5px] leading-relaxed text-text-muted">{t('flow.source.fileNote')}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Manual ids                                                          */
/* ------------------------------------------------------------------ */

function ManualSource() {
  const { t } = useLanguage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const count = useMemo(() => parseAssetIds(text).length, [text]);

  const submit = async () => {
    setBusy(true);
    const added = await submitManualIds(text);
    setBusy(false);
    if (added > 0) setText('');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-2">
        <label htmlFor="ts-manual-ids" className="text-[13px] font-medium text-text-secondary">
          {t('flow.source.manualLabel')}
        </label>
        <textarea
          id="ts-manual-ids"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && count > 0) void submit();
          }}
          spellCheck={false}
          placeholder={
            '1234567890\nrbxassetid://9876543210\nhttps://create.roblox.com/store/asset/1122334455'
          }
          className="h-48 w-full resize-none rounded-xl border border-border-strong bg-bg-base/50 p-3 font-mono text-[12.5px] text-text-primary outline-none placeholder:text-text-muted/60 focus:border-brand/50 focus:ring-2 focus:ring-brand/15"
        />
        <p className="text-[12px] text-text-muted">{t('flow.source.manualHelp')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          className="h-10 px-4"
          disabled={count === 0 || busy}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <ClipboardPaste />}
          {count > 0
            ? t('flow.source.manualAdd').replace('{count}', String(count))
            : t('flow.source.manualAddEmpty')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setReplaceOpen(true)}>
          <Replace />
          {t('flow.source.manualReplace')}
        </Button>
      </div>
      {replaceOpen && (
        <PasteIdsModal open={replaceOpen} onOpenChange={setReplaceOpen} initialMode="replace" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step                                                                */
/* ------------------------------------------------------------------ */

function CurrentSession() {
  const { t } = useLanguage();
  const source = useSessionStore((s) => s.source);
  const count = useSessionStore((s) => s.assets.length);
  const setStep = useFlowStore((s) => s.setStep);
  if (!source || count === 0) return null;
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-text-primary">
          {t('flow.source.currentTitle')}
        </p>
        <p className="truncate text-[12.5px] text-text-muted">
          {t('flow.source.currentDetail')
            .replace('{source}', source.label)
            .replace('{count}', String(count))}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={resetFlow}>
          <Trash2 />
          {t('flow.source.clear')}
        </Button>
        <Button size="sm" onClick={() => setStep(1)}>
          {t('flow.source.continue')}
          <ArrowRight />
        </Button>
      </div>
    </Panel>
  );
}

export default function SourceStep() {
  const { t } = useLanguage();
  const tab = useFlowStore((s) => s.sourceTab);
  const setTab = useFlowStore((s) => s.setSourceTab);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-6 lg:px-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            {t('flow.source.title')}
          </h1>
          <p className="text-sm text-text-muted">{t('flow.source.subtitle')}</p>
        </div>

        <CurrentSession />

        <div
          role="tablist"
          aria-label={t('flow.source.title')}
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          <SourceOption
            id="studio"
            active={tab === 'studio'}
            icon={<MonitorPlay size={17} />}
            title={t('flow.source.studio')}
            description={t('flow.source.studioDesc')}
            onSelect={setTab}
          />
          <SourceOption
            id="file"
            active={tab === 'file'}
            icon={<FileBox size={17} />}
            title={t('flow.source.file')}
            description={t('flow.source.fileDesc')}
            onSelect={setTab}
          />
          <SourceOption
            id="manual"
            active={tab === 'manual'}
            icon={<ClipboardPaste size={17} />}
            title={t('flow.source.manual')}
            description={t('flow.source.manualDesc')}
            onSelect={setTab}
          />
        </div>

        <Panel className="p-5" role="tabpanel">
          {tab === 'studio' && <StudioSource />}
          {tab === 'file' && <FileSource />}
          {tab === 'manual' && <ManualSource />}
        </Panel>
      </div>
    </div>
  );
}
