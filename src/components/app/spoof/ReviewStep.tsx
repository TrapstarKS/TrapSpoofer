import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  ListTree,
  Loader2,
  MapPinned,
  MoreHorizontal,
  Rows3,
  Search,
  SlidersHorizontal,
  UserCheck,
  X,
} from 'lucide-react';
import { lazy, memo, Suspense, useDeferredValue, useEffect, useMemo, useState } from 'react';

import { useLanguage } from '../../../contexts/LanguageContext';
import { cn } from '../../../lib/utils';
import {
  ASSET_TYPES,
  countByType,
  type SpoofAsset,
  type SpoofAssetType,
} from '../../../services/assets';
import { discoverPlaceIds } from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { isOwnedBy, useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Badge, CopyButton, EmptyState, TYPE_META, TypeIcon } from '../ui';
import { VirtualList } from '../VirtualList';
import { useFlowStore } from './flowStore';

const AssetExplorer = lazy(() => import('../../views/AssetExplorer'));

const ROW_HEIGHT = 52;

type Ownership = 'own' | 'third' | 'checking' | 'unknown';

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

const OwnerBadge = memo(function OwnerBadge({ owner }: { owner: Ownership }) {
  const { t } = useLanguage();
  if (owner === 'own') return <Badge tone="ok">{t('flow.review.ownYours')}</Badge>;
  if (owner === 'third') return <Badge tone="info">{t('flow.review.ownThird')}</Badge>;
  if (owner === 'checking')
    return (
      <Badge>
        <Loader2 size={10} className="animate-spin" />
        {t('flow.review.ownChecking')}
      </Badge>
    );
  return <Badge>{t('flow.review.ownUnknown')}</Badge>;
});

const AssetRow = memo(function AssetRow({
  asset,
  selected,
  owner,
  onToggle,
}: {
  asset: SpoofAsset;
  selected: boolean;
  owner: Ownership;
  onToggle: (id: string) => void;
}) {
  const { t } = useLanguage();
  const first = asset.usages[0];
  const more = asset.usages.length - 1;
  return (
    <div
      onClick={() => onToggle(asset.id)}
      className={cn(
        'group mx-2 flex h-[48px] cursor-pointer items-center gap-3 rounded-lg px-3 transition-colors',
        selected ? 'bg-brand/[0.06] hover:bg-brand/10' : 'hover:bg-bg-elevated/50',
      )}
    >
      <span onClick={(e) => e.stopPropagation()} className="flex">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(asset.id)}
          aria-label={t('flow.review.selectAsset').replace('{name}', asset.name)}
        />
      </span>
      <TypeIcon type={asset.type} />
      <div className="min-w-0 flex-[1.3]">
        <p className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text-primary">
          <span className="truncate">{asset.name}</span>
          {asset.fromScript && <Badge tone="info">{t('flow.review.inScript')}</Badge>}
        </p>
        <div className="flex items-center gap-1 text-[11.5px] text-text-muted">
          <span className="font-mono tabular-nums">{asset.id}</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton text={asset.id} size="xs" />
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 md:block">
        {first ? (
          <p className="flex items-center gap-1.5 text-[12px] text-text-muted" title={first.path}>
            <span className="truncate font-mono">{first.path}</span>
            {more > 0 && (
              <span className="shrink-0 rounded bg-bg-elevated px-1 text-[10.5px] font-medium text-text-secondary">
                +{more}
              </span>
            )}
          </p>
        ) : (
          <p className="text-[12px] text-text-muted/70 italic">{t('flow.review.noUsage')}</p>
        )}
      </div>
      <div className="flex w-[118px] shrink-0 justify-end">
        <OwnerBadge owner={owner} />
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Toolbar pieces                                                      */
/* ------------------------------------------------------------------ */

function TypeChips({ counts }: { counts: Record<SpoofAssetType, number> }) {
  const { t } = useLanguage();
  const typeFilter = useSessionStore((s) => s.typeFilter);
  const toggleType = useSessionStore((s) => s.toggleType);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ASSET_TYPES.filter((type) => counts[type] > 0).map((type) => {
        const meta = TYPE_META[type];
        const Icon = meta.icon;
        const on = typeFilter.has(type);
        return (
          <button
            key={type}
            type="button"
            aria-pressed={on}
            onClick={() => toggleType(type)}
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
              on
                ? 'border-border-strong bg-bg-elevated text-text-primary'
                : 'border-border-subtle text-text-muted line-through decoration-text-muted/50 hover:text-text-secondary',
            )}
          >
            <Icon size={12} className={on ? meta.className.split(' ')[0] : ''} />
            {t(meta.key)}
            <span className="tabular-nums text-text-muted">{counts[type]}</span>
          </button>
        );
      })}
    </div>
  );
}

