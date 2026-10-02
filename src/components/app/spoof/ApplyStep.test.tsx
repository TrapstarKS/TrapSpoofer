import { save } from '@tauri-apps/plugin-dialog';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLanguage } from '../../../contexts/LanguageContext';
import {
  recoverFailed,
  retryFailed,
  type RunResult,
  writeSpoofedFile,
} from '../../../services/spoofer';
import { useConfigStore } from '../../../stores/configStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSpooferStore } from '../../../stores/spooferStore';
import type { SpooferAssetResult } from '../../../types/tauriEvents';
import { isTauriRuntime } from '../../../utils/tauriRuntime';
import ApplyStep from './ApplyStep';
import { useFlowStore } from './flowStore';
import SpoofPage from './SpoofPage';

vi.mock('../../../services/spoofer', () => ({
  recoverFailed: vi.fn(),
  retryFailed: vi.fn(),
  runSpoof: vi.fn(),
  pushToStudio: vi.fn(),
  writeSpoofedFile: vi.fn(),
}));

vi.mock('../../../contexts/StudioConnectionContext', () => ({
  useStudioConnectionState: () => ({ studioConnected: true }),
}));

vi.mock('../../../utils/tauriRuntime', () => ({ isTauriRuntime: vi.fn(() => false) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('./SourceStep', () => ({ default: () => <p>Choose source</p> }));
vi.mock('./ReviewStep', () => ({ default: () => <p>Review assets</p> }));
vi.mock('./SendStep', () => ({ default: () => <p>Upload progress</p> }));

const completed: SpooferAssetResult = {
  id: '10001',
  name: 'Completed animation',
  success: true,
  newId: '20001',
};
const failed: SpooferAssetResult = {
  id: '10002',
  name: 'Failed animation',
  success: false,
  errorReason: 'Download failed',
};
const cancelled: SpooferAssetResult = {
  id: '10003',
  name: 'Cancelled animation',
  success: false,
  cancelled: true,
};
const skipped: SpooferAssetResult = {
  id: '10004',
  name: 'Skipped animation',
  success: false,
  skipped: true,
};
const started: RunResult = { ok: true, count: 1, warnings: [] };

describe('final-result failed asset recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    vi.mocked(recoverFailed).mockResolvedValue(started);
    vi.mocked(retryFailed).mockResolvedValue(started);
    useLanguage.getState().setLang('en');
    useConfigStore.setState(useConfigStore.getInitialState(), true);
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    useSpooferStore.setState(useSpooferStore.getInitialState(), true);
    useFlowStore.setState({ ...useFlowStore.getInitialState(), step: 3 }, true);
    useConfigStore.getState().updateCategory('spoofing', { downloadOnly: false });
    useSessionStore.setState({
      source: { kind: 'file', label: 'Example.rbxl', filePath: '/tmp/Example.rbxl', scannedAt: 0 },
    });
    useSpooferStore.setState({
      lastAssetResults: [completed, failed, cancelled, skipped],
      lastReplacements: { '10001': '20001' },
    });
  });

  it('starts recovery only on its explicit click and keeps ordinary Retry separate', async () => {
    const view = render(<ApplyStep />);
    const recovery = screen.getByRole('button', { name: 'Recover failed assets' });
    expect(recovery).toBeEnabled();
    expect(recovery).toHaveAccessibleDescription(
      'Tries to recover only failed assets. It may take longer and may not succeed. Completed assets are kept.',
    );
    view.rerender(<ApplyStep />);
    expect(recoverFailed).not.toHaveBeenCalled();
    expect(retryFailed).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(retryFailed).toHaveBeenCalledExactlyOnceWith();
    expect(recoverFailed).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(recovery));
    expect(recoverFailed).toHaveBeenCalledExactlyOnceWith();
    expect(retryFailed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save spoofed file' })).toBeEnabled();
    expect(screen.getByText('20001')).toBeInTheDocument();
  });

  it('shows only real failed rows and counts failures without a success flag', () => {
    useSpooferStore.setState({
      lastAssetResults: [
        completed,
        failed,
        cancelled,
        skipped,
        { id: '10005', name: 'Other failure', reason: 'Could not download' },
      ],
    });
    render(<ApplyStep />);
    const panel = screen.getByRole('heading', { name: '2 assets failed' }).closest('section')!;
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    expect(within(panel).getByText('Download failed')).toBeInTheDocument();
    expect(within(panel).getByText('Could not download')).toBeInTheDocument();
    expect(within(panel).queryByText(/Completed animation/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Cancelled animation/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Skipped animation/)).not.toBeInTheDocument();
  });

  it.each([
    ['empty', []],
    ['successful', [completed]],
    ['cancelled', [cancelled]],
    ['skipped', [skipped]],
    ['mixed without failures', [completed, cancelled, skipped]],
  ] as const)('hides recovery for %s results', (_label, results) => {
    useSpooferStore.setState({ lastAssetResults: [...results] });
    render(<ApplyStep />);
    expect(screen.queryByRole('button', { name: 'Recover failed assets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(recoverFailed).not.toHaveBeenCalled();
  });

  it.each(['isPreparingJob', 'isSpoofing', 'isReplacing'] as const)(
    'blocks both actions while %s and does not recover automatically when it finishes',
    (flag) => {
      render(<ApplyStep />);
      const recovery = screen.getByRole('button', { name: 'Recover failed assets' });
      const retry = screen.getByRole('button', { name: 'Try again' });
      act(() => useSpooferStore.setState({ [flag]: true }));
      expect(recovery).toBeDisabled();
      expect(retry).toBeDisabled();
      fireEvent.click(recovery);
      fireEvent.click(retry);
      expect(recoverFailed).not.toHaveBeenCalled();
      expect(retryFailed).not.toHaveBeenCalled();
      act(() => useSpooferStore.setState({ [flag]: false }));
      expect(recovery).toBeEnabled();
      expect(retry).toBeEnabled();
      expect(recoverFailed).not.toHaveBeenCalled();
    },
  );

  it('blocks repeated clicks until the manual launch resolves', async () => {
    let resolve!: (result: RunResult) => void;
    vi.mocked(recoverFailed).mockReturnValueOnce(
      new Promise<RunResult>((done) => {
        resolve = done;
      }),
    );
    render(<ApplyStep />);
    const recovery = screen.getByRole('button', { name: 'Recover failed assets' });
    const retry = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(recovery);
    expect(recovery).toBeDisabled();
    expect(retry).toBeDisabled();
    fireEvent.click(recovery);
    fireEvent.click(retry);
    expect(recoverFailed).toHaveBeenCalledTimes(1);
    expect(retryFailed).not.toHaveBeenCalled();
    await act(async () => resolve(started));
    expect(recovery).toBeEnabled();
    expect(retry).toBeEnabled();
  });

  it.each([0, 1, 2] as const)('does not offer recovery before the final step (%s)', (step) => {
    useFlowStore.setState({ step });
    render(<SpoofPage />);
    expect(screen.queryByRole('button', { name: 'Recover failed assets' })).not.toBeInTheDocument();
    expect(recoverFailed).not.toHaveBeenCalled();
  });

  it('hides the final-result action while the wizard shows an active job', () => {
    render(<SpoofPage />);
    expect(screen.getByRole('button', { name: 'Recover failed assets' })).toBeEnabled();
    act(() => useSpooferStore.setState({ isSpoofing: true }));
    expect(screen.getByText('Upload progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover failed assets' })).not.toBeInTheDocument();
    expect(recoverFailed).not.toHaveBeenCalled();
  });

  it('shows a failed launch without discarding successful mappings or retrying automatically', async () => {
    vi.mocked(recoverFailed).mockRejectedValueOnce(new Error('Recovery could not start'));
    render(<ApplyStep />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Recover failed assets' })),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Recovery could not start');
    expect(screen.getByText('20001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recover failed assets' })).toBeEnabled();
    expect(recoverFailed).toHaveBeenCalledTimes(1);
  });

  it('explains the manual action in Portuguese', () => {
    useLanguage.getState().setLang('pt');
    render(<ApplyStep />);
    expect(
      screen.getByRole('button', { name: 'Recuperar assets com falha' }),
    ).toHaveAccessibleDescription(
      'Tenta recuperar só os assets que falharam. Pode demorar mais e não funcionar. Os assets concluídos são mantidos.',
    );
  });

  it('reports a failed native clip separately from successfully saved replacements', async () => {
    const showToast = vi.fn();
    const result = {
      outputPath: '/tmp/Example_spoofed.rbxl',
      patchesApplied: 1,
      patchesFailed: 1,
      warnings: ['Native clip unavailable; original Animation preserved.'],
    };
    useSpooferStore.setState({ showToast });
    vi.mocked(writeSpoofedFile).mockImplementation(async () => {
      useSessionStore.getState().setLastFileWrite(result);
      return result;
    });
    render(<ApplyStep />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save spoofed file' })),
    );
    expect(showToast).toHaveBeenCalledWith('info', expect.stringContaining('1 failed'));
    expect(showToast).not.toHaveBeenCalledWith('success', expect.any(String));
    expect(screen.getByText(result.warnings[0])).toBeInTheDocument();
    expect(screen.getByText(result.outputPath)).toBeInTheDocument();
  });

  it.each(['rbxm', 'rbxl', 'rbxmx', 'rbxlx'])(
    'keeps the original .%s download target after the selected source changes',
    async (extension) => {
      const original = {
        kind: 'file' as const,
        label: `Original.${extension}`,
        filePath: `/tmp/Original.${extension}`,
        scannedAt: 1,
      };
      useSpooferStore.setState({ lastJobSource: original });
      useSessionStore.setState({
        source: { kind: 'studio', label: 'Another Studio window', scannedAt: 2 },
      });
      vi.mocked(isTauriRuntime).mockReturnValue(true);
      vi.mocked(save).mockResolvedValue(`/tmp/Original_spoofed.${extension}`);
      vi.mocked(writeSpoofedFile).mockResolvedValue({
        outputPath: `/tmp/Original_spoofed.${extension}`,
        patchesApplied: 1,
        patchesFailed: 0,
        warnings: [],
      });
      render(<ApplyStep />);
      expect(
        screen.getByText(
          `Creates a copy of Original.${extension} with the selected replacements and animation mode. The original stays untouched.`,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apply in Studio' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save spoofed file' }));
      await waitFor(() =>
        expect(writeSpoofedFile).toHaveBeenCalledExactlyOnceWith({
          outputPath: `/tmp/Original_spoofed.${extension}`,
        }),
      );
      expect(save).toHaveBeenCalledExactlyOnceWith({
        defaultPath: `/tmp/Original_spoofed.${extension}`,
        filters: [{ name: 'Roblox', extensions: [extension] }],
      });
      expect(recoverFailed).not.toHaveBeenCalled();
    },
  );
});
