import { ClipboardPaste, Loader2, Plus, Replace } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import { parseAssetIds, parseMappings } from '../../services/assets';
import { useSpooferStore } from '../../stores/spooferStore';
import { logIsm } from '../../utils/robloxProfiles';
import { queueStudioReplacements } from '../../utils/studioBridge';
import { submitManualIds } from '../app/spoof/actions';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

/**
 * "Colar IDs" dialog. `add` feeds ids into the current session (service
 * `addManualIds`); `replace` sends ready-made old -> new pairs straight to
 * the Studio plugin.
 */
export default function PasteIdsModal({
  open,
  onOpenChange,
  initialMode = 'add',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: 'add' | 'replace';
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<'add' | 'replace'>(initialMode);
  const [rawInput, setRawInput] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useSpooferStore((s) => s.showToast);

  const ids = useMemo(() => parseAssetIds(rawInput), [rawInput]);
  const pairs = useMemo(() => parseMappings(rawInput), [rawInput]);
  const pairCount = Object.keys(pairs).length;
  const count = mode === 'add' ? ids.length : pairCount;

  const handleApply = async () => {
    if (count === 0) return;
    setBusy(true);
    try {
      if (mode === 'add') {
        const added = await submitManualIds(rawInput);
        if (added === 0) return;
      } else {
        await queueStudioReplacements(pairs);
        logIsm('success', t('flow.paste.sent').replace('{count}', String(pairCount)), false);
        showToast('success', t('flow.paste.sent').replace('{count}', String(pairCount)));
      }
      setRawInput('');
      onOpenChange(false);
    } catch (e) {
      showToast(
        'error',
        `${t('flow.paste.sendFailed')} ${e instanceof Error ? e.message : String(e)}`,
        7000,
      );
    } finally {
      setBusy(false);
    }
  };

  const tabClass = (active: boolean) =>
    cn(
      'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md py-1.5 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
      active
        ? 'bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--border-strong)]'
        : 'text-text-muted hover:text-text-primary',
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border-subtle bg-bg-surface sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <ClipboardPaste size={17} className="text-brand" />
            {t('flow.paste.title')}
          </DialogTitle>
        </DialogHeader>

        <div
          className="flex gap-1 rounded-lg border border-border-subtle bg-bg-base/60 p-1"
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'add'}
            onClick={() => setMode('add')}
            className={tabClass(mode === 'add')}
          >
            <Plus size={14} />
            {t('flow.paste.addTab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'replace'}
            onClick={() => setMode('replace')}
            className={tabClass(mode === 'replace')}
          >
            <Replace size={14} />
            {t('flow.paste.replaceTab')}
          </button>
        </div>

        <p className="text-[13px] leading-relaxed text-text-muted">
          {mode === 'add' ? t('flow.paste.addHelp') : t('flow.paste.replaceHelp')}
        </p>

        <textarea
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          placeholder={
            mode === 'add'
              ? '123456789\nrbxassetid://987654321'
              : '12345678 -> 87654321\n11111111 = 22222222'
          }
          aria-label={t('flow.paste.title')}
          spellCheck={false}
          className="h-48 w-full resize-none rounded-xl border border-border-strong bg-bg-base/50 p-3 font-mono text-[12.5px] text-text-primary outline-none placeholder:text-text-muted/60 focus:border-brand/50 focus:ring-2 focus:ring-brand/15"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12.5px] text-text-muted">
            {count > 0
              ? (mode === 'add' ? t('flow.paste.idsReady') : t('flow.paste.pairsReady')).replace(
                  '{count}',
                  String(count),
                )
              : t('flow.paste.nothingYet')}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('flow.common.cancel')}
            </Button>
            <Button onClick={() => void handleApply()} disabled={count === 0 || busy}>
              {busy && <Loader2 className="animate-spin" />}
              {mode === 'add' ? t('flow.paste.addAction') : t('flow.paste.replaceAction')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
