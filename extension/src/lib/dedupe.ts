/** Same key inside this window is a duplicate. */
export const DEDUPE_WINDOW_MS = 20_000;
/**
 * A replayed toast (shown when a hidden tab becomes visible again) is a
 * duplicate if the same message was alerted within this longer window.
 */
export const REPLAY_WINDOW_MS = 2 * 60 * 60_000;

/** Display name for keys: case and spacing do not matter. */
export function senderKey(displayName: string): string {
  return displayName.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Who sent it, for keys: the username when known (two buyers can share a
 * display name, never a username), else the display name.
 */
export function senderId(username: string, displayName: string): string {
  const u = username.trim().toLowerCase();
  return u ? `u:${u}` : `n:${senderKey(displayName)}`;
}

/**
 * Body for keys: lowercase, no whitespace, no trailing "…", first 40
 * characters. The toast joins text nodes without spaces and the inbox list
 * joins them with spaces, and a long list preview may be cut (40 letters
 * still match a preview cut at about 50 characters with spaces); this makes the
 * same message give the same key from both.
 */
export function bodyKey(body: string): string {
  return body.toLowerCase().replace(/\s+/g, '').replace(/(?:…|\.\.\.)$/, '').slice(0, 40);
}

/**
 * Key = account + sender + body, where sender is senderId() (the username).
 * Not the toast id: the inbox list has no toast id, and both detectors must
 * give the same key for the same message. The separator cannot appear in
 * any part.
 */
export function dedupeKey(accountId: string, sender: string, body: string): string {
  return `${accountId}\u0000${senderKey(sender)}\u0000${bodyKey(body)}`;
}

/**
 * Drops an alert only if the same key was sent in the last `windowMs`.
 *
 * Several open Fiverr tabs show the same toast at about the same time, so they
 * collapse into one alert. A buyer who sends the same text again later (after
 * the window) still gets an alert, which a "seen forever" set would hide.
 *
 * `take` checks and records in one synchronous step, so two tabs that report
 * the same toast in the same tick cannot both pass.
 */
export class Deduper {
  private sent = new Map<string, number>();

  /**
   * @param windowMs default duplicate window
   * @param keepMs how long keys are remembered (at least windowMs), so a
   *   caller can check a longer window, e.g. for replayed toasts
   */
  constructor(
    private readonly windowMs = DEDUPE_WINDOW_MS,
    private readonly keepMs = windowMs,
  ) {}

  /** True if the alert should be sent (and records it as sent at `now`). */
  take(key: string, now: number, windowMs = this.windowMs): boolean {
    this.prune(now);
    const at = this.sent.get(key);
    if (at !== undefined && now - at < windowMs) return false;
    this.sent.set(key, now);
    return true;
  }

  /** Forgets a key, for example when sending failed, so a later copy may retry. */
  release(key: string, at: number): void {
    if (this.sent.get(key) === at) this.sent.delete(key);
  }

  entries(): Array<[string, number]> {
    return Array.from(this.sent.entries());
  }

  load(entries: Array<[string, number]>, now: number): void {
    for (const [k, t] of entries) if (now - t < Math.max(this.windowMs, this.keepMs)) this.sent.set(k, t);
  }

  private prune(now: number) {
    const keep = Math.max(this.windowMs, this.keepMs);
    for (const [k, t] of this.sent) if (now - t >= keep) this.sent.delete(k);
  }
}

export type AlertSource = 'toast' | 'list' | 'thread';

/**
 * For messages whose text the two detectors show differently. A file is
 * "1 File" in a toast, but the inbox list shows something else (not seen
 * yet), so their body keys differ. Rule: an alert from one source is a
 * duplicate if the same sender had an alert from the *other* source within
 * the window and either of the two was not plain text. Two text messages
 * with different bodies stay two alerts.
 */
export class SenderGate {
  private last = new Map<string, { at: number; source: AlertSource; text: boolean }>();

  constructor(private readonly windowMs = DEDUPE_WINDOW_MS) {}

  /** True if the alert should be sent (and records it). */
  take(sender: string, source: AlertSource, text: boolean, now: number): boolean {
    for (const [k, v] of this.last) if (now - v.at >= this.windowMs) this.last.delete(k);
    const prev = this.last.get(sender);
    if (prev && prev.source !== source && (!text || !prev.text)) return false;
    this.last.set(sender, { at: now, source, text });
    return true;
  }
}

/** Remembers the last `size` Telegram update ids; the relay may deliver one again. */
export class RecentIds {
  private ids: number[];
  private set: Set<number>;

  constructor(initial: number[] = [], private readonly size = 200) {
    this.ids = initial.slice(-size);
    this.set = new Set(this.ids);
  }

  /** True the first time an id is seen. */
  add(id: number): boolean {
    if (this.set.has(id)) return false;
    this.ids.push(id);
    this.set.add(id);
    while (this.ids.length > this.size) this.set.delete(this.ids.shift()!);
    return true;
  }

  toArray(): number[] {
    return this.ids.slice();
  }
}
