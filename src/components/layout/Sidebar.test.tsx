import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as LanguageContext from '../../contexts/LanguageContext';
import Sidebar from './Sidebar';

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: vi.fn(),
}));

vi.mock('./ProfilePopup', () => ({
  default: ({ collapsed }: { collapsed?: boolean }) => (
    <div data-testid="profile-popup" data-collapsed={String(Boolean(collapsed))} />
  ),
}));

describe('Sidebar', () => {
  const labels: Record<string, string> = {
    'shell.nav.home': 'Início',
    'shell.nav.spoof': 'Spoofar',
    'shell.nav.accounts': 'Contas',
    'shell.nav.history': 'Histórico',
    'shell.nav.mcp': 'IA / MCP',
    'shell.nav.settings': 'Configurações',
  };
  const mockT = vi.fn((key: string) => labels[key] ?? key);

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(LanguageContext.useLanguage).mockReturnValue({ t: mockT } as any);
  });

  it('renders every main tab plus settings and the profile popup', () => {
    render(<Sidebar activeTab="home" onTabChange={() => {}} />);
    for (const label of Object.values(labels)) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByTestId('profile-popup')).toBeInTheDocument();
  });

  it('calls onTabChange with the tab id', () => {
    const onTabChange = vi.fn();
    render(<Sidebar activeTab="home" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    expect(onTabChange).toHaveBeenCalledWith('settings');
    fireEvent.click(screen.getByRole('button', { name: 'IA / MCP' }));
    expect(onTabChange).toHaveBeenCalledWith('mcp');
  });

  it('marks the active tab with aria-current', () => {
    render(<Sidebar activeTab="history" onTabChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Histórico' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Spoofar' })).not.toHaveAttribute('aria-current');
  });

  it('collapses and passes collapsed to the profile popup', () => {
    render(<Sidebar activeTab="home" onTabChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'shell.nav.collapse' }));
    expect(screen.getByTestId('profile-popup')).toHaveAttribute('data-collapsed', 'true');
  });
});
