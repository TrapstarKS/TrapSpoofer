import { AlertTriangle } from 'lucide-react';

import { useLanguage } from '../../contexts/LanguageContext';
import { usePortDiagnostic } from '../../hooks/usePortDiagnostic';

export function PortDiagnosticBanner() {
  const { t } = useLanguage();
  const diag = usePortDiagnostic();
  const visible = Boolean(diag && (diag.failed || diag.extended));

  return (
    <>
      {visible && diag && (
        <div className="w-full px-4 pt-3 shrink-0">
          <div className="rounded-xl border border-warning/30 bg-warning/[0.08] px-4 py-2.5 flex items-start gap-3">
            <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" strokeWidth={2.5} />
            <div className="text-sm text-foreground space-y-1">
              {diag.failed ? (
                <span className="font-medium">{t('misc.portDiagnosticFailed')}</span>
              ) : (
                <>
                  <span className="font-medium">
                    {t('misc.portDiagnosticExtended').replace('{port}', String(diag.boundPort))}
                  </span>
                  {diag.defaultsOccupied.length > 0 && (
                    <span className="block text-muted-foreground">
                      {t('misc.portDiagnosticOccupied').replace(
                        '{processes}',
                        diag.defaultsOccupied.map((o) => o.exe).join(', '),
                      )}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
