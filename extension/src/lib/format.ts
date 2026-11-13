import { encodeCallback } from './callback';
import { INBOX_URL, MAX_BODY_CHARS, inboxUrlFor } from './constants';
import { escapeHtml, type InlineKeyboard } from './telegram';
import type { Toast } from './toast';

export function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The alert text (parse_mode HTML) and its three buttons. */
export function formatAlert(label: string, toast: Pick<Toast, 'username' | 'displayName'>, bodyLine: string, accountId: string) {
  const html = [
    `<b>${escapeHtml(label)}</b>`,
    `Message from <b>${escapeHtml(toast.displayName)}</b> (@${escapeHtml(toast.username)})`,
    escapeHtml(truncate(bodyLine)),
  ].join('\n');

  const actions = [];
  const full = encodeCallback(accountId, 'full', toast.username);
  if (full) actions.push({ text: 'Full message', callback_data: full });
  actions.push({ text: 'Check now', callback_data: encodeCallback(accountId, 'check', '')! });

  const keyboard: InlineKeyboard = [[{ text: 'Open inbox', url: inboxUrlFor(toast.username) }], actions];
  return { html, keyboard };
}

export function formatUnread(label: string, n: number) {
  return {
    html: `<b>${escapeHtml(label)}</b>: ${n} unread ${n === 1 ? 'message' : 'messages'}`,
    keyboard: [[{ text: 'Open inbox', url: INBOX_URL }]] as InlineKeyboard,
  };
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
