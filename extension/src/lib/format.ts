import { formatMineShort } from './buyerTime';
import { encodeCallback } from './callback';
import { INBOX_URL, MAX_BODY_CHARS, SAFE_MESSAGE_CHARS, inboxUrlFor } from './constants';
import { escapeHtml, type InlineKeyboard } from './telegram';
import type { Toast } from './toast';

/** Index <= `end` that does not split a surrogate pair (an emoji is two UTF-16 units). */
function safeEnd(text: string, end: number): number {
  const c = text.charCodeAt(end - 1);
  return end > 0 && c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
}

/** Cuts to `max` characters with "…", never inside an emoji. For names and file names. */
export function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, safeEnd(text, max - 1))}…`;
}

export const CUT_NOTE = '… (message cut, open Fiverr for the rest)';

/**
 * A buyer's message cut to at most `max` characters, note included, ending
 * in CUT_NOTE. Cut at a space when one is near, and never inside an emoji: a
 * half emoji (lone surrogate) is not valid UTF-8, and Telegram would refuse
 * the whole message.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = safeEnd(text, Math.max(0, max - CUT_NOTE.length));
  const space = text.lastIndexOf(' ', end);
  if (space > end - 40 && space > 0) end = space;
  return `${text.slice(0, end).trimEnd()}${CUT_NOTE}`;
}

/**
 * The length Telegram checks: the text after parse_mode HTML, without tags,
 * with each entity (&amp; &lt; &gt; &quot;) as one character. JS length is in
 * UTF-16 units, the same units Telegram counts in.
 */
export function telegramLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, '_').length;
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
  const name = escapeHtml(truncate(toast.displayName, 100));
  const from = toast.username ? `Message from <b>${name}</b> (@${escapeHtml(truncate(toast.username, 64))})` : `Message from <b>${name}</b>`;
  const top = [`<b>${escapeHtml(truncate(label, 64))}</b>`, from];
  const bottom: string[] = [];
  if (more > 0) bottom.push(`<i>+${more} earlier ${more === 1 ? 'message' : 'messages'} in this conversation. Check Fiverr.</i>`);
  if (buyerTime) bottom.push(`Buyer time: ${escapeHtml(truncate(buyerTime, 60))}`);
  // The body gets what the other lines leave of a safe message, at most MAX_BODY_CHARS.
  const room = SAFE_MESSAGE_CHARS - telegramLength([...top, ...bottom].join('\n')) - 2;
  const html = [...top, escapeHtml(cutText(bodyLine, Math.min(MAX_BODY_CHARS, room))), ...bottom].join('\n');

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
