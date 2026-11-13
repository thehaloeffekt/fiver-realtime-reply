/**
 * Reads the inbox and conversations in the watch tab. These areas have
 * placeholder selectors (see selectors.ts): until they are filled in, every
 * function reports `missing` instead of guessing.
 */
import type { ConversationMessage, InboxSnapshot, ReadResult } from '../lib/messages';
import { CONVERSATION, HEADER, INBOX } from '../lib/selectors';

/** Resolves with the first match, or null after `timeoutMs`. */
export function waitFor(selector: string, timeoutMs: number): Promise<Element | null> {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

export async function readInbox(): Promise<InboxSnapshot> {
  return { unread: await readUnreadCount(), names: await readUnreadNames() };
}

async function readUnreadCount(): Promise<ReadResult<number>> {
  if (!INBOX.unreadBadge) return { ok: false, missing: 'INBOX.unreadBadge' };
  const badge = await waitFor(INBOX.unreadBadge, 10_000);
  // TODO(capture: unreadBadge): confirm that Fiverr removes the badge at 0 unread.
  if (!badge) return { ok: true, value: 0 };
  const digits = text(badge).match(/\d+/);
  return digits ? { ok: true, value: Number(digits[0]) } : { ok: false, error: `badge text "${text(badge)}"` };
}

async function readUnreadNames(): Promise<ReadResult<string[]>> {
  if (!INBOX.unreadRow) return { ok: false, missing: 'INBOX.unreadRow' };
  if (!INBOX.rowName) return { ok: false, missing: 'INBOX.rowName' };
  const rows = Array.from(document.querySelectorAll(INBOX.unreadRow));
  return { ok: true, value: rows.map((r) => text(r.querySelector(INBOX.rowName!))).filter(Boolean) };
}

/** The buyer's last `limit` messages, oldest first. Each attachment becomes "[attachment]". */
export async function readConversation(limit: number): Promise<ReadResult<ConversationMessage[]>> {
  const { message, ownMessage, messageText, attachment } = CONVERSATION;
  if (!message) return { ok: false, missing: 'CONVERSATION.message' };
  if (!ownMessage) return { ok: false, missing: 'CONVERSATION.ownMessage' };
  if (!messageText) return { ok: false, missing: 'CONVERSATION.messageText' };
  if (!(await waitFor(message, 15_000))) return { ok: true, value: [] };

  const fromBuyer = Array.from(document.querySelectorAll(message)).filter((m) => !m.matches(ownMessage));
  const value = fromBuyer.slice(-limit).map((m) => {
    const parts = [text(m.querySelector(messageText))];
    const files = attachment ? m.querySelectorAll(attachment).length : 0;
    for (let i = 0; i < files; i++) parts.push('[attachment]');
    return { text: parts.filter(Boolean).join(' ') || '[attachment]' };
  });
  return { ok: true, value };
}

/** Logged-in username for the default account label, or null. */
export function readLoggedInUsername(): string | null {
  if (!HEADER.loggedInUsername) return null;
  const el = document.querySelector(HEADER.loggedInUsername);
  if (!el) return null;
  const raw = HEADER.loggedInUsernameAttr ? el.getAttribute(HEADER.loggedInUsernameAttr) ?? '' : text(el);
  const last = raw.split(/[/?#]/).filter(Boolean).pop() ?? '';
  return last.replace(/^@/, '') || null;
}
