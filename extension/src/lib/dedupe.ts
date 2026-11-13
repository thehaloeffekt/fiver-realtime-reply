/** Same key inside this window is a duplicate. */
export const DEDUPE_WINDOW_MS = 20_000;

/** Builds the dedupe key. The separator cannot appear in accountId or conversationId. */
export function dedupeKey(accountId: string, conversationId: string, body: string): string {
  return `${accountId}\u0000${conversationId}\u0000${body}`;
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

  constructor(private readonly windowMs = DEDUPE_WINDOW_MS) {}

  /** True if the alert should be sent (and records it as sent at `now`). */
  take(key: string, now: number): boolean {
    this.prune(now);
    const at = this.sent.get(key);
    if (at !== undefined && now - at < this.windowMs) return false;
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
    for (const [k, t] of entries) if (now - t < this.windowMs) this.sent.set(k, t);
  }

  private prune(now: number) {
    for (const [k, t] of this.sent) if (now - t >= this.windowMs) this.sent.delete(k);
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
