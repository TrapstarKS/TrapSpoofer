import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ChevronRight,
  Loader2,
  Minus,
  MonitorPlay,
  Pause,
  Pin,
  PinOff,
  Terminal,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { useState } from 'react';

import { useConfig } from '../../contexts/ConfigContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStudioConnectionState } from '../../contexts/StudioConnectionContext';
import { cn } from '../../lib/utils';
import { useSpooferStore } from '../../stores/spooferStore';
import { useActiveTarget } from '../app/hooks';
import { goTo, normalizeTab, setConsoleOpen } from '../app/nav';
import { PluginActions } from '../app/StudioHelp';
import { ProgressBar, StatusDot } from '../app/ui';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const pill =
  'flex h-8 min-w-0 max-w-[200px] cursor-pointer items-center gap-2 rounded-lg border border-border-subtle bg-bg-base/40 px-2.5 text-[12px] text-text-secondary outline-none transition-colors hover:border-border-strong hover:bg-bg-elevated/70 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/40';

function StudioPill() {
  const { t } = useLanguage();
  const { studioConnected, studioPlaceName, scanStatus } = useStudioConnectionState();
  const scanning = Boolean(scanStatus?.scanning);
  const label = studioConnected
    ? studioPlaceName?.trim() || t('shell.studio.connected')
    : t('shell.studio.disconnected');

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className={pill} aria-label={t('shell.studio.title')}>
            <StatusDot tone={studioConnected ? 'ok' : 'error'} pulse={scanning} />
            <MonitorPlay size={13} className="shrink-0 opacity-70" />
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <PopoverContent
        align="end"
        className="w-80 gap-3 border border-border-subtle bg-bg-surface p-4"
      >
        <div className="flex items-center gap-2">
          <StatusDot tone={studioConnected ? 'ok' : 'error'} />
          <p className="text-sm font-semibold text-text-primary">
            {studioConnected
              ? t('shell.studio.connectedTitle')
              : t('shell.studio.disconnectedTitle')}
          </p>
        </div>
        <p className="text-[13px] leading-relaxed text-text-muted">
          {studioConnected
            ? studioPlaceName
              ? t('shell.studio.connectedTo').replace('{place}', studioPlaceName)
              : t('shell.studio.connectedHelp')
            : t('shell.studio.disconnectedHelp')}
        </p>
        {!studioConnected && <PluginActions />}
      </PopoverContent>
    </Popover>
  );
}

function ProfilePill() {
  const { t } = useLanguage();
  const target = useActiveTarget();
  const hasProfile = target.userId !== 'none' && target.cookie.length > 0;
  const isGroup = target.groupId !== 'none';

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={pill}
            onClick={() => goTo('accounts')}
            aria-label={t('shell.profile.title')}
          >
            <StatusDot tone={hasProfile ? 'ok' : 'warn'} />
            {isGroup ? (
              <UsersRound size={13} className="shrink-0 opacity-70" />
            ) : (
              <UserRound size={13} className="shrink-0 opacity-70" />
            )}
            <span className="truncate">
              {hasProfile
                ? isGroup
                  ? (target.groupName ?? target.accountName)
                  : target.accountName
                : t('shell.profile.none')}
            </span>
          </button>
        }
      />
      <TooltipContent side="bottom" className="max-w-64 text-xs">
        {hasProfile
          ? isGroup
            ? t('shell.profile.uploadGroup')
                .replace('{group}', target.groupName ?? '')
                .replace('{account}', target.accountName)
            : t('shell.profile.uploadUser').replace('{account}', target.accountName)
          : t('shell.profile.noneHelp')}
      </TooltipContent>
    </Tooltip>
  );
}

