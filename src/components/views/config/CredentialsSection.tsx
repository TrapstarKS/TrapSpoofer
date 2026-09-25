import { ArrowRight, Users } from 'lucide-react';

import { useConfig } from '../../../contexts/ConfigContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { Button } from '../../ui/button';

/**
 * Credentials used to be edited in three different places. They now live only
 * on the Contas (profiles) page; this block just points there.
 */
export default function CredentialsSection() {
  const { t } = useLanguage();
  const { updateConfig } = useConfig();

  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Users size={18} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[13px] font-semibold text-text-primary">
          {t('prefs.profilesCard.title')}
        </p>
        <p className="text-[12px] leading-snug text-text-secondary">
          {t('prefs.profilesCard.body')}
        </p>
      </div>
      <Button variant="outline" onClick={() => updateConfig('ui', 'activeTab', 'accounts')}>
        {t('prefs.profilesCard.button')}
        <ArrowRight />
      </Button>
    </div>
  );
}
