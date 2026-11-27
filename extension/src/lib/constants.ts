export const DEFAULT_RELAY_URL = 'https://fta-relay.fiverelay.workers.dev';
export const FIVERR_ORIGIN = 'https://www.fiverr.com';
export const INBOX_URL = `${FIVERR_ORIGIN}/inbox`;
export const inboxUrlFor = (username: string) => `${INBOX_URL}/${encodeURIComponent(username)}`;
/** Telegram rejects a message whose text (after HTML parsing) is over 4096 characters. */
export const TELEGRAM_MAX_CHARS = 4096;
/** What we fill a message to at most: a margin under TELEGRAM_MAX_CHARS. */
export const SAFE_MESSAGE_CHARS = 4000;
/** An alert's message body is cut at this length, leaving room for the other lines. */
export const MAX_BODY_CHARS = 3500;
/** Each buyer message in a "Full message" reply is cut at this length. */
export const FULL_MESSAGE_CHARS = 1500;
/** At most this many file names per message; the rest are counted. */
export const MAX_FILES_SHOWN = 10;
/** A "Full message" reply is split into at most this many Telegram messages. */
export const MAX_FULL_PARTS = 5;
