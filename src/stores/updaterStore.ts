import { create } from 'zustand';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'installed'
  | 'error';

export const useUpdaterStore = create<{
  status: UpdateStatus;
  version: string;
  downloaded: number;
  total: number;
  error: string;
  lastCheckedAt: number;
}>(() => ({ status: 'idle', version: '', downloaded: 0, total: 0, error: '', lastCheckedAt: 0 }));

export function assertAppIsNotUpdating() {
  const status = useUpdaterStore.getState().status;
  if (status === 'installing' || status === 'installed')
    throw new Error(
      'The app is installing an update. Restart it before starting another operation.',
    );
}
