import { invoke } from '@tauri-apps/api/core';
import {
  Activity,
  Bot,
  CheckCircle2,
  Loader2,
  Plug,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { Switch } from '../ui/switch';
import {
  Badge,
  CopyButton,
  EmptyState,
  formatRelative,
  PageShell,
  Panel,
  PanelHeader,
  Skeleton,
  StatusDot,
} from './ui';

interface McpInfo {
  enabled: boolean;
  port: number | null;
  url: string | null;
  executable: string;
  tools: string[];
}

const KNOWN_TOOLS = [
  'get_status',
  'scan_studio',
  'scan_file',
  'list_assets',
  'spoof_assets',
  'get_job',
  'cancel_job',
  'push_to_studio',
  'write_spoofed_file',
  'replace_ids',
  'list_profiles',
  'select_profile',
  'get_history',
];

function useMcpInfo(enabled: boolean) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      setInfo({ enabled, port: null, url: null, executable: '', tools: KNOWN_TOOLS });
      return;
    }
    const load = () =>
      invoke<McpInfo>('mcp_get_info')
        .then((data) => {
          if (cancelled) return;
          if (data) {
            setInfo(data);
            setError(false);
          } else setError(true);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    // The server toggles asynchronously after the config change — poll briefly.
    void load();
    const id = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);
  return { info, error };
}

function Snippet({ title, hint, code }: { title: string; hint?: string; code: string }) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-text-primary">{title}</p>
          {hint && <p className="text-[12px] text-text-muted">{hint}</p>}
        </div>
        <CopyButton
          text={code}
          label={t('shell.common.copy')}
          className="border border-border-subtle"
        />
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border-subtle bg-bg-base/70 px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre text-text-secondary">
        {code}
      </pre>
    </div>
  );
}

