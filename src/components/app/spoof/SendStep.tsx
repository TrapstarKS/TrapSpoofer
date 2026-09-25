import {
  ArrowLeft,
  Download,
  Loader2,
  Rocket,
  Send,
  UserRound,
  UsersRound,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { ASSET_TYPES, countByType } from '../../../services/assets';
import {
  activateProfile,
  fetchGroups,
  getAudioQuota,
  setUploadGroup,
} from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import type { RobloxGroup } from '../../../utils/robloxProfiles';
import { Button } from '../../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Switch } from '../../ui/switch';
import { useActiveTarget } from '../hooks';
import { goTo } from '../nav';
import { Badge, Panel, PanelHeader, TYPE_META } from '../ui';
import { useFlowStore } from './flowStore';
import { QuotaDialog, RunFailureAlert, useRunLauncher } from './runLauncher';
import RunningPanel from './RunningPanel';

function TargetCard() {
  const { t } = useLanguage();
  const target = useActiveTarget();
  const accounts = useConfigStore((s) => s.config.accounts);
  const [groups, setGroups] = useState<RobloxGroup[] | null>(null);
  const toast = useSpooferStore((s) => s.showToast);
  const hasProfile = target.userId !== 'none' && accounts.some((a) => a.id === target.userId);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    if (!hasProfile) {
      setGroups([]);
      return;
    }
    fetchGroups(target.userId)
      .then((list) => {
        if (!cancelled) setGroups(list);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target.userId, hasProfile]);

  const accountItems = accounts.map((a) => ({ value: a.id, label: a.name }));
  const destItems = [
    { value: 'none', label: t('flow.send.personal') },
    ...(groups ?? []).map((g) => ({ value: String(g.id), label: g.name })),
  ];
  // Keep the current group visible even before the list loads.
  if (target.groupId !== 'none' && !destItems.some((i) => i.value === target.groupId)) {
    destItems.push({ value: target.groupId, label: target.groupName ?? target.groupId });
  }

  const changeAccount = async (id: string) => {
    try {
      await activateProfile(id, null);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  if (!hasProfile) {
    return (
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-text-primary">{t('flow.send.noProfile')}</p>
            <p className="text-[13px] text-text-muted">{t('flow.send.noProfileHelp')}</p>
          </div>
          <Button onClick={() => goTo('accounts')}>{t('flow.send.addAccount')}</Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        icon={target.groupId !== 'none' ? <UsersRound size={16} /> : <UserRound size={16} />}
        title={t('flow.send.targetTitle')}
        description={t('flow.send.targetHelp')}
      />
      <div className="grid grid-cols-1 gap-4 px-5 pt-4 pb-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-[12px] font-medium text-text-muted">{t('flow.send.account')}</p>
          <Select
            value={target.userId}
            items={accountItems}
            onValueChange={(v) => v && void changeAccount(String(v))}
          >
            <SelectTrigger className="h-9 w-full bg-bg-base/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border-subtle bg-bg-surface">
              {accountItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-muted">
            {t('flow.send.destination')}
            {groups === null && <Loader2 size={11} className="animate-spin" />}
          </p>
          <Select
            value={target.groupId}
            items={destItems}
            onValueChange={(v) => void setUploadGroup(v && v !== 'none' ? String(v) : null)}
          >
            <SelectTrigger className="h-9 w-full bg-bg-base/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border-subtle bg-bg-surface">
              {destItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </Panel>
  );
}

function OptionRow({
  title,
  description,
  checked,
  onChange,
  icon,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 px-5 py-3.5">
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-text-muted">{icon}</span>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-text-primary">{title}</span>
          <span className="block text-[12.5px] leading-snug text-text-muted">{description}</span>
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

function SendForm() {
  const { t, lang } = useLanguage();
  const assets = useSessionStore((s) => s.assets);
  const selected = useSessionStore((s) => s.selected);
  const typeFilter = useSessionStore((s) => s.typeFilter);
  const source = useSessionStore((s) => s.source);
  const downloadOnly = useConfigStore((s) => s.config.spoofing.downloadOnly);
  const autoApply = useConfigStore((s) => s.config.general.autoApplyResults);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const target = useActiveTarget();
  const setStep = useFlowStore((s) => s.setStep);
  const runner = useRunLauncher();
  const [quota, setQuota] = useState<{ remaining: number; total?: number } | null>(null);

  const chosen = useMemo(
    () => assets.filter((a) => selected.has(a.id) && typeFilter.has(a.type)),
    [assets, selected, typeFilter],
  );
  const counts = useMemo(() => countByType(chosen), [chosen]);

  useEffect(() => {
    let cancelled = false;
    if (counts.audio === 0 || downloadOnly) {
      setQuota(null);
      return;
    }
    void getAudioQuota().then((q) => {
      if (!cancelled) setQuota(q);
    });
    return () => {
      cancelled = true;
    };
  }, [counts.audio > 0, downloadOnly, target.userId]);

  const hasTarget = target.userId !== 'none' && target.cookie.length > 0;
  const destination = hasTarget
    ? (target.groupName ?? target.accountName)
    : t('flow.send.noTarget');
  const locale = lang === 'pt' ? 'pt-BR' : lang;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-4 bg-gradient-to-r from-brand/10 to-transparent px-5 py-5">
          <div className="flex size-11 items-center justify-center rounded-xl border border-brand/30 bg-brand/15 text-brand">
            <Send size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold tracking-tight text-text-primary">
              {t('flow.send.summary')
                .replace('{count}', chosen.length.toLocaleString(locale))
                .replace('{target}', destination)}
            </p>
            <p className="text-[13px] text-text-muted">
              {downloadOnly
                ? t('flow.send.summaryDownload')
                : target.groupId !== 'none'
                  ? t('flow.send.summaryGroup')
                  : t('flow.send.summaryUser')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border-subtle/70 px-5 py-3">
          {ASSET_TYPES.filter((type) => counts[type] > 0).map((type) => {
            const meta = TYPE_META[type];
            const Icon = meta.icon;
            return (
              <Badge key={type} className="h-6 px-2.5 text-[12px]">
                <Icon size={12} />
                {counts[type]} {t(meta.key)}
              </Badge>
            );
          })}
          {quota && (
            <Badge
              tone={quota.remaining < counts.audio ? 'warn' : 'idle'}
              className="h-6 px-2.5 text-[12px]"
            >
              <Volume2 size={12} />
              {t('flow.send.quota').replace('{remaining}', String(quota.remaining))}
            </Badge>
          )}
        </div>
      </Panel>

      <TargetCard />

      {/* Options */}
      <Panel className="divide-y divide-border-subtle/70">
        <OptionRow
          icon={<Download size={15} />}
          title={t('flow.send.downloadOnly')}
          description={t('flow.send.downloadOnlyHelp')}
          checked={downloadOnly}
          onChange={(v) => updateConfig('spoofing', 'downloadOnly', v)}
        />
        {source?.kind !== 'file' && !downloadOnly && (
          <OptionRow
            icon={<Rocket size={15} />}
            title={t('flow.send.autoApply')}
            description={t('flow.send.autoApplyHelp')}
            checked={autoApply}
            onChange={(v) => updateConfig('general', 'autoApplyResults', v)}
          />
        )}
      </Panel>

      {runner.failure && (
        <RunFailureAlert failure={runner.failure} onDismiss={runner.dismissFailure} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
        <Button variant="ghost" onClick={() => setStep(1)}>
          <ArrowLeft />
          {t('flow.common.back')}
        </Button>
        <Button
          size="lg"
          className="h-11 px-6 text-[14px]"
          disabled={chosen.length === 0 || runner.launching}
          onClick={() => void runner.launch()}
        >
          {runner.launching ? <Loader2 className="animate-spin" /> : <Rocket />}
          {runner.launching
            ? t('flow.send.checking')
            : downloadOnly
              ? t('flow.send.startDownload')
              : t('flow.send.start')}
        </Button>
      </div>

      <QuotaDialog
        quota={runner.quota}
        onConfirm={() => void runner.confirmQuota()}
        onCancel={runner.cancelQuota}
      />
    </div>
  );
}

export default function SendStep() {
  const { t } = useLanguage();
  const isSpoofing = useSpooferStore((s) => s.isSpoofing);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex h-full max-w-4xl flex-col gap-5 px-6 py-6 lg:px-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            {isSpoofing ? t('flow.run.pageTitle') : t('flow.send.title')}
          </h1>
          <p className="text-sm text-text-muted">
            {isSpoofing ? t('flow.run.pageSubtitle') : t('flow.send.subtitle')}
          </p>
        </div>
        {isSpoofing ? <RunningPanel /> : <SendForm />}
      </div>
    </div>
  );
}
