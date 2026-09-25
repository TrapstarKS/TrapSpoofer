import { useLanguage } from '../../../contexts/LanguageContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog';
import AddProfileFlow from './AddProfileFlow';

export default function AddProfileDialog({
  open,
  onOpenChange,
  reconnect = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnect?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg gap-5 p-6 bg-bg-surface ring-border-subtle">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {reconnect ? t('profiles.dialog.reconnectTitle') : t('profiles.dialog.title')}
          </DialogTitle>
        </DialogHeader>
        {/* Remount on every open so the flow always starts at step 1. */}
        {open && (
          <AddProfileFlow
            onCancel={() => onOpenChange(false)}
            onFinish={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
