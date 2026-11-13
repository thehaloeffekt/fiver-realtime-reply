import { getLocal, removeLocal, setLocal } from '../lib/storage';
import { setWebhook } from '../lib/telegram';
import { connectRelay, disconnectRelay } from './relay';
import { closeWatchTab, ensureWatchTab } from './watchTab';
import { describeTelegramError } from './notify';
import { TelegramError } from '../lib/telegram';

/** How long the options page waits for /start at step 3. */
const LINK_WAIT_MS = 15 * 60_000;

/**
 * Setup step 2. The order matters: the relay stores the bot's secret on the
 * first WebSocket auth (trust on first use) and answers 401 to webhooks before
 * that. So connect first, then point Telegram at the relay.
 */
export async function connectAndRegisterWebhook(): Promise<{ webhookUrl: string }> {
  const s = await getLocal();
  if (!s.token || !s.botKey || !s.secret) throw new Error('Add the bot token first.');
  await connectRelay(true);
  const webhookUrl = `${s.relayUrl.replace(/\/+$/, '')}/hook/${s.botKey}`;
  try {
    await setWebhook(s.token, webhookUrl, s.secret);
  } catch (e) {
    throw new Error(e instanceof TelegramError ? describeTelegramError(e) : String(e));
  }
  await setLocal({ webhookUrl, linkWaitUntil: s.chatId ? undefined : Date.now() + LINK_WAIT_MS });
  return { webhookUrl };
}

/** Step 3 "waiting for /start" (again). */
export async function waitForStart(): Promise<void> {
  await setLocal({ linkWaitUntil: Date.now() + LINK_WAIT_MS });
}

/** Called when a chat gets linked: the profile is ready, so open the watch tab. */
export async function onLinked(): Promise<void> {
  await ensureWatchTab();
}

/**
 * "Disconnect this profile": forget the token and the chat on this profile
 * only. The webhook stays, because other profiles on the same bot still use it.
 */
export async function disconnectProfile(): Promise<void> {
  await disconnectRelay();
  await closeWatchTab();
  await removeLocal(['token', 'bot', 'botKey', 'secret', 'chatId', 'webhookUrl', 'linkWaitUntil', 'lastUnread', 'pendingClaims']);
}
