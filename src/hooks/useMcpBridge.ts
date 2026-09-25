import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';

import { handlers } from '../mcp/handlers';
import { useConfigStore } from '../stores/configStore';
import { useSessionStore } from '../stores/sessionStore';
import { logIsm } from '../utils/robloxProfiles';
import { isTauriRuntime } from '../utils/tauriRuntime';

interface McpRequest {
  requestId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Serves MCP tool calls relayed by the Rust server. Mount once at the app root. */
export function useMcpBridge() {
  const enabled = useConfigStore((s) => s.config.general.mcpEnabled);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke('mcp_set_enabled', { enabled }).catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<McpRequest>('mcp://request', async (event) => {
      const { requestId, tool, arguments: args } = event.payload;
      const session = useSessionStore.getState();
      session.pushMcpActivity({ id: requestId, tool, at: Date.now() });
      const handler = handlers[tool];
      let isError = false;
      let payload: unknown;
      try {
        if (!handler) throw new Error(`Tool not implemented: ${tool}`);
        payload = (await handler(args ?? {})) ?? { ok: true };
      } catch (error) {
        isError = true;
        payload = error instanceof Error ? error.message : String(error);
        logIsm('warn', `MCP ${tool}: ${String(payload)}`, false);
      }
      useSessionStore
        .getState()
        .updateMcpActivity(requestId, { ok: !isError, summary: summarize(payload) });
      await invoke('mcp_respond', {
        requestId,
        isError,
        payload: JSON.stringify(payload ?? null),
      }).catch(() => undefined);
    }).then((fn) => {
      if (disposed) fn();
      else {
        unlisten = fn;
        void invoke('mcp_set_frontend_ready', { ready: true }).catch(() => undefined);
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
      void invoke('mcp_set_frontend_ready', { ready: false }).catch(() => undefined);
    };
  }, []);
}
