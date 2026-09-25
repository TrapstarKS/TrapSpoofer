import { invoke } from '@tauri-apps/api/core';
import {
  Bot,
  ChevronsLeft,
  ChevronsRight,
  History,
  House,
  type LucideIcon,
  Settings,
  Users,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { useSpooferStore } from '../../stores/spooferStore';
import type { TabId } from '../app/nav';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import ProfilePopup from './ProfilePopup';

const MAIN_TABS: { id: TabId; key: string; icon: LucideIcon }[] = [
  { id: 'home', key: 'shell.nav.home', icon: House },
  { id: 'spoof', key: 'shell.nav.spoof', icon: WandSparkles },
  { id: 'accounts', key: 'shell.nav.accounts', icon: Users },
  { id: 'history', key: 'shell.nav.history', icon: History },
  { id: 'mcp', key: 'shell.nav.mcp', icon: Bot },
];

export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-brand to-[color-mix(in_srgb,var(--brand)_55%,#000)] text-brand-foreground shadow-[0_4px_16px_-4px_var(--brand)]',
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none">
        <path
          d="M5 6.5h14M12 6.5V19"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <path
          d="M15.5 13.5c1.2-.9 2.9-.8 3.5.4.7 1.3-.4 2.3-1.8 2.8-1.5.5-2.4 1.6-1.6 2.8.7 1 2.4 1 3.4.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity=".85"
        />
      </svg>
    </div>
  );
}

function NavButton({
  id,
  label,
  icon: Icon,
  active,
  collapsed,
  badge,
  onClick,
}: {
  id: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      data-tutorial-target={`${id}-tab`}
      onClick={onClick}
      className={cn(
        'group relative flex h-9 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/40',
        active
          ? 'bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--border-strong)]'
          : 'text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary',
        collapsed && 'justify-center px-0',
      )}
    >
      {active && (
        <span className="absolute top-2 bottom-2 -left-2 w-[3px] rounded-r-full bg-brand" />
      )}
      <Icon
        size={17}
        className={cn('shrink-0', active ? 'text-brand' : 'opacity-70 group-hover:opacity-100')}
      />
      {!collapsed && (
        <span
          className={cn('flex-1 truncate text-[13px]', active ? 'font-semibold' : 'font-medium')}
        >
          {label}
        </span>
      )}
      {badge && <span className={cn(collapsed && 'absolute top-1.5 right-1.5')}>{badge}</span>}
    </button>
  );

  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right" className="py-1 text-xs font-medium">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function RunningBadge({ collapsed }: { collapsed: boolean }) {
  const isSpoofing = useSpooferStore((s) => s.isSpoofing);
  const progress = useSpooferStore((s) => Math.round(s.spoofProgress));
  if (!isSpoofing) return null;
  if (collapsed) return <span className="block size-2 animate-pulse rounded-full bg-brand" />;
  return (
    <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-brand">
      {progress}%
    </span>
  );
}

export default function Sidebar({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (id: TabId) => void;
}) {
  const { t } = useLanguage();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('TrapSpoofer_SidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    invoke<string>('get_app_version')
      .then((v) => setAppVersion(v ?? ''))
      .catch(() => setAppVersion(''));
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('TrapSpoofer_SidebarCollapsed', next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  return (
    <nav
      aria-label={t('shell.nav.label')}
      className={cn(
        'relative z-20 flex h-full shrink-0 flex-col border-r border-border-subtle bg-bg-surface/60 px-2 pb-2',
        collapsed ? 'w-[60px]' : 'w-[216px]',
      )}
    >
      <div
        data-tauri-drag-region
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 px-1.5',
          collapsed && 'justify-center',
        )}
      >
        <BrandMark />
        {!collapsed && (
          <div className="flex min-w-0 flex-col leading-tight" data-tauri-drag-region>
            <span className="truncate text-[14px] font-semibold tracking-tight text-text-primary">
              Trap<span className="text-brand">Spoofer</span>
            </span>
            <span className="text-[10.5px] text-text-muted">
              {appVersion ? `v${appVersion}` : ' '}
            </span>
          </div>
        )}
      </div>

      <div className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {!collapsed && (
          <p className="px-2.5 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-wider text-text-muted/80 uppercase">
            {t('shell.nav.section')}
          </p>
        )}
        {MAIN_TABS.map((tab) => (
          <NavButton
            key={tab.id}
            id={tab.id}
            label={t(tab.key)}
            icon={tab.icon}
            active={activeTab === tab.id}
            collapsed={collapsed}
            badge={tab.id === 'spoof' ? <RunningBadge collapsed={collapsed} /> : undefined}
            onClick={() => onTabChange(tab.id)}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-border-subtle/70 pt-2">
        <NavButton
          id="settings"
          label={t('shell.nav.settings')}
          icon={Settings}
          active={activeTab === 'settings'}
          collapsed={collapsed}
          onClick={() => onTabChange('settings')}
        />
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t('shell.nav.expand') : t('shell.nav.collapse')}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[12px] text-text-muted outline-none hover:bg-bg-elevated/60 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring/40',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          {!collapsed && <span>{t('shell.nav.collapse')}</span>}
        </button>
        <div className="pt-1">
          <ProfilePopup collapsed={collapsed} />
        </div>
      </div>
    </nav>
  );
}
