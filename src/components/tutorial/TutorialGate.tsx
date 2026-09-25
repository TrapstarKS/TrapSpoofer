import { useCallback, useEffect, useState } from 'react';

import { useConfigStore } from '../../stores/configStore';
import { OnboardingWizard } from './Tutorial';

/** Fired by Settings > "Abrir guia" to show the wizard again. */
const START_EVENT = 'ism-start-tutorial';

/**
 * Rendered once by the app. Shows the first-run wizard while
 * `config.ui.tutorialCompleted` is false; renders nothing otherwise.
 */
export const TutorialGate = () => {
  const completed = useConfigStore((s) => s.config.ui.tutorialCompleted);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (completed) {
      setOpen(false);
      return;
    }
    // Small delay so the app shell paints first.
    const timer = setTimeout(() => setOpen(true), 400);
    return () => clearTimeout(timer);
  }, [completed]);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(START_EVENT, handler);
    return () => window.removeEventListener(START_EVENT, handler);
  }, []);

  const handleClose = useCallback(
    (tab?: 'spoof' | 'home') => {
      setOpen(false);
      updateConfig('ui', 'tutorialCompleted', true);
      if (tab) updateConfig('ui', 'activeTab', tab);
    },
    [updateConfig],
  );

  if (!open) return null;
  return <OnboardingWizard onClose={handleClose} />;
};
