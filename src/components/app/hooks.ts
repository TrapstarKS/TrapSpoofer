import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getActiveTarget } from '../../services/spoofer';
import { useConfigStore } from '../../stores/configStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSpooferStore } from '../../stores/spooferStore';
import { useFlowStore } from './spoof/flowStore';

/** Reactive version of `getActiveTarget()` (re-computes when profile/secrets change). */
export function useActiveTarget() {
  const spoofing = useConfigStore((s) => s.config.spoofing);
  const accounts = useConfigStore((s) => s.config.accounts);
  const secrets = useConfigStore((s) => s.accountSecrets);
  return useMemo(() => getActiveTarget(), [spoofing, accounts, secrets]);
}

/** A clock that ticks while `enabled` (for ETAs / elapsed time). */
export function useNow(enabled: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

/** Copy helper that remembers which key was copied for ~1.5s. */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const copy = useCallback(async (text: string, key = 'default') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(text);
      } catch {
        return false;
      }
    }
    setCopied(key);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1500);
    return true;
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { copied, copy };
}

/**
 * Keeps the Spoofar wizard in sync with whatever drives the app (UI, legacy
 * explorer or an AI agent over MCP). Mount once.
 */
export function useFlowAutoAdvance() {
  useEffect(() => {
    const unsubJob = useSpooferStore.subscribe((state, prev) => {
      if (state.isSpoofing && !prev.isSpoofing) useFlowStore.getState().setStep(2);
      if (!state.isSpoofing && prev.isSpoofing) useFlowStore.getState().setStep(3);
    });
    const unsubScan = useSessionStore.subscribe((state, prev) => {
      if (state.scanPhase === 'done' && prev.scanPhase !== 'done' && state.assets.length > 0) {
        const flow = useFlowStore.getState();
        if (flow.step === 0 || flow.step === 3) flow.setStep(1);
      }
      if (state.source === null && prev.source !== null && !useSpooferStore.getState().isSpoofing) {
        useFlowStore.getState().setStep(0);
      }
    });
    return () => {
      unsubJob();
      unsubScan();
    };
  }, []);
}
