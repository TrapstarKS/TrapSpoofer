import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useConfigStore } from '../../../stores/configStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import RunningPanel from './RunningPanel';

describe('recovery progress', () => {
  beforeEach(() => {
    useConfigStore.setState(useConfigStore.getInitialState(), true);
    useSpooferStore.setState(
      {
        ...useSpooferStore.getInitialState(),
        isSpoofing: true,
        activeSpooferJobId: 'job',
        assetStatuses: {
          '10001': { stage: 'recovering', message: 'recovering' },
          '10002': { stage: 'queued' },
          '10003': { stage: 'done' },
        },
        assetMetadataMap: {
          '10001': { name: 'Failed animation', type: 'animation' },
          '10002': { name: 'Queued animation', type: 'animation' },
          '10003': { name: 'Completed animation', type: 'animation' },
        },
      },
      true,
    );
  });

  afterEach(cleanup);

  it.each([
    ['en', 'Recovering…', 'In progress', 'Downloading…', 'Done'],
    ['pt', 'Recuperando…', 'Em andamento', 'Baixando…', 'Concluídos'],
  ])('shows recovery in the active list in %s', (language, recovery, active, download, done) => {
    useLanguage.getState().setLang(language);
    render(<RunningPanel />);
    expect(screen.getByText(recovery)).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: `${active}1` }));
    expect(screen.getByText('Failed animation')).toBeVisible();
    expect(screen.getByText(recovery)).toBeVisible();
    expect(screen.queryByText('Queued animation')).not.toBeInTheDocument();
    expect(screen.queryByText('Completed animation')).not.toBeInTheDocument();

    act(() => useSpooferStore.getState().setAssetStatus('10001', { stage: 'downloading' }));
    expect(screen.getByText(download)).toBeVisible();
    expect(screen.queryByText(recovery)).not.toBeInTheDocument();

    act(() => useSpooferStore.getState().setAssetStatus('10001', { stage: 'done' }));
    expect(screen.queryByText('Failed animation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: `${done}2` }));
    expect(screen.getByText('Failed animation')).toBeVisible();
    expect(screen.getByText('Completed animation')).toBeVisible();
  });
});
