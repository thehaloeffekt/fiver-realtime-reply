import { formatAgo } from '../lib/format';
import { isConfigured, type LocalState, type SessionState } from '../lib/storage';
import type { Tone } from './components';
import { minutesUntil } from './hooks';

export interface StatusLine {
  tone: Exclude<Tone, 'accent'>;
  text: string;
}

export function telegramStatus(l: LocalState, s: SessionState): StatusLine {
  if (!l.token || !l.bot) return { tone: 'idle', text: 'No bot yet' };
  if (s.telegram.lastError && (!s.telegram.lastOkAt || s.telegram.lastErrorAt! > s.telegram.lastOkAt)) {
    return { tone: 'err', text: `@${l.bot.username} · error` };
  }
  if (!l.chatId) return { tone: 'warn', text: `@${l.bot.username} · not linked` };
  return { tone: 'ok', text: `@${l.bot.username} · linked` };
}

export function relayStatus(l: LocalState, s: SessionState, now: number): StatusLine {
  const r = s.relay;
  if (!l.botKey) return { tone: 'idle', text: 'Not set up' };
  if (r.phase === 'connected') {
    const online = s.presence.filter((a) => a.online).length;
    return { tone: 'ok', text: online > 1 ? `Connected · ${online} profiles online` : 'Connected' };
  }
  if (r.phase === 'connecting') return { tone: 'warn', text: 'Connecting…' };
  if (r.phase === 'offline') {
    return { tone: 'err', text: r.nextAttemptAt ? `Offline · retry in ${minutesUntil(r.nextAttemptAt, now)}` : 'Offline' };
  }
  return { tone: 'idle', text: 'Not connected' };
}

export function watchStatus(l: LocalState, s: SessionState, now: number): StatusLine {
  if (!isConfigured(l)) return { tone: 'idle', text: 'Opens after setup' };
  if (s.watchTabId == null) return { tone: 'warn', text: 'Closed' };
  return { tone: 'ok', text: `Open · reload in ${minutesUntil(s.nextReloadAt, now)}` };
}

export type Problem = { kind: 'relay' | 'telegram' | 'watch'; tone: 'warn' | 'err'; text: string };

/** The most important thing that is wrong, for the popup banner. */
export function topProblem(l: LocalState, s: SessionState): Problem | null {
  if (!isConfigured(l)) return null;
  const tg = telegramStatus(l, s);
  if (tg.tone === 'err') {
    return { kind: 'telegram', tone: 'err', text: `${s.telegram.lastError} Alerts are not reaching Telegram.` };
  }
  if (s.relay.phase === 'offline') {
    const extra = s.relay.lastError && s.relay.closeCode && s.relay.closeCode >= 4000 ? ` (${s.relay.lastError})` : '';
    return {
      kind: 'relay',
      tone: 'warn',
      text: `The relay is offline. Alerts still go to Telegram. The buttons in Telegram do not work until the relay is back.${extra}`,
    };
  }
  if (s.watchTabId == null) {
    return { kind: 'watch', tone: 'warn', text: 'The watch tab is closed. Alerts arrive only while a Fiverr tab is open.' };
  }
  return null;
}

export const lastSeenText = (ts: number | undefined, now: number) => formatAgo(ts, now);
