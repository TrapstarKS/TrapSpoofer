import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as LanguageContext from '../../contexts/LanguageContext';
import ActivityView from './ActivityView';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: vi.fn(),
}));

vi.mock('../../stores/spooferStore', () => ({
  useSpooferStore: (selector: (s: { spoofCompletionVersion: number }) => unknown) =>
    selector({ spoofCompletionVersion: 0 }),
}));

const job = {
  id: '1',
  status: 'partially_finished',
  startTime: '2026-09-20T12:00:00Z',
  endTime: '2026-09-20T12:01:00Z',
  durationMs: 60000,
  account: { id: '1', name: 'TestUser', avatarUrl: '' },
  assetResults: [
    { id: '123456', name: 'Walk', success: true, newId: '999999' },
    { id: '654321', name: 'Run', success: false, errorReason: 'Private asset' },
  ],
  config: { assets: '[]', spoofSounds: false, downloadOnly: false },
  logFilePath: '',
};

describe('ActivityView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(LanguageContext.useLanguage).mockReturnValue({
      t: (key: string) => key,
      lang: 'en',
    } as any);
  });

  it('renders the job list and expands a job', async () => {
    vi.mocked(invoke).mockResolvedValue([job]);
    render(<ActivityView />);

    const header = await screen.findByText('history.to');
    fireEvent.click(header);

    expect(await screen.findByText('Walk')).toBeInTheDocument();
    expect(screen.getByText('Private asset')).toBeInTheDocument();
    expect(screen.getByText('history.redo')).toBeInTheDocument();
    expect(screen.getByText('history.retryFailed')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<ActivityView />);
    expect(await screen.findByText('history.empty')).toBeInTheDocument();
  });
});
