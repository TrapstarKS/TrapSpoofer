import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLanguage } from '../../../contexts/LanguageContext';
import { useConfigStore } from '../../../stores/configStore';
import UploadSection from './UploadSection';

const { updateConfig } = vi.hoisted(() => ({ updateConfig: vi.fn() }));

vi.mock('../../../contexts/ConfigContext', () => ({
  useConfig: () => ({ config: useConfigStore.getState().config, updateConfig }),
}));

describe('UploadSection failed asset recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLanguage.getState().setLang('en');
    useConfigStore.setState(useConfigStore.getInitialState(), true);
  });

  it.each([false, true])(
    'offers information rather than a persistent toggle with legacy recovery set to %s',
    (enabled) => {
      useConfigStore.getState().updateCategory('advanced', { enableArchiveRecovery: enabled });
      const view = render(<UploadSection />);
      expect(screen.getByText('Failed asset recovery')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Available in the final results when assets fail. Recovery starts only when you choose it there.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: /recover/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /recover/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('switch')).toHaveLength(2);
      view.rerender(<UploadSection />);
      expect(updateConfig).not.toHaveBeenCalled();
    },
  );

  it('keeps the remaining upload preferences editable', () => {
    const checked = useConfigStore.getState().config.advanced.skipOwned;
    render(<UploadSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Skip assets you already own' }));
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith('advanced', 'skipOwned', !checked);
    const animationMode = screen.getByRole('combobox', {
      name: 'Animation replacement (Studio and files)',
    });
    fireEvent.change(animationMode, { target: { value: 'clip_parent' } });
    expect(updateConfig).toHaveBeenLastCalledWith('spoofing', 'animationMode', 'clip_parent');
    fireEvent.change(animationMode, { target: { value: 'clip_parent_id' } });
    expect(updateConfig).toHaveBeenLastCalledWith('spoofing', 'animationMode', 'clip_parent_id');
  });
});
