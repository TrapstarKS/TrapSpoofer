/**
 * Profile helpers shared by the Contas page, the sidebar ProfilePopup and the
 * first-run onboarding. Switching the active profile always goes through
 * `activateProfile` from the spoofer service.
 */
import { invoke } from '@tauri-apps/api/core';

import { activateProfile, clearActiveProfile } from '../../../services/spoofer';
import { type AppConfig, useConfigStore } from '../../../stores/configStore';
import {
  detectCookie,
  normalizeId,
  type RobloxUserInfo,
  validateCookieProfile,
} from '../../../utils/robloxProfiles';
import { isTauriRuntime } from '../../../utils/tauriRuntime';

export type Profile = AppConfig['accounts'][number];

/** Any screen can open the add-profile dialog on the Contas page with this event. */
export const ADD_PROFILE_EVENT = 'ts-add-profile';

export const API_KEY_DASHBOARD_URL = 'https://create.roblox.com/dashboard/credentials';

export type SessionStatus = 'ok' | 'expired' | 'missing' | 'unchecked';
export type KeyStatus = 'ok' | 'invalid' | 'missing' | 'unchecked';

export function sessionStatus(profile: Profile, cookie: string | undefined): SessionStatus {
  if (!cookie?.trim()) return 'missing';
  if (profile.cookieValidated === true) return 'ok';
  if (profile.cookieValidated === false) return 'expired';
  return 'unchecked';
}

export function keyStatus(profile: Profile, apiKey: string | undefined): KeyStatus {
  if (!apiKey?.trim()) return 'missing';
  if (profile.apiKeyValidated === true) return 'ok';
  if (profile.apiKeyValidated === false) return 'invalid';
  return 'unchecked';
}

export function profileNeedsAttention(profile: Profile): boolean {
  const secrets = useConfigStore.getState().accountSecrets[profile.id];
  const s = sessionStatus(profile, secrets?.cookie);
  const k = keyStatus(profile, secrets?.apiKey);
  return s === 'expired' || s === 'missing' || k === 'invalid' || k === 'missing';
}

export async function openExternal(url: string) {
  if (isTauriRuntime()) {
    await invoke('open_external', { url }).catch(() => window.open(url, '_blank'));
  } else {
    window.open(url, '_blank');
  }
}

/** Detect the Roblox Studio login and validate it. Returns null when not found. */
export async function detectStudioSession(): Promise<{
  user: RobloxUserInfo;
  cookie: string;
} | null> {
  const cookie = await detectCookie('studio');
  if (!cookie) return null;
  return validateCookieProfile(cookie);
}

export async function validateCookie(cookie: string) {
  return validateCookieProfile(cookie);
}

export type KeyCheck =
  | { state: 'ok'; ownerUserId: string | null }
  | { state: 'invalid'; message: string }
  | { state: 'unknown'; message: string };

export async function checkApiKey(key: string): Promise<KeyCheck> {
  const trimmed = key.trim();
  if (trimmed.length < 20) return { state: 'invalid', message: 'too short' };
  if (!isTauriRuntime()) return { state: 'ok', ownerUserId: null };
  try {
    const result = await invoke<{ ok: boolean; ownerUserId?: string | null; message?: string }>(
      'detect_opencloud_api_key_owner',
      { key: trimmed },
    );
    if (result.ok) return { state: 'ok', ownerUserId: result.ownerUserId ?? null };
    const message = result.message || '';
    if (/invalid|unauthori[sz]ed|forbidden|401|403/i.test(message)) {
      return { state: 'invalid', message };
    }
    return { state: 'unknown', message: message || 'no details' };
  } catch (error) {
    return { state: 'unknown', message: String(error) };
  }
}

/** Re-sync the spoofing config copy of the secrets when the active profile changed. */
async function resyncIfActive(accountId: string) {
  const { config } = useConfigStore.getState();
  if (config.spoofing.selectedUser !== accountId) return;
  const group = config.spoofing.selectedGroup;
  await activateProfile(accountId, group === 'none' ? null : group);
}

