/**
 * Learns the buyer's time zone passively: in any Fiverr tab where the user
 * (or "Full message") has a conversation open, read the header's
 * "2:57 AM (local time)" and report the UTC offset it implies. Never opens
 * a conversation itself (that would mark it read). Read-only.
 */
import type { BuyerHeader } from '../lib/messages';
import { conversationUsername, readBuyerHeader } from './reader';

/** Report the same reading again after this long, so the saved date stays fresh. */
const RESEND_MS = 10 * 60_000;

export function watchBuyerHeader(onHeader: (h: BuyerHeader) => void): () => void {
  let lastKey = '';
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    timer = undefined;
    const username = conversationUsername(location.pathname);
    if (!username) return;
    // Read at the moment the page shows (or changes) the clock: the clock is
    // current then, so comparing it with Date.now() gives the offset.
    const h = readBuyerHeader(username, Date.now());
    if (!h) return;
    const key = `${h.username.toLowerCase()}|${h.offset}|${h.country ?? ''}`;
    if (key === lastKey && Date.now() - lastSentAt < RESEND_MS) return;
    lastKey = key;
    lastSentAt = Date.now();
    onHeader(h);
  };
  // The thread re-renders often; one check per burst of changes is enough.
  const schedule = () => (timer ??= setTimeout(check, 500));

  const obs = new MutationObserver(schedule);
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  schedule();
  return () => {
    obs.disconnect();
    clearTimeout(timer);
  };
}
