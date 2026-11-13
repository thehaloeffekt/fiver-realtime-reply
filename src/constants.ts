/**
 * Shared relay constants. They live here, not in src/index.ts, because the
 * Worker entry module may export only handlers and Durable Object classes:
 * workerd treats every export of the entry module as an entrypoint and
 * refuses to start when one is a plain value.
 */

/** Largest webhook body accepted from Telegram. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

/** Header in which Telegram sends the webhook secret_token. */
export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
