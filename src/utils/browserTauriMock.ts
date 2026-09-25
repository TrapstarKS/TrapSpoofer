const MOCK_COMMANDS: Record<string, unknown> = {
  get_app_version: 'browser-preview',
  mcp_get_info: {
    enabled: true,
    port: 14380,
    url: 'http://127.0.0.1:14380/mcp',
    executable: 'C:/Program Files/TrapSpoofer/TrapSpoofer.exe',
    tools: ['get_status', 'scan_studio', 'list_assets', 'spoof_assets', 'get_job'],
  },
  mcp_set_enabled: null,
  mcp_set_frontend_ready: null,
  mcp_respond: true,
  get_runtime_info: { platform: 'windows' },
  check_roblox_api_status: true,
  save_profile_secrets: null,
  load_profile_secrets: {
    cookie: '',
    apiKey: '',
    profileCookies: {},
    accountSecrets: {},
  },
  get_manageable_groups: [],
  get_group_icons_batch: {},
  get_studio_asset_snapshots: {
    anims: { assets: [] },
    sounds: { assets: [] },
    images: { assets: [] },
    meshes: { assets: [] },
    scriptRefs: { assets: [] },
  },
  find_studio_process: null,
  detect_opencloud_api_key_owner: { ok: true, ownerUserId: null, message: '' },
  fetch_audio_quota: null,
  quit_app: null,
  scan_and_replace_multiple_strings: {},
  get_studio_connection_state: null,
  get_plugin_port: null,
  read_clipboard_text: null,
};

let callbackId = 0;

export function installBrowserTauriMock() {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke?: unknown;
      transformCallback?: unknown;
    };
  };

  if (w.__TAURI_INTERNALS__) return;

  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, _args?: unknown) => {
      if (cmd in MOCK_COMMANDS) return MOCK_COMMANDS[cmd];

      if (typeof cmd === 'string' && cmd.startsWith('plugin:event|')) return null;
      return null;
    },
    transformCallback: () => callbackId++,
  };

  // `unlisten()` from @tauri-apps/api/event calls into these internals.
  (
    window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: () => void } }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => undefined };

  (window as unknown as { __IS_BROWSER_PREVIEW__?: boolean }).__IS_BROWSER_PREVIEW__ = true;
}

export function isBrowserPreview(): boolean {
  return Boolean(
    (window as unknown as { __IS_BROWSER_PREVIEW__?: boolean }).__IS_BROWSER_PREVIEW__,
  );
}
