import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useLanguage } from '../../contexts/LanguageContext';
import { getActiveTarget } from '../../services/spoofer';
import { DEFAULT_APP_CONFIG, useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSpooferStore } from '../../stores/spooferStore';
import { useUpdaterStore } from '../../stores/updaterStore';
import UploadAuthNotice from './UploadAuthNotice';

describe('UploadAuthNotice', () => {
  beforeEach(() => {
    useLanguage.getState().setLang('pt');
    const config = structuredClone(DEFAULT_APP_CONFIG);
    config.accounts = [
      { id: '111', name: 'Fixture', isDownloader: true, isUploader: false, cookieValidated: true },
    ];
    config.spoofing.selectedUser = '111';
    useConfigStore.setState({
      config,
      secretsLoaded: true,
      importingStudioAccounts: false,
      accountSecrets: {},
    });
    useSpooferStore.setState({
      isPreparingJob: false,
      isSpoofing: false,
      isScanningStudio: false,
      isReplacing: false,
      isGrantingPermissions: false,
      isDiscoveringPlaceIds: false,
      parsingFileName: null,
    });
    useSessionStore.setState({ scanPhase: 'idle' });
    useUpdaterStore.setState({ status: 'idle' });
  });

  it('shows optional personal and group session guidance without an error', () => {
    const { rerender } = render(<UploadAuthNotice accountId="111" />);
    expect(screen.getByText(/A API key pessoal é opcional/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(<UploadAuthNotice accountId="111" groupId="222" />);
    expect(screen.getByText(/A API key do grupo é opcional/)).toBeInTheDocument();
    expect(screen.getByText(/API key não garante envio mais rápido/)).toBeInTheDocument();
  });

  it('changes actual authentication while retaining saved keys and keeping them out of the UI', () => {
    useConfigStore.setState({ accountSecrets: { '111': { apiKey: 'private-fixture-value' } } });
    render(<UploadAuthNotice accountId="111" />);
    expect(getActiveTarget().apiKey).toBe('private-fixture-value');
    fireEvent.click(screen.getByRole('switch'));
    expect(getActiveTarget().apiKey).toBe('');
    expect(useConfigStore.getState().accountSecrets['111'].apiKey).toBe('private-fixture-value');
    expect(screen.getByText('Sessão Roblox · sem API key')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private-fixture-value');
  });

  it('locks the auth choice when a job starts', () => {
    render(<UploadAuthNotice accountId="111" />);
    act(() => useSpooferStore.setState({ isSpoofing: true }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('switch'));
    expect(useConfigStore.getState().config.accounts[0].uploadAuthMode).toBeUndefined();
  });

  it('shows a known rejected group key only while that key is selected', () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        accounts: state.config.accounts.map((account) => ({
          ...account,
          groupApiKeyValidated: false,
        })),
      },
      accountSecrets: { '111': { groupApiKey: 'group-fixture' } },
    }));
    render(<UploadAuthNotice accountId="111" groupId="222" />);
    expect(screen.getByRole('alert')).toHaveTextContent('A chave selecionada foi recusada');
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Sessão Roblox · sem API key')).toBeInTheDocument();
  });
});
