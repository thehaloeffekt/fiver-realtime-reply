/**
 * Third detector: the open conversation's thread, for a conversation open
 * in a tab the user is not looking at.
 *
 * With a conversation open, Fiverr marks each new message in it read at
 * once, so its inbox row never becomes unread (the list detector's main
 * rule), and Fiverr draws no toast in a hidden tab. The thread itself still
 * gets the new `div.message`.
 *
 * A message counts when all of these hold:
 *   - its id was not in the thread when the conversation was opened
 *     (the first SETTLE_MS of rendering are the baseline),
 *   - its time (from the id's UUID) is newer than every message in the
 *     baseline and than the moment the conversation was opened (minus
 *     CLOCK_SKEW_MS): older history loaded by scrolling up never counts,
 *   - the sender is the buyer of this conversation (the URL's username),
 *     not me ("Me", or my username),
 *   - the user is away: the tab is hidden or its window has no focus. In a
 *     visible, focused tab the user is reading the conversation.
 * Each id is handled once; the background also dedupes by id and by
 * account + username + body against the toast and list detectors.
 *
 * Runs in the MutationObserver callback with no timers (hidden tabs delay
 * timers by up to a minute). Read-only.
 */
import { messageSentAt } from '../lib/buyerTime';
import type { ThreadMessage } from '../lib/messages';
import { CONVERSATION } from '../lib/selectors';
import { conversationUsername, parseConversation } from './reader';

/** Messages rendered this long after the thread first appears are part of opening it. */
export const SETTLE_MS = 1500;
/** Fiverr's clock (in the id) may run behind this computer's by this much. */
export const CLOCK_SKEW_MS = 5 * 60_000;

export interface ThreadHooks {
  /** My username, when known (also "Me" in the page marks my messages). */
  myUsername?: () => string | null | undefined;
  /** Default: tab hidden or window without focus. */
  mayAlert?: () => boolean;
  path?: () => string;
  now?: () => number;
}

export function watchThread(onMessage: (m: ThreadMessage) => void, hooks: ThreadHooks = {}): () => void {
  const now = hooks.now ?? Date.now;
  const path = hooks.path ?? (() => location.pathname);
  const mayAlert = hooks.mayAlert ?? (() => document.visibilityState === 'hidden' || !document.hasFocus());

  let buyer = '';
  let openedAt = 0;
  /** When the first message of this conversation was rendered; 0 = none yet. */
  let firstSeenAt = 0;
  let newestBaseline = 0;
  const seen = new Set<string>();

  const check = () => {
    const b = conversationUsername(path());
    if (b.toLowerCase() !== buyer.toLowerCase()) {
      // Opened a conversation (or another one, without a page load).
      buyer = b;
      openedAt = now();
      firstSeenAt = 0;
      newestBaseline = 0;
      seen.clear();
    }
    if (!buyer) return;
    const ids = Array.from(document.querySelectorAll(CONVERSATION.message), (e) => e.id).filter(Boolean);
    if (!ids.length) return;
    const t = now();
    if (!firstSeenAt) firstSeenAt = t;
    const unseen = ids.filter((id) => !seen.has(id));
    if (!unseen.length) return; // the common case: re-renders, typing, time ticks

    // Still opening: everything on the page is the baseline.
    if (t - firstSeenAt < SETTLE_MS) {
      for (const id of unseen) {
        seen.add(id);
        newestBaseline = Math.max(newestBaseline, messageSentAt(id) ?? 0);
      }
      return;
    }

    const fresh = new Set(unseen);
    for (const id of unseen) seen.add(id);
    const me = hooks.myUsername?.()?.toLowerCase();
    const away = mayAlert();
    // Parse the whole thread: a grouped message takes its sender from the one before.
    for (const m of parseConversation()) {
      if (!fresh.has(m.id)) continue;
      const sentAt = messageSentAt(m.id);
      if (sentAt === null || sentAt <= newestBaseline || sentAt < openedAt - CLOCK_SKEW_MS) continue; // history
      const sender = m.sender.toLowerCase();
      if (m.me || !sender || sender !== buyer.toLowerCase() || (me && sender === me)) continue;
      if (!away) continue; // the user is reading this conversation
      if (!m.text && !m.files.length) continue;
      onMessage({ username: m.sender, displayName: m.name || m.sender, id: m.id, sentAt, text: m.text, files: m.files });
    }
  };

  const obs = new MutationObserver(check);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  check();
  return () => obs.disconnect();
}