function MoreMenu() {
  const { t } = useLanguage();
  const discovering = useSpooferStore((s) => s.isDiscoveringPlaceIds);
  const toast = useSpooferStore((s) => s.showToast);

  const discover = async () => {
    try {
      const { searched, found } = await discoverPlaceIds();
      toast(
        found > 0 ? 'success' : 'info',
        t('flow.review.discoverDone')
          .replace('{found}', String(found))
          .replace('{searched}', String(searched)),
      );
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="icon" aria-label={t('flow.review.more')}>
            {discovering ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-72 gap-1 border border-border-subtle bg-bg-surface p-1.5"
      >
        <button
          type="button"
          disabled={discovering}
          onClick={() => void discover()}
          className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none hover:bg-bg-elevated focus-visible:bg-bg-elevated disabled:opacity-50"
        >
          <MapPinned size={15} className="mt-0.5 shrink-0 text-text-muted" />
          <span>
            <span className="block text-[13px] font-medium text-text-primary">
              {t('flow.review.discover')}
            </span>
            <span className="block text-[12px] leading-snug text-text-muted">
              {t('flow.review.discoverHelp')}
            </span>
          </span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Tree mode (legacy explorer)                                         */
/* ------------------------------------------------------------------ */

function TreeView({ query }: { query: string }) {
  const { t } = useLanguage();
  const isInspectorOpen = useSpooferStore((s) => s.isInspectorOpen);
  const isPropertiesOpen = useSpooferStore((s) => s.isPropertiesOpen);

  // Mirror selection both ways while the explorer is visible.
  useEffect(() => {
    const spoofer = useSpooferStore.getState();
    spoofer.setSelectedAssetIds(new Set(useSessionStore.getState().selected));
    const unsub = useSpooferStore.subscribe((state, prev) => {
      if (state.selectedAssetIds === prev.selectedAssetIds) return;
      const known = new Set(useSessionStore.getState().assets.map((a) => a.id));
      useSessionStore
        .getState()
        .setSelected(new Set(Array.from(state.selectedAssetIds).filter((id) => known.has(id))));
    });
    return unsub;
  }, []);

  useEffect(() => {
    useSpooferStore.getState().setSearchQuery(query);
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1.5 px-3 pb-2">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={isInspectorOpen}
          onClick={() => useSpooferStore.getState().setIsInspectorOpen((v) => !v)}
        >
          {isInspectorOpen ? <Eye /> : <EyeOff />}
          {t('flow.review.preview')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={isPropertiesOpen}
          onClick={() => useSpooferStore.getState().setIsPropertiesOpen((v) => !v)}
        >
          <SlidersHorizontal />
          {t('flow.review.properties')}
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-border-subtle">
        <Suspense fallback={<div className="ts-skeleton m-4 h-full flex-1 rounded-xl" />}>
          <AssetExplorer isOpen setIsOpen={() => undefined} mode="main" />
        </Suspense>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step                                                                */
/* ------------------------------------------------------------------ */

export default function ReviewStep() {
  const { t, lang } = useLanguage();
  const assets = useSessionStore((s) => s.assets);
  const owners = useSessionStore((s) => s.owners);
  const ownersLoading = useSessionStore((s) => s.ownersLoading);
  const selected = useSessionStore((s) => s.selected);
  const typeFilter = useSessionStore((s) => s.typeFilter);
  const source = useSessionStore((s) => s.source);
  const toggleSelected = useSessionStore((s) => s.toggleSelected);
  const setSelected = useSessionStore((s) => s.setSelected);
  const userId = useConfigStore((s) => s.config.spoofing.selectedUser);
  const groupId = useConfigStore((s) => s.config.spoofing.selectedGroup);
  const treeView = useFlowStore((s) => s.treeView);
  const setTreeView = useFlowStore((s) => s.setTreeView);
  const setStep = useFlowStore((s) => s.setStep);

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const counts = useMemo(() => countByType(assets), [assets]);

  const ownership = useMemo(() => {
    const map = new Map<string, Ownership>();
    for (const a of assets) {
      const owned = isOwnedBy(owners[a.id], userId, groupId);
      map.set(
        a.id,
        owned === true ? 'own' : owned === false ? 'third' : ownersLoading ? 'checking' : 'unknown',
      );
    }
    return map;
  }, [assets, owners, ownersLoading, userId, groupId]);

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (!typeFilter.has(a.type)) return false;
      if (!q) return true;
      return (
        a.id.includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.usages.some((u) => u.path.toLowerCase().includes(q))
      );
    });
  }, [assets, typeFilter, deferredQuery]);

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const a of assets) if (selected.has(a.id) && typeFilter.has(a.type)) n += 1;
    return n;
  }, [assets, selected, typeFilter]);

  const ownCount = useMemo(() => {
    let n = 0;
    for (const v of ownership.values()) if (v === 'own') n += 1;
    return n;
  }, [ownership]);

  const allVisibleSelected = visible.length > 0 && visible.every((a) => selected.has(a.id));

  const selectVisible = (on: boolean) => {
    const next = new Set(selected);
    for (const a of visible) {
      if (on) next.add(a.id);
      else next.delete(a.id);
    }
    setSelected(next);
  };

  const selectThirdParty = () => {
    setSelected(new Set(assets.filter((a) => ownership.get(a.id) !== 'own').map((a) => a.id)));
  };

  if (assets.length === 0) {
    return (
      <EmptyState
        className="h-full"
        icon={<Rows3 size={20} />}
        title={t('flow.review.emptyTitle')}
        description={t('flow.review.emptyHelp')}
        action={
          <Button onClick={() => setStep(0)}>
            <ArrowLeft />
            {t('flow.review.backToSource')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-6 pt-5 lg:px-8">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 pb-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            {t('flow.review.title')}
          </h1>
          <p className="truncate text-sm text-text-muted">
            {t('flow.review.subtitle')
              .replace('{count}', assets.length.toLocaleString(lang === 'pt' ? 'pt-BR' : lang))
              .replace('{source}', source?.label ?? '—')}
            {ownersLoading && (
              <span className="ml-2 inline-flex items-center gap-1 text-text-muted">
                <Loader2 size={12} className="animate-spin" />
                {t('flow.review.checkingOwners')}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-surface/60 p-0.5">
          <button
            type="button"
            aria-pressed={!treeView}
            onClick={() => setTreeView(false)}
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              !treeView
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            <Rows3 size={13} />
            {t('flow.review.listView')}
          </button>
          <button
            type="button"
            aria-pressed={treeView}
            onClick={() => setTreeView(true)}
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              treeView
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            <ListTree size={13} />
            {t('flow.review.treeView')}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-col gap-3 rounded-t-xl border border-b-0 border-border-subtle bg-bg-surface/70 px-3 pt-3 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('flow.review.search')}
              aria-label={t('flow.review.search')}
              className="h-8 w-full rounded-lg border border-border-strong bg-bg-base/50 pr-8 pl-8 text-[13px] text-text-primary outline-none placeholder:text-text-muted/70 focus:border-brand/50 focus:ring-2 focus:ring-brand/15"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('shell.common.clear')}
                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-text-muted hover:text-text-primary"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {!treeView && (
            <>
              <Button
                variant="outline"
                size="default"
                onClick={() => selectVisible(!allVisibleSelected)}
              >
                {allVisibleSelected ? t('flow.review.selectNone') : t('flow.review.selectAll')}
              </Button>
              <Button
                variant="outline"
                size="default"
                onClick={selectThirdParty}
                disabled={ownCount === 0 && !ownersLoading}
              >
                <UserCheck />
                {t('flow.review.onlyThirdParty')}
              </Button>
            </>
          )}
          <MoreMenu />
        </div>
        <TypeChips counts={counts} />
      </div>

      {/* List */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border-subtle bg-bg-surface/40">
        {treeView ? (
          <div className="flex min-h-0 flex-1 flex-col pt-2">
            <TreeView query={deferredQuery} />
          </div>
        ) : (
          <>
            <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border-subtle/70 px-5 text-[11px] font-medium tracking-wide text-text-muted uppercase">
              <span className="w-4" />
              <span className="w-7" />
              <span className="flex-[1.3]">{t('flow.review.colAsset')}</span>
              <span className="hidden flex-1 md:block">{t('flow.review.colUsage')}</span>
              <span className="w-[118px] text-right">{t('flow.review.colOwner')}</span>
            </div>
            <VirtualList
              className="min-h-0 flex-1 py-1"
              items={visible}
              rowHeight={ROW_HEIGHT}
              getKey={(a) => a.id}
              ariaLabel={t('flow.review.title')}
              renderRow={(a) => (
                <div className="flex h-full items-center">
                  <div className="w-full">
                    <AssetRow
                      asset={a}
                      selected={selected.has(a.id)}
                      owner={ownership.get(a.id) ?? 'unknown'}
                      onToggle={toggleSelected}
                    />
                  </div>
                </div>
              )}
              empty={
                <EmptyState
                  icon={<Search size={20} />}
                  title={t('flow.review.noMatch')}
                  description={t('flow.review.noMatchHelp')}
                />
              }
            />
          </>
        )}
      </div>

      {/* Footer */}
      <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-b-xl border border-t-0 border-border-subtle bg-bg-surface/80 px-4 py-3">
        <p className="text-[13px] text-text-secondary">
          <span className="font-semibold tabular-nums text-text-primary">{selectedCount}</span>{' '}
          {t('flow.review.selectedOf').replace('{total}', String(assets.length))}
          {ownCount > 0 && (
            <span className="ml-2 text-text-muted">
              · {t('flow.review.ownHint').replace('{count}', String(ownCount))}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setStep(0)}>
            <ArrowLeft />
            {t('flow.common.back')}
          </Button>
          <Button
            size="lg"
            className="h-9 px-4"
            disabled={selectedCount === 0}
            onClick={() => setStep(2)}
          >
            {t('flow.review.next')}
            <ArrowRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
