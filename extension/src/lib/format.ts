import { formatMineShort } from './buyerTime';
import { encodeCallback } from './callback';
import { INBOX_URL, MAX_BODY_CHARS, inboxUrlFor } from './constants';
import { escapeHtml, type InlineKeyboard } from './telegram';
import type { Toast } from './toast';

export function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The alert text (parse_mode HTML) and its buttons.
 *
 * `username` may be empty: the inbox list shows only display names, and the
 * username is known only if a toast from that buyer was seen before. Then the
 * "(@user)" part and the "Full message" button (which needs the username to
 * open the conversation) are left out, and "Open inbox" opens the inbox.
 * `more` > 0 adds a line when one change stood for several new messages.
 * `buyerTime` (the buyer's local time now, when their offset is known) is the last line.
 */
export function formatAlert(label: string, toast: Pick<Toast, 'username' | 'displayName'>, bodyLine: string, accountId: string, more = 0, buyerTime?: string) {
  const from = toast.username
    ? `Message from <b>${escapeHtml(toast.displayName)}</b> (@${escapeHtml(toast.username)})`
    : `Message from <b>${escapeHtml(toast.displayName)}</b>`;
  const lines = [`<b>${escapeHtml(label)}</b>`, from, escapeHtml(truncate(bodyLine))];
  if (more > 0) lines.push(`<i>+${more} earlier ${more === 1 ? 'message' : 'messages'} in this conversation. Check Fiverr.</i>`);
  if (buyerTime) lines.push(`Buyer time: ${escapeHtml(buyerTime)}`);
  const html = lines.join('\n');

  const actions = [];
  const full = toast.username ? encodeCallback(accountId, 'full', toast.username) : null;
  if (full) actions.push({ text: 'Full message', callback_data: full });
  actions.push({ text: 'Check now', callback_data: encodeCallback(accountId, 'check', '')! });

  const open = toast.username ? inboxUrlFor(toast.username) : INBOX_URL;
  const keyboard: InlineKeyboard = [[{ text: 'Open inbox', url: open }], actions];
  return { html, keyboard };
}

/** "6:52 PM" today, else "Nov 16, 6:52 PM", in `timeZone` (My time zone). "never" without a time. */
export function formatTime(ts: number | undefined, now: number, timeZone: string): string {
  if (!ts) return 'never';
  return formatMineShort(ts, now, timeZone);
}

/** "just now", "5 min ago", "3 h ago"; after a day the time itself, in `timeZone`. */
export function formatAgo(ts: number | undefined, now: number, timeZone: string): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return formatTime(ts, now, timeZone);
}
