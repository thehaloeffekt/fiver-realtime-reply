import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { afterReload, handleToast, sendTestAlert } from '../background/alerts';
import { handleOffline, handleUpdate } from '../background/commands';
import { connectRelay, relayHeartbeat, retryRelayNow, setRelayHandlers } from '../background/relay';
import { connectAndRegisterWebhook, disconnectProfile, onLinked, waitForStart } from '../background/setup';
import { RELOAD_ALARM, ensureWatchTab, onTabRemoved, reloadAndRead, scheduleReload } from '../background/watchTab';
import { FIVERR_ORIGIN } from '../lib/constants';
import { newAccountId } from '../lib/keys';
import type { ContentToBackground, UiToBackground } from '../lib/messages';
import { getLocal, isConfigured, setLocal, updateLocal } from '../lib/storage';

const RELAY_ALARM = 'relay-check';

export default defineBackground({
  type: 'module',
  main() {
    setRelayHandlers({
      onUpdate: (update, routed) => void handleUpdate(update, routed),
      onOffline: (accountId, label) => void handleOffline(accountId, label),
    });

    // Listeners are registered synchronously so Chrome can wake the worker for them.
    browser.runtime.onStartup.addListener(() => void boot());
    browser.runtime.onInstalled.addListener(() => void boot());
    browser.alarms.onAlarm.addListener((alarm) => void onAlarm(alarm));
    browser.tabs.onRemoved.addListener((tabId, info) => void onTabRemoved(tabId, info));
    browser.storage.onChanged.addListener(onStorageChanged);
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      handleMessage(msg, sender).then(
        (data) => sendResponse({ ok: true, ...(data ?? {}) }),
        (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true; // async response
    });

    void boot();
  },
});

let booting: Promise<void> | null = null;

/** Runs on every worker start: browser start, install/update, or a wake-up after idle. */
function boot(): Promise<void> {
  booting ??= (async () => {
    const s = await getLocal();
    if (!s.accountId) await setLocal({ accountId: newAccountId() });
    // Reconnect check every minute. It also wakes a stopped worker.
    if (!(await browser.alarms.get(RELAY_ALARM))) await browser.alarms.create(RELAY_ALARM, { periodInMinutes: 1 });
    await connectRelay().catch(() => undefined);
    if (isConfigured(await getLocal())) await ensureWatchTab().catch((e) => console.warn('[watch] ensure failed', e));
  })().finally(() => (booting = null));
  return booting;
}

async function onAlarm(alarm: Browser.alarms.Alarm) {
  if (alarm.name === RELAY_ALARM) {
    await relayHeartbeat();
    return;
  }
  if (alarm.name === RELOAD_ALARM) {
    // Schedule the next one first, so a failed reload does not stop the cycle.
    await scheduleReload();
    if (!isConfigured(await getLocal())) return;
    try {
      await afterReload(await reloadAndRead());
    } catch (e) {
      console.warn('[watch] reload failed', e);
    }
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function onStorageChanged(changes: Record<string, Browser.storage.StorageChange>, area: string) {
  if (area !== 'local') return;
  // The relay learns botKey, accountId and label at auth: reconnect when they change.
  if (changes.botKey || changes.relayUrl || changes.label || changes.accountId) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connectRelay(true).catch(() => undefined), 800);
  }
  if (changes.chatId && changes.chatId.newValue && !changes.chatId.oldValue) void onLinked();
  if (changes.settings) {
    const before = changes.settings.oldValue as { reloadMinMinutes?: number; reloadMaxMinutes?: number } | undefined;
    const after = changes.settings.newValue as { reloadMinMinutes?: number; reloadMaxMinutes?: number } | undefined;
    if (before?.reloadMinMinutes !== after?.reloadMinMinutes || before?.reloadMaxMinutes !== after?.reloadMaxMinutes) {
      void scheduleReload();
    }
  }
}

async function handleMessage(msg: ContentToBackground | UiToBackground, sender: Browser.runtime.MessageSender): Promise<Record<string, unknown> | void> {
  if (sender.id !== browser.runtime.id) return;
  // Messages from Fiverr tabs (content script). Decide by URL, not by
  // sender.tab: the options page opens in a tab too.
  if (sender.url?.startsWith(`${FIVERR_ORIGIN}/`)) {
    switch (msg.type) {
      case 'toast':
        return handleToast(msg.toast);
      case 'username':
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(msg.username)) await setLocal({ detectedUsername: msg.username });
        return;
      case 'capture':
        return updateLocal('captures', (c) => ({ ...c, [msg.kind]: { at: Date.now(), url: msg.url, html: msg.html.slice(0, 500_000) } }));
    }
    return;
  }

  // Messages from the popup and the options page.
  if (!sender.url?.startsWith(browser.runtime.getURL('/'))) return;
  switch (msg.type) {
    case 'relay:connect':
      return connectRelay(true);
    case 'relay:retry':
      return retryRelayNow();
    case 'setup:webhook':
      return connectAndRegisterWebhook();
    case 'setup:waitForStart':
      return waitForStart();
    case 'alert:test':
      return sendTestAlert();
    case 'check:now': {
      const snapshot = await reloadAndRead();
      if (snapshot.unread.ok) await setLocal({ lastUnread: snapshot.unread.value });
      return { snapshot };
    }
    case 'watch:ensure': {
      const tabId = await ensureWatchTab();
      return { tabId };
    }
    case 'watch:reschedule':
      return scheduleReload();
    case 'profile:disconnect':
      return disconnectProfile();
  }
}
