/**
 * Every CSS selector the extension uses on fiverr.com lives in this file.
 *
 * Rules:
 * - Never use hashed class names (for example `effeba9` or `_4acffc`). Fiverr
 *   regenerates them on each build. Use semantic class names, data-testid
 *   values, element types and href patterns.
 * - A selector set to `null` is a placeholder: we have no real HTML sample for
 *   that area yet. Code that needs it reports "selector missing" instead of
 *   guessing. Use the popup's Debug capture to collect a sample, then fill it in.
 */

/** Realtime toast notifications. Confirmed from a real sample. */
export const TOAST = {
  /** Container that Fiverr adds once, then fills with toasts. May not exist at page load. */
  container: 'ul.realtime-notifications',
  /** One toast. Only those whose data-testid starts with TOAST_INBOX_PREFIX are messages. */
  item: 'li.toast',
  /** Link to the conversation; the username is the path segment after /conversations/. */
  link: 'a[href*="/conversations/"]',
  displayName: 'strong.display-name',
  username: 'span.username',
  /** The message text is the direct text of this element. */
  content: 'p.content',
  /** Holds the name and @username inside p.content. Skipped when reading the body. */
  contentHeader: 'div.content-container',
} as const;

export const TOAST_INBOX_PREFIX = 'inbox_';
export const CONVERSATION_PATH = '/conversations/';

/**
 * Inbox page (https://www.fiverr.com/inbox). PLACEHOLDERS: no HTML sample yet.
 * Capture with the popup: Debug capture → "Unread badge" and "Inbox list".
 */
export const INBOX: {
  /** Element whose text is the unread message count (for example the badge on the inbox icon). */
  unreadBadge: string | null;
  /** One row of the conversation list that is unread. */
  unreadRow: string | null;
  /** Inside an unread row: the element with the contact's name. */
  rowName: string | null;
} = {
  unreadBadge: null, // TODO(capture: unreadBadge)
  unreadRow: null, // TODO(capture: inboxList)
  rowName: null, // TODO(capture: inboxList)
};

/**
 * Conversation page (https://www.fiverr.com/inbox/{username}). PLACEHOLDERS.
 * Capture with the popup: Debug capture → "Conversation messages".
 */
export const CONVERSATION: {
  /** One message in the thread. */
  message: string | null;
  /**
   * Matches a message sent by the logged-in seller (tested with
   * `element.matches()` on each message). Messages that do not match are
   * treated as the buyer's.
   */
  ownMessage: string | null;
  /** Inside a message: the element with the text. */
  messageText: string | null;
  /** Inside a message: one attachment (file or image). Each match becomes "[attachment]". */
  attachment: string | null;
} = {
  message: null, // TODO(capture: conversation)
  ownMessage: null, // TODO(capture: conversation)
  messageText: null, // TODO(capture: conversation)
  attachment: null, // TODO(capture: conversation)
};

/**
 * Header on any Fiverr page. PLACEHOLDER. Used for the default account label.
 * Capture with the popup: Debug capture → "Account menu".
 */
export const HEADER: {
  /** Element whose text (or href, see `loggedInUsernameAttr`) holds the logged-in username. */
  loggedInUsername: string | null;
  /** Read this attribute instead of the text, for example "href". The last path segment is used. */
  loggedInUsernameAttr: string | null;
} = {
  loggedInUsername: null, // TODO(capture: accountMenu)
  loggedInUsernameAttr: null,
};

/** The four areas the Debug capture can collect, with instructions for the user. */
export const CAPTURE_TARGETS = {
  unreadBadge: {
    title: 'Unread badge',
    where: 'Any Fiverr page with at least 1 unread message',
    pick: 'the unread count on the inbox (envelope) icon',
  },
  inboxList: {
    title: 'Inbox list',
    where: 'https://www.fiverr.com/inbox with at least 1 unread conversation',
    pick: 'the whole conversation list (click one row, then press ↑ until the outline covers the list)',
  },
  conversation: {
    title: 'Conversation messages',
    where: 'https://www.fiverr.com/inbox/{a buyer} with messages from both sides and one file',
    pick: 'the message thread (click one message, then press ↑ until the outline covers the thread)',
  },
  accountMenu: {
    title: 'Account menu',
    where: 'Any Fiverr page, logged in',
    pick: 'your profile picture or username in the top bar',
  },
} as const;

export type CaptureKind = keyof typeof CAPTURE_TARGETS;
