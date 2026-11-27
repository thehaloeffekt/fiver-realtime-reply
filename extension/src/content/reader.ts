/**
 * Reads the inbox and conversations in the watch tab, and the logged-in
 * username. Read-only: nothing here clicks, types or submits.
 * Selectors are in selectors.ts, each checked against a real capture.
 */
import { offsetFromClock, parseClock } from '../lib/buyerTime';
import type { BuyerHeader, ConversationRead, ConversationMessage, InboxSnapshot, ReadResult } from '../lib/messages';
import { avatarUsername, parseRow, type InboxRow } from '../lib/inboxRow';
import { CONVERSATION, CONVERSATION_HEADER, CONVERSATION_UI_TEXT, HEADER, INBOX } from '../lib/selectors';

/** Resolves with the first match, or null after `timeoutMs`. */
export function waitFor(selector: string, timeoutMs: number, root: ParentNode = document): Promise<Element | null> {
  const found = root.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = root.querySelector(selector);
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

/**
 * Resolves once `el`'s subtree had no changes for `quietMs` (or after
 * `maxMs`), so a list that renders in steps is read when complete. Right
 * after a load the page is not yet throttled, so these short timers run on time.
 */
export function waitForQuiet(el: Node, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      obs.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      resolve();
    };
    const obs = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    quiet = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The page id is added by the caller. */
export async function readInbox(): Promise<Omit<InboxSnapshot, 'page'>> {
  const first = await waitFor(INBOX.row, 15_000);
  if (first?.parentElement) await waitForQuiet(first.parentElement, 1200, 6000);
  return { unread: readUnreadChip(), rows: readRows() };
}

/**
 * Count on the "Unread" chip: the number of unread conversations. A chip
 * without a number means 0. No chip at all means this is not the inbox page.
 */
export function readUnreadChip(root: ParentNode = document): ReadResult<number> {
  const chip = root.querySelector(INBOX.unreadChip);
  if (!chip) return { ok: false, error: 'the Unread chip is not on the page' };
  for (const p of Array.from(chip.querySelectorAll(INBOX.unreadChipCount))) {
    const m = /^(\d{1,4})\+?$/.exec(oneLine(p.textContent));
    if (m) return { ok: true, value: Number(m[1]) };
  }
  return { ok: true, value: 0 };
}

/** All rows of the conversation list, top first. */
export function readRows(root: ParentNode = document): ReadResult<InboxRow[]> {
  const rows = Array.from(root.querySelectorAll(INBOX.row))
    .map(parseRow)
    .filter((r): r is InboxRow => r !== null);
  return { ok: true, value: rows };
}

/** One message of a conversation, as read from the page. */
export interface ParsedMessage extends ConversationMessage {
  /** The sender's username from the avatar ('' if the message had none). */
  sender: string;
  /** The page shows "Me" as the sender name. */
  me: boolean;
  /** The sender name in the message header ('' when grouped without one). */
  name: string;
}

const UI_TEXT = new Set<string>(CONVERSATION_UI_TEXT);
/** "1 File", "2 Files": the body of a message that has only files. */
const FILES_ONLY = /^\d+ files?$/i;

/**
 * Parses one `div.message`. The header row is the nearest ancestor of the
 * <time> that also holds a typography <p> (the sender name); body paragraphs
 * are the typography <p>s outside the header and outside the attachment area.
 */
export function parseMessage(el: Element): ParsedMessage | null {
  const content = el.querySelector(CONVERSATION.content);
  if (!content) return null;
  const time = content.querySelector(CONVERSATION.time);
  let header: Element | null = null;
  for (let a = time?.parentElement ?? null; a && a !== content; a = a.parentElement) {
    if (a.querySelector(CONVERSATION.text)) {
      header = a;
      break;
    }
  }
  const name = oneLine(header?.querySelector(CONVERSATION.text)?.textContent);

  const lines: string[] = [];
  for (const p of Array.from(content.querySelectorAll(CONVERSATION.text))) {
    if (header?.contains(p) || p.closest(CONVERSATION.attachmentArea)) continue;
    const t = (p.textContent ?? '').trim();
    if (t && !UI_TEXT.has(oneLine(t))) lines.push(t);
  }
  const files = Array.from(el.querySelectorAll(CONVERSATION.attachment))
    .map((a) => oneLine(a.getAttribute('title')))
    .filter(Boolean);
  let body = lines.join('\n');
  if (files.length && FILES_ONLY.test(oneLine(body))) body = '';

  return {
    id: el.id,
    sender: avatarUsername(el.querySelector(CONVERSATION.sender)),
    me: name.toLowerCase() === 'me',
    name,
    time: oneLine(time?.textContent),
    text: body,
    files,
  };
}

/**
 * All messages on the page, oldest first, one per id. A message without an
 * avatar or time (if Fiverr groups messages) takes them from the one before.
 */
export function parseConversation(root: ParentNode = document): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const seen = new Set<string>();
  let last: ParsedMessage | null = null;
  for (const el of Array.from(root.querySelectorAll(CONVERSATION.message))) {
    const m = parseMessage(el);
    if (!m || (m.id && seen.has(m.id))) continue;
    if (m.id) seen.add(m.id);
    if (!m.sender && last) {
      m.sender = last.sender;
      m.me = m.me || last.me;
      m.name ||= last.name;
    }
    if (!m.time && last) m.time = last.time;
    out.push(m);
    last = m;
  }
  return out;
}

