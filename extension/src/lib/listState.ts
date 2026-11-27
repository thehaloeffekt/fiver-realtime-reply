/**
 * The inbox list's state per conversation, and the rule for "this row now
 * shows a new message from the buyer". The live watcher (content script)
 * and the after-reload compare (background) both use it, so they agree.
 */
import { rowKey, type InboxRow, type ListMessage } from './inboxRow';

export interface RowState {
  username: string;
  name: string;
  unread: number;
  /** Start of the preview; enough to see that it changed. */
  preview: string;
  mine: boolean;
}

/** Saved in chrome.storage.local, so it survives the reload and a browser restart. */
export interface SavedListState {
  at: number;
  /** Id of the page that sent it (its load time). */
  page: string;
  rows: Record<string, RowState>;
}

/** Saved state older than this is not used for the compare (too old to trust). */
export const SAVED_STATE_MAX_AGE_MS = 24 * 60 * 60_000;
const PREVIEW_CHARS = 300;
const MAX_ROWS = 200;

export function toRowState(r: InboxRow): RowState {
  return { username: r.username, name: r.name, unread: r.unread, preview: r.preview.slice(0, PREVIEW_CHARS), mine: r.mine };
}

/**
 * True when `r` shows a buyer message that `prev` did not: not mine, not
 * "Typing...", unread, and the count went up, the preview changed, or the
 * last message used to be mine.
 */
export function isNewMessage(prev: RowState, r: InboxRow): boolean {
  if (r.mine || r.typing || r.unread === 0) return false;
  return r.unread > prev.unread || r.preview.slice(0, PREVIEW_CHARS) !== prev.preview || prev.mine;
}

/**
 * True when `r` shows a new buyer message that Fiverr already marked read:
 * 0 unread, not mine, not "Typing...", and a different, non-empty preview.
 * This happens when the conversation is open in a tab: Fiverr marks each new
 * message in it read at once, so the row never becomes unread.
 */
export function isReadAtOnce(prev: RowState, r: InboxRow): boolean {
  if (r.mine || r.typing || r.unread !== 0 || !r.preview.trim()) return false;
  return r.preview.slice(0, PREVIEW_CHARS) !== prev.preview;
}

export function toListMessage(r: InboxRow, count: number): ListMessage {
  return { username: r.username, displayName: r.name, body: r.preview, count: Math.max(1, count) };
}

/** Rows as a state map, top first, at most MAX_ROWS. Typing rows keep no preview. */
export function stateOf(rows: InboxRow[], keep: Record<string, RowState> = {}): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  for (const r of rows.slice(0, MAX_ROWS)) {
    const key = rowKey(r);
    // "Typing..." is not a message: keep what we knew for that row.
    if (r.typing) {
      if (keep[key]) out[key] = keep[key];
      continue;
    }
    out[key] = toRowState(r);
  }
  return out;
}

/**
 * The compare after a watch-tab reload (or at browser start): which rows got
 * a new buyer message between the saved state and the fresh list.
 *
 * - A row in both: alert when isNewMessage says so.
 * - A row not in the saved state: alert only if it is unread and above every
 *   row that was saved. That is where Fiverr puts a conversation that is new;
 *   an old row further down that we never saw (the list grew) stays quiet.
 * - A saved row that is gone from the fresh list: nothing.
 * - With `readAtOnce`: a row that changed to a buyer message but shows 0
 *   unread (read at once in an open conversation) is a `read` message.
 */
export function compareWithSaved(saved: Record<string, RowState>, rows: InboxRow[], { readAtOnce = false } = {}): ListMessage[] {
  const firstKnown = rows.findIndex((r) => saved[rowKey(r)] !== undefined);
  const out: ListMessage[] = [];
  rows.forEach((r, i) => {
    const prev = saved[rowKey(r)];
    if (prev) {
      if (isNewMessage(prev, r)) out.push(toListMessage(r, r.unread - prev.unread));
      // Only for a short gap (see READ_AT_ONCE_GAP_MS): after a long one a
      // read row is more likely a message read on the phone.
      else if (readAtOnce && isReadAtOnce(prev, r)) out.push({ ...toListMessage(r, 1), read: true });
    } else if (!r.mine && !r.typing && r.unread > 0 && firstKnown !== -1 && i < firstKnown) {
      out.push(toListMessage(r, r.unread));
    }
  });
  return out;
}

/**
 * A read row with a new preview counts in the after-reload compare only if
 * the saved state is this fresh (a reload or the return to /inbox, which save
 * the state right before).
 */
export const READ_AT_ONCE_GAP_MS = 5 * 60_000;

/** Saved state usable at `now`, or null. */
export function usableSaved(saved: SavedListState | undefined, now: number): SavedListState | null {
  if (!saved || typeof saved.at !== 'number' || !saved.rows || typeof saved.rows !== 'object') return null;
  if (now - saved.at > SAVED_STATE_MAX_AGE_MS || saved.at > now + 60_000) return null;
  return saved;
}

/** Checks a list state sent by a content script before it is stored. */
export function sanitizeRows(raw: unknown): Record<string, RowState> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, RowState> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_ROWS) break;
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    out[String(k).slice(0, 120)] = {
      username: String(r.username ?? '').slice(0, 64),
      name: String(r.name ?? '').slice(0, 100),
      unread: Math.max(0, Math.min(999, Number(r.unread) || 0)),
      preview: String(r.preview ?? '').slice(0, PREVIEW_CHARS),
      mine: Boolean(r.mine),
    };
    n++;
  }
  return out;
}
