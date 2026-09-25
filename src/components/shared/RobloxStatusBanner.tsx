import { AlertCircle } from 'lucide-react';

import { useLanguage } from '../../contexts/LanguageContext';

interface RobloxStatusBannerProps {
  isVisible: boolean;
}

export function RobloxStatusBanner({ isVisible }: RobloxStatusBannerProps) {
  const { t } = useLanguage();
  return (
    <>
      {isVisible && (
        <div className="w-full px-4 pt-3 shrink-0">
          <div className="rounded-xl border border-danger/30 bg-danger/[0.08] px-4 py-2.5 flex items-center justify-center gap-3">
            <AlertCircle size={18} className="text-danger shrink-0" strokeWidth={2.5} />
            <span className="text-sm font-medium text-danger truncate text-center">
              {t('misc.robloxApiDown')}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