/** The last `limit` messages that are not mine. */
export function buyerMessages(all: ParsedMessage[], limit: number, myUsername?: string): ConversationMessage[] {
  const me = myUsername?.toLowerCase();
  return all
    .filter((m) => !m.me && !(me && m.sender.toLowerCase() === me))
    .slice(-limit)
    .map(({ id, time, text, files }) => ({ id, time, text, files }));
}

/**
 * The buyer's last `limit` messages, oldest first, read from the open
 * conversation, plus the header (buyer's UTC offset) when it is shown.
 */
export async function readConversation(limit: number, myUsername?: string): Promise<ReadResult<ConversationRead>> {
  const first = await waitFor(CONVERSATION.message, 15_000);
  if (first?.parentElement) await waitForQuiet(first.parentElement, 1200, 6000);
  const messages = first ? buyerMessages(parseConversation(), limit, myUsername ?? readLoggedInUsername() ?? undefined) : [];
  return { ok: true, value: { messages, header: readBuyerHeader(conversationUsername(location.pathname), Date.now()) } };
}

/** "/inbox/some_buyer" → "some_buyer"; '' on other pages. */
export function conversationUsername(path: string): string {
  const m = /^\/inbox\/([A-Za-z0-9_.-]{1,64})\/?$/.exec(path);
  return m ? m[1]! : '';
}

/**
 * The buyer's local time from the conversation header: a <time> whose next
 * element says "(local time)". Returns the UTC offset it implies at `now`.
 * The header avatar must name `username` (when it has one), so a header
 * left over from the previous conversation during a page change is not
 * taken for this buyer. Null when there is no such clock.
 */
export function readBuyerHeader(username: string, now: number, root: ParentNode = document): BuyerHeader | null {
  if (!username) return null;
  for (const header of Array.from(root.querySelectorAll(CONVERSATION_HEADER.header))) {
    const clock = Array.from(header.querySelectorAll(CONVERSATION_HEADER.clock)).find(
      (t) => oneLine(t.nextElementSibling?.textContent).toLowerCase() === CONVERSATION_HEADER.clockLabel,
    );
    if (!clock) continue;
    const who = avatarUsername(header.querySelector(CONVERSATION_HEADER.avatar));
    if (who && who.toLowerCase() !== username.toLowerCase()) return null;
    const minutes = parseClock(oneLine(clock.textContent));
    if (minutes === null) return null;
    const out: BuyerHeader = { username: who || username, offset: offsetFromClock(minutes, now), clock: oneLine(clock.textContent) };
    const country = readCountry(root);
    if (country) out.country = country;
    return out;
  }
  return null;
}

/**
 * The buyer's country from the details pane: the list item whose label is
 * exactly "From". '' when the pane is closed or has no such row. Only a
 * short plain name is accepted.
 */
export function readCountry(root: ParentNode = document): string {
  const H = CONVERSATION_HEADER;
  for (const pane of Array.from(root.querySelectorAll(H.detailsPane))) {
    for (const item of Array.from(pane.querySelectorAll(H.detailsItem))) {
      if (oneLine(item.querySelector(H.detailsLabel)?.textContent) !== H.fromLabel) continue;
      const value = oneLine(item.querySelector(H.detailsValue)?.textContent);
      if (/^[\p{L}][\p{L} .,'()&-]{1,59}$/u.test(value)) return value;
    }
  }
  return '';
}

/**
 * The logged-in username from the profile button in the page header. Only
 * an avatar inside `.main-header`, or one whose img alt equals its value
 * (buyer avatars use alt="Profile Image"), counts: the conversation page has
 * a second <header> with the buyer's avatar.
 */
export function readLoggedInUsername(root: ParentNode = document): string | null {
  for (const a of Array.from(root.querySelectorAll(HEADER.avatar))) {
    const value = avatarUsername(a);
    if (!value) continue;
    const alt = a.querySelector('img[alt]')?.getAttribute('alt');
    if (a.closest(HEADER.mainHeader) || alt === value) return value;
  }
  return null;
}

/** Same, waiting up to `timeoutMs` for the header to render. */
export async function waitForLoggedInUsername(timeoutMs: number): Promise<string | null> {
  const now = readLoggedInUsername();
  if (now) return now;
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const u = readLoggedInUsername();
      if (u) finish(u);
    });
    const finish = (u: string | null) => {
      obs.disconnect();
      clearTimeout(timer);
      resolve(u);
    };
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
