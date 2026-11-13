export const DEFAULT_RELAY_URL = 'https://fta-relay.fiverelay.workers.dev';
export const FIVERR_ORIGIN = 'https://www.fiverr.com';
export const INBOX_URL = `${FIVERR_ORIGIN}/inbox`;
export const inboxUrlFor = (username: string) => `${INBOX_URL}/${encodeURIComponent(username)}`;
/** Telegram rejects messages over 4096 characters; keep room for the header. */
export const MAX_BODY_CHARS = 3500;
