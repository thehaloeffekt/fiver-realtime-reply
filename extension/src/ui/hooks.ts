import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { UiResponse, UiToBackground } from '../lib/messages';
import { getLocal, getSession, type LocalState, type SessionState } from '../lib/storage';

/** Live view of chrome.storage.local (null until loaded). */
export function useLocal(): LocalState | null {
  return useArea('local', getLocal);
}

/** Live view of chrome.storage.session (null until loaded). */
export function useSession(): SessionState | null {
  return useArea('session', getSession);
}

function useArea<T>(area: string, load: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => void load().then((v) => alive && setValue(v));
    refresh();
    const listener = (_: unknown, changedArea: string) => changedArea === area && refresh();
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, [area, load]);
  return value;
}

/** Re-renders every `ms` (for "in 12 min" countdowns). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export async function ask<T extends object = object>(msg: UiToBackground): Promise<UiResponse & Partial<T>> {
  try {
    return (await browser.runtime.sendMessage(msg)) as UiResponse & Partial<T>;
  } catch (e) {
    return { ok: false, error: String(e) } as UiResponse & Partial<T>;
  }
}

export function minutesUntil(ts: number | undefined, now: number): string {
  if (!ts) return '—';
  const m = Math.max(0, Math.round((ts - now) / 60_000));
  return m < 1 ? 'less than a minute' : `${m} min`;
}
