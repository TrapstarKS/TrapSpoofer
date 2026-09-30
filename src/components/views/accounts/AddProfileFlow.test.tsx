import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLanguage } from '../../../contexts/LanguageContext';
import { activateProfile } from '../../../services/spoofer';
import { importStudioAccounts } from '../../../services/studioAccounts';
import { DEFAULT_APP_CONFIG, useConfigStore } from '../../../stores/configStore';
import AddProfileFlow from './AddProfileFlow';

vi.mock('../../../services/studioAccounts', () => ({
  importStudioAccounts: vi.fn(),
}));

vi.mock('../../../services/spoofer', () => ({
  activateProfile: vi.fn().mockResolvedValue(undefined),
}));

describe('AddProfileFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLanguage.getState().setLang('pt');
    useConfigStore.setState({
      config: structuredClone(DEFAULT_APP_CONFIG),
      accountSecrets: {},
      secretsLoaded: true,
    });
  });

  it('finishes Studio login without requiring an API key', async () => {
    vi.mocked(importStudioAccounts).mockResolvedValue({
      importedCount: 1,
      importedIds: ['42'],
      currentAccountId: '42',
      activatedId: '42',
      rejectedCount: 0,
      failedCount: 0,
      users: [{ id: 42, name: 'user42', displayName: 'User 42' }],
    });

    render(<AddProfileFlow onFinish={vi.fn()} />);
    fireEvent.click(screen.getByText('Usar o login do Roblox Studio'));

    expect(await screen.findByText('Perfil pronto!')).toBeInTheDocument();
    expect(screen.getByText('Adicionar API Key opcional do Open Cloud')).toBeInTheDocument();
    expect(screen.queryByText('API Key opcional do Open Cloud')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Adicionar API Key opcional do Open Cloud'));
    await waitFor(() =>
      expect(screen.getByText('API Key opcional do Open Cloud')).toBeInTheDocument(),
    );
  });

  it('does not override a later account and group choice after Studio import', async () => {
    let release: (value: Awaited<ReturnType<typeof importStudioAccounts>>) => void = () => {};
    vi.mocked(importStudioAccounts).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<AddProfileFlow onFinish={vi.fn()} />);
    fireEvent.click(screen.getByText('Usar o login do Roblox Studio'));
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        spoofing: {
          ...state.config.spoofing,
          selectedUser: '99',
          selectedGroup: '777',
        },
      },
    }));
    release({
      importedCount: 1,
      importedIds: ['42'],
      currentAccountId: '42',
      activatedId: null,
      rejectedCount: 0,
      failedCount: 0,
      users: [{ id: 42, name: 'user42', displayName: 'User 42' }],
    });

    expect(await screen.findByText('Perfil pronto!')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Concluir'));

    await waitFor(() => expect(activateProfile).not.toHaveBeenCalled());
    expect(useConfigStore.getState().config.spoofing.selectedUser).toBe('99');
    expect(useConfigStore.getState().config.spoofing.selectedGroup).toBe('777');
  });

  it('preserves the current group when the imported profile is already active', async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        accounts: [
          {
            id: '42',
            name: 'User 42',
            isDownloader: true,
            isUploader: false,
            cookieValidated: true,
          },
        ],
        spoofing: {
          ...state.config.spoofing,
          selectedUser: '42',
          selectedGroup: '777',
        },
      },
    }));
    vi.mocked(importStudioAccounts).mockResolvedValue({
      importedCount: 1,
      importedIds: ['42'],
      currentAccountId: '42',
      activatedId: null,
      rejectedCount: 0,
      failedCount: 0,
      users: [{ id: 42, name: 'user42', displayName: 'User 42' }],
    });

    render(<AddProfileFlow onFinish={vi.fn()} />);
    fireEvent.click(screen.getByText('Usar o login do Roblox Studio'));
    expect(await screen.findByText('Perfil pronto!')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Concluir'));

    await waitFor(() => expect(activateProfile).toHaveBeenCalledWith('42', '777'));
  });

  it('honors an explicit post-import choice to activate the imported profile', async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        spoofing: {
          ...state.config.spoofing,
          selectedUser: '99',
          selectedGroup: '777',
        },
      },
    }));
    vi.mocked(importStudioAccounts).mockResolvedValue({
      importedCount: 1,
      importedIds: ['42'],
      currentAccountId: '42',
      activatedId: null,
      rejectedCount: 0,
      failedCount: 0,
      users: [{ id: 42, name: 'user42', displayName: 'User 42' }],
    });

    render(<AddProfileFlow onFinish={vi.fn()} />);
    fireEvent.click(screen.getByText('Usar o login do Roblox Studio'));
    expect(await screen.findByText('Perfil pronto!')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByText('Concluir'));

    await waitFor(() => expect(activateProfile).toHaveBeenCalledWith('42', null));
  });
});
