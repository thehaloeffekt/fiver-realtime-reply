/**
 * Which buyer a Telegram message is about, so that a reply to it in
 * Telegram goes to that buyer. Recorded for every alert and every "Full
 * message" part this profile sends. Only the message id and the username
 * are kept, never the text.
 */
import { decodeCallback } from '../lib/callback';
import { INBOX_URL } from '../lib/constants';
import { getLocal, updateLocal } from '../lib/storage';

const KEEP_MS = 14 * 24 * 60 * 60_000;
const MAX_TARGETS = 500;
const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function rememberReplyTarget(messageId: number, buyer: string): Promise<void> {
  if (!USERNAME.test(buyer)) return Promise.resolve();
  return updateLocal('replyTargets', (map = {}) => {
    const now = Date.now();
    const next: Record<string, { buyer: string; at: number }> = {};
    const kept = Object.entries(map ?? {}).filter(([, v]) => now - v.at < KEEP_MS).sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of kept.slice(-(MAX_TARGETS - 1))) next[k] = v;
    next[String(messageId)] = { buyer, at: now };
    return next;
  });
}

export async function replyTargetOf(messageId: unknown): Promise<string | null> {
  if (typeof messageId !== 'number') return null;
  const hit = (await getLocal()).replyTargets?.[String(messageId)];
  return hit && Date.now() - hit.at < KEEP_MS ? hit.buyer : null;
}

type Json = Record<string, any>;

/**
 * The buyer of a message by its buttons, for a message sent before targets
 * were recorded: only when one of its buttons belongs to `accountId`. The
 * "Full message" button carries the username; the "Open conversation" link
 * ends in it.
 */
export function buyerFromKeyboard(markup: Json | undefined, accountId: string): string | null {
  const rows: unknown = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  const buttons = rows.flatMap((r) => (Array.isArray(r) ? r : [])).filter((b): b is Json => b && typeof b === 'object');
  const mine = buttons.map((b) => decodeCallback(b.callback_data)).filter((d) => d?.accountId === accountId);
  if (!mine.length) return null;
  const full = mine.find((d) => d!.action === 'full' && USERNAME.test(d!.arg));
  if (full) return full.arg;
  for (const b of buttons) {
    if (typeof b.url !== 'string' || !b.url.startsWith(`${INBOX_URL}/`)) continue;
    const name = decodeURIComponent(b.url.slice(INBOX_URL.length + 1));
    if (USERNAME.test(name)) return name;
  }
  return null;
}
