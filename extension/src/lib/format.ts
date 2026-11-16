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
 */
export function formatAlert(label: string, toast: Pick<Toast, 'username' | 'displayName'>, bodyLine: string, accountId: string, more = 0) {
  const from = toast.username
    ? `Message from <b>${escapeHtml(toast.displayName)}</b> (@${escapeHtml(toast.username)})`
    : `Message from <b>${escapeHtml(toast.displayName)}</b>`;
  const lines = [`<b>${escapeHtml(label)}</b>`, from, escapeHtml(truncate(bodyLine))];
  if (more > 0) lines.push(`<i>+${more} earlier ${more === 1 ? 'message' : 'messages'} in this conversation. Check Fiverr.</i>`);
  const html = lines.join('\n');

  const actions = [];
  const full = toast.username ? encodeCallback(accountId, 'full', toast.username) : null;
  if (full) actions.push({ text: 'Full message', callback_data: full });
  actions.push({ text: 'Check now', callback_data: encodeCallback(accountId, 'check', '')! });

  const open = toast.username ? inboxUrlFor(toast.username) : INBOX_URL;
  const keyboard: InlineKeyboard = [[{ text: 'Open inbox', url: open }], actions];
  return { html, keyboard };
}

export function formatTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

export function formatAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return formatTime(ts, now);
}
