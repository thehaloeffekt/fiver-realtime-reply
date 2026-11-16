/**
 * Parses one row of the /inbox conversation list.
 *
 * Main path (parseRowStructure): the row's data-track attributes, confirmed
 * from a real capture (see INBOX in selectors.ts). The avatar's
 * `data-track-value` is the buyer's username, so every row has one.
 *
 * Fallback (parseRowPieces): the order of the row's text, as seen in the
 * real hidden-tab log, in case Fiverr drops the attributes:
 *
 *   "M · Buyer One · Just now · Good, any news · 1"
 *    │    │           │          │                         └ unread count (only when unread)
 *    │    │           │          └ preview of the last message
 *    │    │           └ relative time
 *    │    └ display name (the piece right before the time)
 *    └ avatar initial (only when there is no photo)
 *
 * The fallback has no username.
 */
import { senderId } from './dedupe';
import { INBOX } from './selectors';

/** A new incoming message seen in the inbox list (content script → background). */
export interface ListMessage {
  /** Buyer's Fiverr username; empty only if the row had no avatar attribute. */
  username: string;
  displayName: string;
  /** Preview text of the newest message (the full text; may be long). */
  body: string;
  /** How many new messages this change stands for (unread count delta, at least 1). */
  count: number;
}

export interface InboxRow {
  /** Buyer's username from the avatar; '' when only the text fallback worked. */
  username: string;
  /** Display name, as in the toast's strong.display-name. */
  name: string;
  /** Relative time text, e.g. "Just now", "3 minutes". */
  time: string;
  /** Unread count badge; 0 when the row has none. */
  unread: number;
  /** The last message was sent by the logged-in seller ("Me:"). */
  mine: boolean;
  /** "Typing..." is shown instead of the preview. */
  typing: boolean;
  /** Last message preview, without the "Me:" prefix. May be empty. */
  preview: string;
}

/**
 * Per-conversation key for state and dedupe: the username when known (two
 * buyers can share a display name, never a username), else the display name.
 */
export function rowKey(r: Pick<InboxRow, 'username' | 'name'>): string {
  return senderId(r.username, r.name);
}

const UNITS = '(?:sec|second|min|minute|hr|hour|day|week|wk|month|mo|year|yr)s?';
/** Relative or short-date times. Observed: "Just now", "1 minute", "19 hours", "6 days", "4 weeks", "5 months". */
const TIME = new RegExp(
  `^(?:just now|now|yesterday|today|an? ${UNITS}(?: ago)?|\\d+\\s*${UNITS}(?: ago)?|[A-Z][a-z]{2,8}\\.? \\d{1,2}(?:, \\d{4})?|\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?)$`,
  'i',
);
const COUNT = /^(\d{1,3})\+?$/;
const TYPING = /^typing(?:\.\.\.|…)?$/i;
const ME = /^me:\s*/i;

export function isTimeText(s: string): boolean {
  return TIME.test(s.trim());
}

/** The row's text nodes, trimmed, in document order. */
export function rowPieces(row: Element): string[] {
  const out: string[] = [];
  const walker = row.ownerDocument.createTreeWalker(row, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('script,style')) continue;
    const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

export function parseRowPieces(pieces: string[]): InboxRow | null {
  // The first time-like piece that has a name before it.
  const t = pieces.findIndex((p, i) => i >= 1 && isTimeText(p));
  if (t < 1) return null;
  const name = pieces[t - 1]!;
  const after = pieces.slice(t + 1);

  let unread = 0;
  const last = after[after.length - 1];
  if (last !== undefined && COUNT.test(last)) {
    unread = Number(COUNT.exec(last)![1]);
    after.pop();
  }

  let mine = false;
  if (after[0] !== undefined && ME.test(after[0])) {
    mine = true;
    after[0] = after[0].replace(ME, '');
    if (!after[0]) after.shift();
  }

  const preview = after.join(' ').trim();
  return { username: '', name, time: pieces[t]!, unread, mine, typing: TYPING.test(preview), preview };
}

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Username from an avatar element: `data-track-value`, or the figure's `title`. */
export function avatarUsername(avatar: Element | null): string {
  if (!avatar) return '';
  const v = oneLine(avatar.getAttribute('data-track-value')) || oneLine(avatar.querySelector('figure[title]')?.getAttribute('title'));
  return USERNAME.test(v) ? v : '';
}

/** Reads a row by its attributes. Null when the row does not have the known shape. */
export function parseRowStructure(row: Element): InboxRow | null {
  const name = oneLine(row.querySelector(INBOX.rowName)?.textContent);
  const excerpt = row.querySelector(INBOX.rowExcerpt);
  if (!name || !excerpt) return null;
  const username = avatarUsername(row.querySelector(INBOX.rowAvatar));

  // "Me: " is its own span at the start of the preview.
  const span = excerpt.querySelector(INBOX.rowPreview);
  const raw = (span ?? excerpt).textContent ?? '';
  const first = span?.firstElementChild;
  const mine = Boolean(first && ME.test(oneLine(first.textContent))) || ME.test(raw.trimStart());
  // Keep the line breaks of a long message; only trim the ends.
  const preview = (mine ? raw.trimStart().replace(ME, '') : raw).trim();

  let unread = 0;
  for (const p of Array.from(row.querySelectorAll(INBOX.rowCount))) {
    if (excerpt.contains(p)) continue;
    const m = COUNT.exec(oneLine(p.textContent));
    if (m) unread = Number(m[1]);
  }
  return {
    username,
    name,
    time: oneLine(row.querySelector(INBOX.rowTime)?.textContent),
    unread,
    mine,
    typing: TYPING.test(oneLine(preview)),
    preview,
  };
}

export function parseRow(row: Element): InboxRow | null {
  return parseRowStructure(row) ?? parseRowPieces(rowPieces(row));
}
