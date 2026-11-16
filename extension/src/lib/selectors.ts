/**
 * Every CSS selector the extension uses on fiverr.com lives in this file.
 *
 * Rules:
 * - Never use hashed class names (for example `effeba9` or `_4acffc`). Fiverr
 *   regenerates them on each build. Use semantic class names, data-testid
 *   values, element types and href patterns.
 * - Prefer data-testid and data-track-tag / data-track-value attributes:
 *   they are what Fiverr's own tracking uses, so they change less often.
 * - Every selector here was checked against a real HTML capture. When Fiverr
 *   changes its markup, use the popup's Debug capture to collect a new one.
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
 * Inbox page (https://www.fiverr.com/inbox). Confirmed from real captures
 * (2026-11-16): tests/fixtures/inbox-list.html, inbox-row.html, unread-chip.html.
 *
 *   <div role="button" data-testid="contact">                     row
 *     <div data-track-tag="avatar" data-track-value="{username}">  username
 *       <figure title="{username}">                                same value
 *     <p data-track-tag="text">{display name}</p>
 *     <time>{relative time}</time>
 *     <div class="contact-excerpt">                                may be empty
 *       <span data-track-tag="text"><span>Me: </span>{full last message}</span>
 *     <p data-track-tag="typography">{unread count}</p>            only when unread
 */
export const INBOX = {
  /** One row of the conversation list. Its parent is the list. */
  row: '[data-testid="contact"]',
  /** Inside a row: has the username in `data-track-value`. */
  rowAvatar: '[data-track-tag="avatar"][data-track-value]',
  /** Inside a row: the first match is the display name. */
  rowName: 'p[data-track-tag="text"]',
  rowTime: 'time',
  /** Inside a row: the last-message preview area (empty on some unread rows). */
  rowExcerpt: '.contact-excerpt',
  /** Inside the excerpt: the preview text; its first child span is "Me: " for my own message. */
  rowPreview: 'span[data-track-tag="text"]',
  /** Inside a row: the unread count badge is the one whose text is a number. */
  rowCount: 'p[data-track-tag="typography"]',
  /**
   * The "Unread" filter chip above the list. Its count (a typography <p>
   * inside it) is the number of unread conversations, not messages.
   */
  unreadChip: 'button[aria-label="Unread"]',
  unreadChipCount: 'p[data-track-tag="typography"]',
} as const;

/**
 * Conversation page (https://www.fiverr.com/inbox/{username}). Confirmed from
 * a real capture (2026-11-16): tests/fixtures/conversation.html.
 *
 *   <div class="message" id="{conversation uuid}_{message uuid}">
 *     <div data-track-tag="avatar" data-track-value="{sender username}">
 *     <div class="message-content">
 *       <p data-track-tag="typography">{sender name, "Me" for mine}</p>  header row,
 *       <time>Nov 15, 9:51 PM</time>                                    with the time
 *       <p data-track-tag="typography">{body}</p>       "1 File" for a file-only message
 *       <div class="attachment" title="{file name}"> … download_icon … (size)
 *       <button data-track-tag="text_button">Translate to English</button>
 *
 * The id's second half is a version-1 (time-based) UUID whose timestamp is
 * the message's send time, and every id in the capture is unique, so it is
 * Fiverr's message id: stable across reloads and unique per message.
 */
export const CONVERSATION = {
  message: 'div.message[id]',
  /** Inside a message: the sender's username in `data-track-value`. */
  sender: '[data-track-tag="avatar"][data-track-value]',
  content: '.message-content',
  /** Inside the content: the sender name (header) and the body paragraphs. */
  text: 'p[data-track-tag="typography"]',
  time: 'time',
  /** Inside a message: one file; its name is the `title`. */
  attachment: '.attachment[title]',
  /** Containers whose text is never part of the body. */
  attachmentArea: '.attachments-list, .attachment',
} as const;

/** Interface text that may sit inside a message but is not the buyer's words. */
export const CONVERSATION_UI_TEXT = ['Translate to English', 'Create an offer'] as const;

/**
 * Header on any Fiverr page. Confirmed from a real capture
 * (tests/fixtures/account-menu.html): the profile button holds
 * `<div data-track-tag="avatar" data-track-value="{my username}">` and its
 * img has the same value in `alt`. Buyer avatars elsewhere use
 * alt="Profile Image", and the conversation page has its own <header> with
 * the buyer's avatar, so the match must be inside `.main-header` or have an
 * img whose alt equals the value.
 */
export const HEADER = {
  avatar: 'header [data-track-tag="avatar"][data-track-value]',
  mainHeader: '.main-header',
} as const;

/** The four areas the Debug capture can collect, with instructions for the user. */
export const CAPTURE_TARGETS = {
  unreadBadge: {
    title: 'Unread chip',
    where: 'https://www.fiverr.com/inbox with at least 1 unread conversation',
    pick: 'the "Unread" filter chip with its count, above the conversation list',
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
