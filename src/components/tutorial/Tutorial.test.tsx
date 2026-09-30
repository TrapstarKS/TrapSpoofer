import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLanguage } from '../../contexts/LanguageContext';
import { DEFAULT_APP_CONFIG, useConfigStore } from '../../stores/configStore';
import { OnboardingWizard } from './Tutorial';

vi.mock('../../contexts/StudioConnectionContext', () => ({
  useStudioConnectionState: () => ({
    studioConnected: false,
    studioPlaceName: null,
  }),
}));

describe('OnboardingWizard', () => {
  beforeEach(() => {
    useLanguage.getState().setLang('pt');
    useConfigStore.setState({
      config: {
        ...structuredClone(DEFAULT_APP_CONFIG),
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
          ...DEFAULT_APP_CONFIG.spoofing,
          selectedUser: '42',
        },
      },
      accountSecrets: { '42': { cookie: 's'.repeat(60) } },
      secretsLoaded: true,
    });
  });

  it('treats a valid session as ready without an API key', () => {
    render(<OnboardingWizard onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Começar'));

    expect(screen.getByText('Perfil pronto: User 42')).toBeInTheDocument();
    expect(screen.getByText(/API Keys do Open Cloud são opcionais/)).toBeInTheDocument();
    expect(screen.queryByText(/precisa de uma API Key/)).not.toBeInTheDocument();
  });
});
