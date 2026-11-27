import { browser } from 'wxt/browser';
import { newAccountId, newRemovalCode, uninstallUrl } from '../lib/keys';
import { getLocal, getSession, labelOf, setLocal, type LocalState, type PresenceAccount } from '../lib/storage';
import { deleteWebhook, escapeHtml, setWebhook } from '../lib/telegram';
import { connectRelay, disconnectRelay, forgetSelf } from './relay';
import { closeWatchTab, ensureWatchTab } from './watchTab';
import { describeTelegramError, notify } from './notify';
import { registerCommands } from './commands';
import { TelegramError } from '../lib/telegram';

/** How long the options page waits for /start at step 3. */
const LINK_WAIT_MS = 15 * 60_000;

/** The one-minute relay check (reconnect and watchdog). Cleared on removal, so setup creates it again. */
export const RELAY_ALARM = 'relay-check';

export async function ensureRelayAlarm(): Promise<void> {
  if (!(await browser.alarms.get(RELAY_ALARM))) await browser.alarms.create(RELAY_ALARM, { periodInMinutes: 1 });
}

/**
 * Setup step 2. The order matters: the relay stores the bot's secret on the
 * first WebSocket auth (trust on first use) and answers 401 to webhooks before
 * that. So connect first, then point Telegram at the relay.
 */
export async function connectAndRegisterWebhook(): Promise<{ webhookUrl: string }> {
  let s = await getLocal();
  if (!s.token || !s.botKey || !s.secret) throw new Error('Add the bot token first.');
  // The removal code is made here, before the auth that sends its hash.
  if (!s.removalCode || !s.accountId) {
    await setLocal({ removalCode: s.removalCode ?? newRemovalCode(), accountId: s.accountId ?? newAccountId() });
    s = await getLocal();
  }
  await ensureRelayAlarm();
  await connectRelay(true);
  const webhookUrl = `${s.relayUrl.replace(/\/+$/, '')}/hook/${s.botKey}`;
  try {
    await setWebhook(s.token!, webhookUrl, s.secret!);
  } catch (e) {
    throw new Error(e instanceof TelegramError ? describeTelegramError(e) : String(e));
  }
  await setLocal({ webhookUrl, linkWaitUntil: s.chatId ? undefined : Date.now() + LINK_WAIT_MS });
  await applyUninstallUrl();
  // The "/" menu in Telegram. Not needed for the commands to work, so not awaited.
  void registerCommands();
  return { webhookUrl };
}

/**
 * Points Chrome's uninstall page at the relay's GET /bye for this account,
 * or clears it when there is nothing to remove. Runs at setup, at every
 * worker start and when the relay keys change.
 */
export async function applyUninstallUrl(s?: LocalState): Promise<string | null> {
  s ??= await getLocal();
  const url = s.botKey && s.accountId && s.removalCode ? uninstallUrl(s.relayUrl, s.botKey, s.accountId, s.removalCode) : null;
  if (s.botKey && s.removalCode && !url) console.warn('[setup] uninstall URL too long for Chrome; the relay URL is too long');
  await browser.runtime.setUninstallURL(url ?? '').catch((e: unknown) => console.warn('[setup] setUninstallURL failed', e));
  return url;
}

/** Step 3 "waiting for /start" (again). */
export async function waitForStart(): Promise<void> {
  await setLocal({ linkWaitUntil: Date.now() + LINK_WAIT_MS });
}

/** Called when a chat gets linked: the profile is ready, so open the watch tab. */
export async function onLinked(): Promise<void> {
  await ensureWatchTab();
}

export function disconnectedText(label: string): string {
  return `<b>${escapeHtml(label)}</b> was disconnected from this bot.`;
}

/**
 * True only when the relay's account list is known and holds no account but
 * this one. An empty list means "unknown" (the relay was never reached), and
 * then the webhook stays: deleting it would cut off the other profiles.
 */
export function isLastAccount(presence: PresenceAccount[], accountId: string | undefined): boolean {
  return Boolean(accountId) && presence.length > 0 && presence.every((a) => a.accountId === accountId);
}

export interface DisconnectResult {
  /** Telegram got the "was disconnected" notice. */
  noticeSent: boolean;
  /** The relay confirmed that it forgot this account. */
  relayForgot: boolean;
  /** This was the last account, and the webhook was deleted. */
  webhookDeleted: boolean;
}

/**
 * "Disconnect this profile" (Settings). The order matters: the notice needs
 * the token and the chat, the forget frame needs the socket, deleteWebhook
 * needs the token. So storage is cleared last. Each step that talks to the
 * network may fail; the profile is still cleared at the end, because the
 * user asked for it to be gone.
 */
export async function disconnectProfile(): Promise<DisconnectResult> {
  const s = await getLocal();
  const result: DisconnectResult = { noticeSent: false, relayForgot: false, webhookDeleted: false };

  // 1. Telegram notice.
  if (s.token && s.chatId) {
    result.noticeSent = await notify(disconnectedText(labelOf(s))).then(
      () => true,
      () => false,
    );
  }
  // 2. Forget frame. It connects first if needed, so presence is fresh after it.
  if (s.botKey && s.secret) result.relayForgot = await forgetSelf();
  const { presence } = await getSession();
  // 3. Socket. 4. Watch tab. 5. Alarms.
  await disconnectRelay();
  await closeWatchTab();
  await browser.alarms.clearAll();
  // The webhook is shared by every profile on the bot: delete it only for the last one.
  if (s.token && isLastAccount(presence, s.accountId)) {
    result.webhookDeleted = await deleteWebhook(s.token).then(
      () => true,
      () => false,
    );
  }
  // 6. Storage, last.
  await wipeStorage();
  return result;
}

let removing: Promise<void> | null = null;

/**
 * The relay removed this profile from somewhere else (/remove in Telegram,
 * or the same account's uninstall URL). Stop, clear, and say so in the
 * popup. Without this the profile would try to reconnect again and again.
 * No Telegram notice from here: the relay tells another profile, which
 * posts "was removed from this bot".
 */
export function onRemovedRemotely(): Promise<void> {
  removing ??= (async () => {
    await disconnectRelay();
    await closeWatchTab();
    await browser.alarms.clearAll();
    await wipeStorage({ removedAt: Date.now() });
  })().finally(() => (removing = null));
  return removing;
}

/**
 * Clears all extension storage, then writes a new random accountId. The new
 * id is what makes a later setup clean: the relay keeps the old id on its
 * removed list, so only an old copy of this profile is refused, never a
 * new setup. The uninstall URL is cleared too: there is nothing to remove.
 */
async function wipeStorage(keep: Partial<LocalState> = {}): Promise<void> {
  await browser.storage.local.clear();
  await browser.storage.session.clear();
  await setLocal({ accountId: newAccountId(), ...keep });
  await browser.runtime.setUninstallURL('').catch(() => undefined);
}
