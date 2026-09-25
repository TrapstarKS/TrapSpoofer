import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLanguage } from '../../contexts/LanguageContext';
import { useConfigStore } from '../../stores/configStore';
import { TutorialGate } from './TutorialGate';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('../../contexts/StudioConnectionContext', () => ({
  useStudioConnectionState: () => ({
    studioConnected: false,
    scanStatus: null,
    studioPlaceId: '',
    studioPlaceName: null,
  }),
}));

describe('TutorialGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLanguage.getState().setLang('pt');
    useConfigStore.getState().resetConfig();
    useConfigStore.getState().updateConfig('ui', 'tutorialCompleted', false);
  });
  afterEach(() => vi.useRealTimers());

  it('renders nothing once the tutorial is completed', () => {
    useConfigStore.getState().updateConfig('ui', 'tutorialCompleted', true);
    const { container } = render(<TutorialGate />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the wizard on first run and marks it completed when skipped', () => {
    render(<TutorialGate />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText('Bem-vindo ao TrapSpoofer')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Começar'));
    expect(screen.getByText('Crie seu perfil')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Pular guia'));
    expect(useConfigStore.getState().config.ui.tutorialCompleted).toBe(true);
    expect(screen.queryByText('Crie seu perfil')).not.toBeInTheDocument();
  });
});
