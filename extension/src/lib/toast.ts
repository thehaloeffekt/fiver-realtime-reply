import { CONVERSATION_PATH, TOAST, TOAST_INBOX_PREFIX } from './selectors';

/** What a Fiverr inbox toast tells us. */
export interface Toast {
  /** data-testid of the toast, e.g. "inbox_189578167_237979855". Identifies the conversation, not the message. */
  conversationId: string;
  /** Buyer username without "@". */
  username: string;
  displayName: string;
  /** Message text as shown in the toast (trimmed, may be empty). */
  body: string;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** True if `el` is an inbox message toast (li.toast with data-testid "inbox_…"). */
export function isInboxToast(el: Element): boolean {
  if (el.nodeType !== ELEMENT_NODE || !el.matches(TOAST.item)) return false;
  return (el.getAttribute('data-testid') ?? '').startsWith(TOAST_INBOX_PREFIX);
}

/** Path segment after "/conversations/", without query or hash. */
export function usernameFromHref(href: string | null | undefined): string {
  if (!href) return '';
  const i = href.indexOf(CONVERSATION_PATH);
  if (i < 0) return '';
  const rest = href.slice(i + CONVERSATION_PATH.length);
  const segment = rest.split(/[/?#]/)[0] ?? '';
  try {
    return decodeURIComponent(segment).trim();
  } catch {
    return segment.trim();
  }
}

/** Joins the direct text-node children of `el`, skipping element children. */
function directText(el: Element, after?: Element): string {
  let seen = !after;
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (!seen) {
      if (node === after) seen = true;
      continue;
    }
    if (node.nodeType === TEXT_NODE) out += node.textContent ?? '';
  }
  return out;
}

/**
 * Body = the direct text nodes of p.content, which skips div.content-container
 * (name and @username).
 *
 * Fiverr renders p.content with a div inside it through the DOM, which is how
 * the live page looks. If the same markup ever arrives as HTML text, the
 * browser's parser closes the <p> at the <div>, and the text ends up next to
 * div.content-container instead of inside p.content. Handle that case too.
 */
function readBody(li: Element): string {
  const content = li.querySelector(TOAST.content);
  if (content && content.querySelector(TOAST.contentHeader)) return directText(content).trim();
  const header = li.querySelector(TOAST.contentHeader);
  if (header?.parentElement) return directText(header.parentElement, header).trim();
  return content ? directText(content).trim() : '';
}

/** Parses one toast. Returns null for non-inbox toasts or when the username is missing. */
export function parseToast(li: Element): Toast | null {
  if (!isInboxToast(li)) return null;
  const conversationId = li.getAttribute('data-testid') ?? '';

  const link = li.querySelector(TOAST.link);
  let username = usernameFromHref(link?.getAttribute('href'));
  if (!username) {
    username = (li.querySelector(TOAST.username)?.textContent ?? '').trim().replace(/^@/, '');
  }
  if (!username) return null;

  const displayName = (li.querySelector(TOAST.displayName)?.textContent ?? '').trim() || username;
  return { conversationId, username, displayName, body: readBody(li) };
}

/** Fiverr shows "1 File" / "3 Files" for a message that has only attachments. */
const ATTACHMENT_ONLY = /^(\d+) Files?$/;

export type BodyKind = 'text' | 'attachment' | 'empty';

/** Applies the attachment and empty-body rules to a toast body. */
export function describeBody(body: string): { kind: BodyKind; text: string; files?: number } {
  const trimmed = body.trim();
  if (!trimmed) return { kind: 'empty', text: '(empty message, check Fiverr)' };
  const m = ATTACHMENT_ONLY.exec(trimmed);
  if (m) {
    const n = Number(m[1]);
    return { kind: 'attachment', files: n, text: `Sent ${n} ${n === 1 ? 'file' : 'files'}. Check Fiverr.` };
  }
  return { kind: 'text', text: trimmed };
}