/** Insert or update a profile from a validated session. */
export async function upsertProfileFromSession(user: RobloxUserInfo, cookie: string) {
  const store = useConfigStore.getState();
  const id = normalizeId(user.id);
  const name = user.displayName || user.name || id;
  const accounts = [...store.config.accounts];
  const idx = accounts.findIndex((a) => normalizeId(a.id) === id);
  if (idx >= 0) {
    accounts[idx] = {
      ...accounts[idx],
      name,
      avatarUrl: user.avatarUrl || accounts[idx].avatarUrl,
      isDownloader: true,
      cookieValidated: true,
    };
  } else {
    accounts.push({
      id,
      name,
      avatarUrl: user.avatarUrl || '',
      isDownloader: true,
      isUploader: false,
      cookieValidated: true,
    });
  }
  store.updateAccountsList(accounts);
  await store.updateAccountSecret(id, cookie);
  await resyncIfActive(id);
  return id;
}

function patchProfile(accountId: string, patch: Partial<Profile>) {
  const store = useConfigStore.getState();
  store.updateAccountsList(
    store.config.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a)),
  );
}

/** Save (and check) the user API key. Empty string clears it. */
export async function saveProfileApiKey(accountId: string, key: string): Promise<KeyCheck | null> {
  const trimmed = key.trim();
  const store = useConfigStore.getState();
  if (!trimmed) {
    await store.updateAccountSecret(accountId, undefined, '');
    patchProfile(accountId, { isUploader: false, apiKeyValidated: undefined });
    await resyncIfActive(accountId);
    return null;
  }
  const check = await checkApiKey(trimmed);
  if (check.state === 'invalid') {
    return check;
  }
  await store.updateAccountSecret(accountId, undefined, trimmed);
  patchProfile(accountId, {
    isUploader: true,
    apiKeyValidated: check.state === 'ok' ? true : undefined,
  });
  await resyncIfActive(accountId);
  return check;
}

/** Save the optional group API key. Empty string clears it. */
export async function saveProfileGroupKey(
  accountId: string,
  key: string,
): Promise<KeyCheck | null> {
  const trimmed = key.trim();
  const store = useConfigStore.getState();
  if (trimmed) {
    const check = await checkApiKey(trimmed);
    if (check.state === 'invalid') return check;
    await store.updateAccountSecret(accountId, undefined, undefined, trimmed);
    await resyncIfActive(accountId);
    return check;
  }
  await store.updateAccountSecret(accountId, undefined, undefined, '');
  await resyncIfActive(accountId);
  return null;
}

/** Check the session + API key of a profile again and refresh name/avatar. */
export async function revalidateProfile(accountId: string): Promise<boolean> {
  const store = useConfigStore.getState();
  const secrets = store.accountSecrets[accountId] ?? {};
  const patch: Partial<Profile> = {};
  let ok = true;

  if (secrets.cookie?.trim()) {
    try {
      const result = await validateCookieProfile(secrets.cookie);
      patch.cookieValidated = normalizeId(result.user.id) === normalizeId(accountId);
      patch.name = result.user.displayName || result.user.name || undefined;
      if (result.user.avatarUrl) patch.avatarUrl = result.user.avatarUrl;
      if (!patch.name) delete patch.name;
    } catch {
      patch.cookieValidated = false;
    }
  } else {
    patch.cookieValidated = undefined;
  }
  if (patch.cookieValidated !== true) ok = false;

  if (secrets.apiKey?.trim()) {
    const check = await checkApiKey(secrets.apiKey);
    patch.apiKeyValidated =
      check.state === 'ok' ? true : check.state === 'invalid' ? false : undefined;
    if (check.state === 'invalid') ok = false;
  } else {
    patch.apiKeyValidated = undefined;
    ok = false;
  }

  patchProfile(accountId, patch);
  return ok;
}

/** Remove a profile and wipe its secrets. Falls back to another profile if it was active. */
export async function removeProfile(accountId: string) {
  const store = useConfigStore.getState();
  const remaining = store.config.accounts.filter((a) => a.id !== accountId);
  store.updateAccountsList(remaining);
  await store.updateAccountSecret(accountId, '', '', '');

  if (store.config.spoofing.selectedUser === accountId) {
    const next = remaining[0];
    if (next) {
      await activateProfile(next.id, null);
    } else {
      clearActiveProfile();
    }
  }
}

/**
 * Legacy: a session selected through the old auto-detect flow that never became
 * a profile. Returns what is needed to save it.
 */
export function legacySession(): { userId: string; cookie: string; apiKey: string } | null {
  const { config } = useConfigStore.getState();
  const s = config.spoofing;
  if (!s.selectedUser || s.selectedUser === 'none') return null;
  if (config.accounts.some((a) => a.id === s.selectedUser)) return null;
  if (s.cookie.trim().length < 50) return null;
  return { userId: s.selectedUser, cookie: s.cookie.trim(), apiKey: s.apiKey.trim() };
}
