import { Info, SlidersHorizontal, UploadCloud, Wrench } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '../../lib/utils';
import ExclusionsSection from './config/ExclusionsSection';
import RoutingSection from './config/RoutingSection';
import UploadSection from './config/UploadSection';
import AdvancedSection from './settings/AdvancedSection';
import AppearanceCard from './settings/AppearanceCard';
import BehaviorCard from './settings/BehaviorCard';
import CredentialsCard from './settings/CredentialsCard';
import DangerCard from './settings/DangerCard';
import DebugCard from './settings/DebugCard';
import PermissionsCard from './settings/PermissionsCard';

type SectionId = 'general' | 'uploads' | 'advanced';

export default function SettingsView() {
  const { t } = useLanguage();
  const [section, setSection] = useState<SectionId>('general');

  const sections: { id: SectionId; label: string; desc: string; icon: ReactNode }[] = [
    {
      id: 'general',
      label: t('prefs.nav.general'),
      desc: t('prefs.nav.generalDesc'),
      icon: <SlidersHorizontal size={16} />,
    },
    {
      id: 'uploads',
      label: t('prefs.nav.uploads'),
      desc: t('prefs.nav.uploadsDesc'),
      icon: <UploadCloud size={16} />,
    },
    {
      id: 'advanced',
      label: t('prefs.nav.advanced'),
      desc: t('prefs.nav.advancedDesc'),
      icon: <Wrench size={16} />,
    },
  ];

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6 pb-16 lg:p-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            {t('prefs.title')}
          </h1>
          <p className="text-[13px] text-text-secondary">{t('prefs.subtitle')}</p>
        </header>

        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <nav
            aria-label={t('prefs.title')}
            className="flex shrink-0 gap-1 md:sticky md:top-0 md:w-56 md:flex-col"
          >
            {sections.map((s) => {
              const selected = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => setSection(s.id)}
                  className={cn(
                    'flex flex-1 items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors md:flex-none',
                    selected
                      ? 'bg-bg-elevated text-text-primary'
                      : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary',
                  )}
                >
                  <span
                    className={cn('mt-0.5 shrink-0', selected ? 'text-primary' : 'text-text-muted')}
                  >
                    {s.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold">{s.label}</span>
                    <span className="hidden text-[11.5px] leading-snug text-text-muted md:block">
                      {s.desc}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-5">
            {section === 'general' && (
              <>
                <CredentialsCard />
                <AppearanceCard />
                <BehaviorCard />
              </>
            )}
            {section === 'uploads' && (
              <>
                <UploadSection />
                <PermissionsCard />
              </>
            )}
            {section === 'advanced' && (
              <>
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3">
                  <Info size={15} className="mt-0.5 shrink-0 text-amber-500" />
                  <p className="text-[12.5px] leading-relaxed text-text-secondary">
                    {t('prefs.advancedNote')}
                  </p>
                </div>
                <RoutingSection />
                <ExclusionsSection />
                <AdvancedSection />
                <DebugCard />
                <DangerCard />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
