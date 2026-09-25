import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Titlebar from './Titlebar';

const { navMocks, spooferState, studioState } = vi.hoisted(() => ({
  navMocks: { goTo: vi.fn(), setConsoleOpen: vi.fn() },
  spooferState: {
    isSpoofing: false,
    isJobPaused: false,
    spoofProgress: 0,
    spoofCurrentCount: 0,
    spoofTotalCount: 0,
    isReplacing: false,
    replaceCurrentCount: 0,
    replaceTotalCount: 0,
    showToast: () => {},
  },
  studioState: { studioConnected: false, studioPlaceName: null as string | null, scanStatus: null },
}));

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('../../contexts/ConfigContext', () => ({
  useConfig: () => ({
    config: {
      general: { hideToTrayOnClose: false },
      debug: { debugMode: false },
      ui: { activeTab: 'spoof' },
    },
    updateConfig: vi.fn(),
  }),
}));

vi.mock('../../contexts/StudioConnectionContext', () => ({
  useStudioConnectionState: () => studioState,
}));

vi.mock('../../stores/spooferStore', () => ({
  useSpooferStore: (selector: (s: typeof spooferState) => unknown) => selector(spooferState),
}));

vi.mock('../app/hooks', () => ({
  useActiveTarget: () => ({
    userId: '1',
    groupId: 'none',
    cookie: 'x'.repeat(60),
    apiKey: '',
    accountName: 'Pedro',
    groupName: null,
  }),
}));

vi.mock('../app/nav', () => ({
  goTo: navMocks.goTo,
  setConsoleOpen: navMocks.setConsoleOpen,
  normalizeTab: (id: string) => id,
}));

describe('Titlebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spooferState.isSpoofing = false;
  });

  it('shows the page title, studio and profile status', () => {
    render(<Titlebar />);
    expect(screen.getByText('shell.nav.spoof')).toBeInTheDocument();
    expect(screen.getByText('shell.studio.disconnected')).toBeInTheDocument();
    expect(screen.getByText('Pedro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'shell.window.close' })).toBeInTheDocument();
  });

  it('opens the accounts page from the profile pill', () => {
    render(<Titlebar />);
    fireEvent.click(screen.getByRole('button', { name: 'shell.profile.title' }));
    expect(navMocks.goTo).toHaveBeenCalledWith('accounts');
  });

  it('toggles the console drawer', () => {
    render(<Titlebar />);
    fireEvent.click(screen.getByRole('button', { name: 'shell.console.toggle' }));
    expect(navMocks.setConsoleOpen).toHaveBeenCalledWith(true);
  });

  it('shows the running job and links to the spoof page', () => {
    spooferState.isSpoofing = true;
    spooferState.spoofCurrentCount = 3;
    spooferState.spoofTotalCount = 10;
    render(<Titlebar />);
    const pill = screen.getByRole('button', { name: 'shell.job.open' });
    expect(pill).toHaveTextContent('3/10');
    fireEvent.click(pill);
    expect(navMocks.goTo).toHaveBeenCalledWith('spoof');
  });
});