function JobPill() {
  const { t } = useLanguage();
  const isSpoofing = useSpooferStore((s) => s.isSpoofing);
  const paused = useSpooferStore((s) => s.isJobPaused);
  const progress = useSpooferStore((s) => Math.round(s.spoofProgress));
  const current = useSpooferStore((s) => s.spoofCurrentCount);
  const total = useSpooferStore((s) => s.spoofTotalCount);
  const isReplacing = useSpooferStore((s) => s.isReplacing);
  const replaceCurrent = useSpooferStore((s) => s.replaceCurrentCount);
  const replaceTotal = useSpooferStore((s) => s.replaceTotalCount);

  if (!isSpoofing && !isReplacing) return null;

  const label = isSpoofing
    ? paused
      ? t('shell.job.paused')
      : total > 0
        ? `${t('shell.job.running')} ${current}/${total}`
        : t('shell.job.running')
    : `${t('shell.job.applying')} ${replaceCurrent}/${replaceTotal}`;
  const pct = isSpoofing
    ? progress
    : replaceTotal > 0
      ? Math.round((replaceCurrent / replaceTotal) * 100)
      : 0;

  return (
    <button
      type="button"
      onClick={() => goTo('spoof')}
      className={cn(pill, 'max-w-[240px] border-brand/30 bg-brand/10 text-text-primary')}
      aria-label={t('shell.job.open')}
    >
      {paused ? (
        <Pause size={13} className="shrink-0 text-warning" />
      ) : (
        <Loader2 size={13} className="shrink-0 animate-spin text-brand" />
      )}
      <span className="truncate tabular-nums">{label}</span>
      <span className="w-12 shrink-0">
        <ProgressBar value={pct} tone={paused ? 'warn' : 'brand'} />
      </span>
      <ChevronRight size={13} className="shrink-0 opacity-60" />
    </button>
  );
}

function WindowButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className={cn(
              'flex size-8 cursor-pointer items-center justify-center rounded-md text-text-muted outline-none hover:bg-bg-elevated hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/40',
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export default function Titlebar() {
  const { t } = useLanguage();
  const { config } = useConfig();
  const tab = normalizeTab(config.ui.activeTab);
  const consoleOpen = Boolean(config.debug?.debugMode);
  const [isPinned, setIsPinned] = useState(false);

  const togglePin = async () => {
    const next = !isPinned;
    setIsPinned(next);
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
    } catch (e) {
      console.warn('Failed to toggle pin', e);
    }
  };

  const handleMinimize = () => {
    void getCurrentWindow().minimize();
  };

  const handleClose = async () => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const previewWin = await WebviewWindow.getByLabel('asset-preview');
      if (previewWin) await previewWin.destroy();
    } catch {}
    if (config.general.hideToTrayOnClose) {
      await getCurrentWindow().hide();
      return;
    }
    await invoke('quit_app');
  };

  return (
    <div
      data-tauri-drag-region
      className="relative z-50 flex h-12 w-full shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface/60 pr-2 pl-5 select-none"
    >
      <span
        data-tauri-drag-region
        className="truncate text-[13px] font-semibold tracking-tight text-text-primary"
      >
        {t(`shell.nav.${tab}`)}
      </span>

      <div className="min-w-4 flex-1 self-stretch" data-tauri-drag-region />

      <div className="flex min-w-0 items-center gap-1.5" data-tauri-drag-region={false}>
        <JobPill />
        <StudioPill />
        <ProfilePill />

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => setConsoleOpen(!consoleOpen)}
                aria-pressed={consoleOpen}
                aria-label={t('shell.console.toggle')}
                className={cn(
                  pill,
                  'w-8 justify-center px-0',
                  consoleOpen && 'border-brand/40 bg-brand/10 text-brand hover:text-brand',
                )}
              />
            }
          >
            <Terminal size={14} />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('shell.console.toggle')}</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-5 w-px bg-border-subtle" />

        <WindowButton label={t('shell.window.minimize')} onClick={handleMinimize}>
          <Minus size={15} />
        </WindowButton>
        <WindowButton
          label={isPinned ? t('shell.window.unpin') : t('shell.window.pin')}
          onClick={() => void togglePin()}
          className={cn(isPinned && 'bg-brand/10 text-brand hover:text-brand')}
        >
          {isPinned ? <Pin size={14} /> : <PinOff size={14} />}
        </WindowButton>
        <WindowButton
          label={t('shell.window.close')}
          onClick={() => void handleClose()}
          className="hover:bg-danger hover:text-white"
        >
          <X size={15} />
        </WindowButton>
      </div>
    </div>
  );
}