function ActivityFeed() {
  const { t, lang } = useLanguage();
  const activity = useSessionStore((s) => s.mcpActivity);

  return (
    <Panel className="flex flex-col">
      <PanelHeader
        icon={<Activity size={16} />}
        title={t('mcp.activity.title')}
        description={t('mcp.activity.help')}
      />
      <div className="mt-3 border-t border-border-subtle/70 px-2 py-2">
        {activity.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={<Bot size={20} />}
            title={t('mcp.activity.empty')}
            description={t('mcp.activity.emptyHelp')}
          />
        ) : (
          <ul className="max-h-[360px] overflow-y-auto">
            {activity.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-bg-elevated/40"
              >
                <span className="mt-0.5">
                  {item.ok === undefined ? (
                    <Loader2 size={14} className="animate-spin text-brand" />
                  ) : item.ok ? (
                    <CheckCircle2 size={14} className="text-success" />
                  ) : (
                    <XCircle size={14} className="text-danger" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-[12.5px] font-medium text-text-primary">
                      {item.tool}
                    </code>
                    <span className="text-[11.5px] text-text-muted">
                      {formatRelative(item.at, lang)}
                    </span>
                  </span>
                  <span className="block text-[12px] text-text-muted">
                    {toolDescription(t, item.tool)}
                  </span>
                  {item.summary && (
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted/80">
                      {item.summary}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function toolDescription(t: (k: string) => string, tool: string) {
  const key = `mcp.tools.${tool}`;
  const value = t(key);
  return value === key ? t('mcp.tools.fallback') : value;
}

export default function McpPage() {
  const { t } = useLanguage();
  const enabled = useConfigStore((s) => s.config.general.mcpEnabled);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const { info, error } = useMcpInfo(enabled);

  const running = Boolean(info?.enabled && info.url);
  const url = info?.url ?? 'http://127.0.0.1:<porta>/mcp';
  const executable = info?.executable || 'TrapSpoofer.exe';

  const snippets = useMemo(() => {
    const desktopJson = JSON.stringify(
      { mcpServers: { trapspoofer: { command: executable, args: ['--mcp'] } } },
      null,
      2,
    );
    return {
      cli: `claude mcp add --transport http trapspoofer ${url}`,
      desktop: desktopJson,
      http: url,
    };
  }, [url, executable]);

  const tools = info?.tools?.length ? info.tools : KNOWN_TOOLS;

  return (
    <PageShell title={t('mcp.title')} description={t('mcp.subtitle')}>
      {/* Hero / explanation */}
      <Panel className="overflow-hidden">
        <div className="grid grid-cols-1 gap-6 bg-gradient-to-br from-brand/10 via-transparent to-transparent p-6 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-brand" />
              <p className="text-[15px] font-semibold text-text-primary">{t('mcp.what.title')}</p>
            </div>
            <p className="max-w-2xl text-[13.5px] leading-relaxed text-text-secondary">
              {t('mcp.what.body')}
            </p>
            <ul className="grid gap-1.5 text-[13px] text-text-secondary sm:grid-cols-3">
              {['one', 'two', 'three'].map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                  {t(`mcp.what.${k}`)}
                </li>
              ))}
            </ul>
            <p className="flex items-start gap-2 text-[12.5px] text-text-muted">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" />
              {t('mcp.what.safety')}
            </p>
          </div>

          <div className="flex min-w-[240px] flex-col gap-3 rounded-xl border border-border-subtle bg-bg-surface/80 p-4">
            <label className="flex cursor-pointer items-center justify-between gap-4">
              <span className="text-[13px] font-semibold text-text-primary">{t('mcp.toggle')}</span>
              <Switch
                checked={enabled}
                onCheckedChange={(v) => updateConfig('general', 'mcpEnabled', v)}
              />
            </label>
            <div className="flex items-center gap-2 text-[12.5px]">
              {info === null && !error ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <>
                  <StatusDot tone={running ? 'ok' : enabled ? 'warn' : 'idle'} pulse={running} />
                  <span className="text-text-secondary">
                    {running
                      ? t('mcp.status.running')
                      : enabled
                        ? error
                          ? t('mcp.status.error')
                          : t('mcp.status.starting')
                        : t('mcp.status.off')}
                  </span>
                </>
              )}
            </div>
            {running && info?.url && (
              <div className="flex items-center gap-1 rounded-md bg-bg-base/60 py-1 pr-1 pl-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-secondary">
                  {info.url}
                </code>
                <CopyButton text={info.url} size="xs" />
              </div>
            )}
          </div>
        </div>
      </Panel>

      {/* Setup snippets */}
      <Panel className={cn(!running && 'opacity-90')}>
        <PanelHeader
          icon={<Plug size={16} />}
          title={t('mcp.connect.title')}
          description={running ? t('mcp.connect.help') : t('mcp.connect.helpOff')}
        />
        <div className="grid grid-cols-1 gap-5 px-5 pt-4 pb-5">
          <Snippet
            title={t('mcp.connect.claudeCode')}
            hint={t('mcp.connect.claudeCodeHint')}
            code={snippets.cli}
          />
          <Snippet
            title={t('mcp.connect.desktop')}
            hint={t('mcp.connect.desktopHint')}
            code={snippets.desktop}
          />
          <Snippet
            title={t('mcp.connect.http')}
            hint={t('mcp.connect.httpHint')}
            code={snippets.http}
          />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Tools */}
        <Panel>
          <PanelHeader
            icon={<Wrench size={16} />}
            title={t('mcp.toolsTitle')}
            description={t('mcp.toolsHelp')}
            actions={<Badge>{tools.length}</Badge>}
          />
          <ul className="mt-3 border-t border-border-subtle/70 px-2 py-2">
            {tools.map((tool) => (
              <li
                key={tool}
                className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-bg-elevated/40"
              >
                <code className="mt-px shrink-0 rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-[11.5px] text-text-primary">
                  {tool}
                </code>
                <span className="text-[12.5px] leading-snug text-text-muted">
                  {toolDescription(t, tool)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <ActivityFeed />
      </div>
    </PageShell>
  );
}
