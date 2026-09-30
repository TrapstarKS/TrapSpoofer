import type { AppConfig } from '../stores/configStore';

export type UploadAuthMode = 'auto' | 'session';
export type UploadAuthMethod = 'session' | 'personal_key' | 'group_key';

interface SavedUploadKeys {
  apiKey?: string;
  groupApiKey?: string;
}

export function resolveUploadAuth({
  groupId,
  apiKey,
  groupApiKey,
  mode = 'auto',
}: SavedUploadKeys & { groupId?: string | null; mode?: UploadAuthMode }) {
  const isGroup = Boolean(groupId && groupId !== 'none');
  const personal = apiKey?.trim() ?? '';
  const group = groupApiKey?.trim() ?? '';
  let method: UploadAuthMethod = 'session';
  let key = '';
  if (mode !== 'session') {
    if (isGroup && group) {
      method = 'group_key';
      key = group;
    } else if (personal) {
      method = 'personal_key';
      key = personal;
    }
  }
  return { method, apiKey: key, isGroup };
}

export function profileUploadAuth(
  config: AppConfig,
  accountSecrets: Record<string, SavedUploadKeys>,
  accountId: string,
  groupId: string | null = 'none',
) {
  const profile = config.accounts.find((account) => account.id === accountId);
  const stored = accountSecrets[accountId] ?? {};
  const active = config.spoofing.selectedUser === accountId ? config.spoofing : undefined;
  return resolveUploadAuth({
    groupId,
    apiKey: active?.apiKey?.trim() || stored.apiKey,
    groupApiKey: active?.groupApiKey?.trim() || stored.groupApiKey,
    mode: profile?.uploadAuthMode,
  });
}

export function uploadAuthNoticeKey(auth: ReturnType<typeof resolveUploadAuth>) {
  if (auth.method === 'session') return auth.isGroup ? 'sessionGroup' : 'sessionPersonal';
  if (auth.method === 'group_key') return 'groupKey';
  return auth.isGroup ? 'personalKeyForGroup' : 'personalKey';
}
