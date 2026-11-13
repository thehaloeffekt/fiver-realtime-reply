/**
 * Every message to Telegram goes out from here, straight to api.telegram.org.
 * The relay is not involved, so alerts keep working when it is down.
 */
import { getLocal, updateSession } from '../lib/storage';
import { TelegramError, answerCallbackQuery, sendMessage, type InlineKeyboard, type SentMessage } from '../lib/telegram';
import { claim } from './relay';

export interface NotifyOptions {
  keyboard?: InlineKeyboard;
  replyTo?: number;
  /** Tell the relay we sent it, so presses and replies on it come back here. */
  claim?: boolean;
  retries?: number;
}

function recordTelegram(ok: boolean, err?: unknown) {
  if (ok) return updateSession('telegram', () => ({ lastOkAt: Date.now() }));
  const description = err instanceof TelegramError ? describeTelegramError(err) : String(err);
  return updateSession('telegram', (t) => ({ ...t, lastError: description, lastErrorAt: Date.now() }));
}

export function describeTelegramError(err: TelegramError): string {
  if (err.status === 401) return 'Telegram rejected the bot token. Paste it again in Settings.';
  if (err.status === 403) return 'The bot cannot write to you. Open the bot in Telegram and press Start.';
  if (err.status === 0) return 'Cannot reach Telegram. Check the internet connection.';
  return err.description;
}

/** Sends to the linked chat. Throws if the profile is not linked or Telegram fails after retries. */
export async function notify(html: string, opts: NotifyOptions = {}): Promise<SentMessage> {
  const s = await getLocal();
  if (!s.token || !s.chatId) throw new Error('This profile is not linked to a Telegram chat yet.');
  try {
    const sent = await sendMessage(s.token, s.chatId, html, { keyboard: opts.keyboard, replyTo: opts.replyTo, retries: opts.retries ?? 1 });
    void recordTelegram(true);
    if (opts.claim) await claim(sent.chat.id, sent.message_id);
    return sent;
  } catch (err) {
    void recordTelegram(false, err);
    throw err;
  }
}

/** Sends to a chat id that is not saved yet (the "Linked" reply). */
export async function sendTo(chatId: number, html: string): Promise<void> {
  const { token } = await getLocal();
  if (token) await sendMessage(token, chatId, html, { retries: 1 });
}

export async function answerCallback(id: string, text?: string): Promise<void> {
  const { token } = await getLocal();
  if (!token) return;
  try {
    await answerCallbackQuery(token, id, text);
  } catch {
    // Another profile may have answered first, or the query is older than 15 min.
  }
}
