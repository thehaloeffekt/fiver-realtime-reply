/**
 * Minimal Telegram Bot API client. Text only: this module has no method that
 * uploads files or photos, by design.
 *
 * The token is only ever put into URLs on api.telegram.org.
 */

import { wellFormed } from './split';

const API = 'https://api.telegram.org';

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}
export type InlineKeyboard = InlineButton[][];

export interface BotInfo {
  id: number;
  username: string;
  first_name: string;
}

export interface SentMessage {
  message_id: number;
  chat: { id: number };
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${status} ${description}`);
  }

  /** 4xx errors other than 429 will fail again; do not retry them. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CallOptions {
  /** Extra attempts after the first one. */
  retries?: number;
  /** First backoff delay; doubles each time. */
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/** Calls a Bot API method. Retries network errors, 429 and 5xx with backoff. */
export async function callApi<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  { retries = 0, baseDelayMs = 1000, fetchImpl = fetch }: CallOptions = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await callOnce<T>(fetchImpl, token, method, params);
    } catch (err) {
      const tgErr = err instanceof TelegramError ? err : new TelegramError(method, 0, String(err));
      if (!tgErr.retryable || attempt >= retries) throw tgErr;
      const backoff = baseDelayMs * 2 ** attempt;
      await sleep(Math.max(backoff, (tgErr.retryAfter ?? 0) * 1000));
      attempt++;
    }
  }
}

async function callOnce<T>(fetchImpl: typeof fetch, token: string, method: string, params: Record<string, unknown>) {
  const res = await fetchImpl(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  let json: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
  try {
    json = await res.json();
  } catch {
    throw new TelegramError(method, res.status || 0, 'invalid response');
  }
  if (!json.ok) {
    throw new TelegramError(method, res.status, json.description ?? 'error', json.parameters?.retry_after);
  }
  return json.result as T;
}

export const getMe = (token: string) => callApi<BotInfo>(token, 'getMe');

export interface SendOptions {
  keyboard?: InlineKeyboard;
  replyTo?: number;
  retries?: number;
}

/**
 * Sends an HTML message. Alerts use retries = 3. Lone surrogates (half an
 * emoji, from a cut somewhere upstream) are replaced, because Telegram
 * refuses text that is not valid UTF-8.
 */
export function sendMessage(token: string, chatId: number, html: string, opts: SendOptions = {}) {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text: wellFormed(html),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (opts.keyboard) params.reply_markup = { inline_keyboard: opts.keyboard };
  if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  return callApi<SentMessage>(token, 'sendMessage', params, { retries: opts.retries ?? 0 });
}

/**
 * Replaces the text of a message the bot sent. Without `keyboard` its buttons
 * are removed (used to turn a reply preview into "Sent", "Cancelled", …).
 */
export function editMessageText(token: string, chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard) {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: wellFormed(html),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard ?? [] },
  };
  return callApi<unknown>(token, 'editMessageText', params, { retries: 2 });
}

export function answerCallbackQuery(token: string, id: string, text?: string) {
  return callApi<boolean>(token, 'answerCallbackQuery', text ? { callback_query_id: id, text } : { callback_query_id: id });
}

export function setWebhook(token: string, url: string, secret: string) {
  return callApi<boolean>(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
  }, { retries: 2 });
}

/**
 * Removes the webhook. Only when the last profile on the bot disconnects:
 * the webhook is shared by every profile on the bot.
 */
export function deleteWebhook(token: string) {
  return callApi<boolean>(token, 'deleteWebhook', { drop_pending_updates: true }, { retries: 1 });
}

export interface BotCommand {
  command: string;
  description: string;
}

/** The list in Telegram's "/" menu. Every profile on the bot sets the same list. */
export function setMyCommands(token: string, commands: BotCommand[]) {
  return callApi<boolean>(token, 'setMyCommands', { commands }, { retries: 2 });
}

/** Escapes text for parse_mode HTML. Telegram needs only &, < and >. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
