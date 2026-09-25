import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useConfigStore } from '../../../stores/configStore';
import AccountsView from './AccountsView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

describe('AccountsView', () => {
  beforeEach(() => {
    useLanguage.getState().setLang('pt');
    useConfigStore.getState().resetConfig();
    useConfigStore.setState({ accountSecrets: {}, secretsLoaded: true });
  });

  it('shows the empty state and opens the guided add-profile flow', async () => {
    render(<AccountsView />);
    expect(screen.getByText('Nenhum perfil ainda')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByText('Adicionar perfil')[0]);
    });
    expect(await screen.findByText('Usar o login do Roblox Studio')).toBeInTheDocument();
  });

  it('renders a profile card with status chips and removes it with its secrets', async () => {
    useConfigStore.getState().updateAccountsList([
      {
        id: '42',
        name: 'Pedro',
        isDownloader: true,
        isUploader: true,
        cookieValidated: true,
      },
    ]);
    useConfigStore.setState({ accountSecrets: { '42': { cookie: 'c'.repeat(60), apiKey: '' } } });
    render(<AccountsView />);
    expect(screen.getByText('Pedro')).toBeInTheDocument();
    expect(screen.getByText('Sessão ok')).toBeInTheDocument();
    expect(screen.getByText('API Key faltando')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remover'));
    await act(async () => {
      fireEvent.click(screen.getByText('Sim, remover'));
    });
    expect(useConfigStore.getState().config.accounts).toHaveLength(0);
    expect(useConfigStore.getState().accountSecrets['42']).toEqual({
      cookie: '',
      apiKey: '',
      groupApiKey: '',
    });
  });
});
