import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { handleListMessage, handleThreadMessage, handleToast, sendTestAlert } from '../background/alerts';
import { saveBuyerZone } from '../background/buyerZones';
import { handleAccountRemoved, handleOffline, handleUpdate, labelSavedText, pauseText, registerCommands, setAlertsOn } from '../background/commands';
import { onListState, onStale, reloadAndCompare, restWatchTab, watchdog } from '../background/listSync';
import { notify } from '../background/notify';
import { REPLY_ALARM, onPeer, recoverReplies, replyProbes, sweepReplies } from '../background/replies';
import { connectRelay, relayHeartbeat, retryRelayNow, setRelayHandlers } from '../background/relay';
import { RELAY_ALARM, applyUninstallUrl, connectAndRegisterWebhook, disconnectProfile, ensureRelayAlarm, onLinked, onRemovedRemotely, waitForStart } from '../background/setup';
import { RELOAD_ALARM, ensureWatchTab, onTabRemoved, scheduleReload } from '../background/watchTab';
import { FIVERR_ORIGIN } from '../lib/constants';
import { appendDiag, redactReplies, sanitizeEntries, type DiagEntry } from '../lib/diagnostics';
import { newAccountId, newRemovalCode } from '../lib/keys';
import type { ContentToBackground, UiToBackground } from '../lib/messages';
import { getLocal, getSession, isConfigured, labelOf, setLocal, updateLocal } from '../lib/storage';

export default defineBackground({
  type: 'module',
  main() {
    setRelayHandlers({
      onUpdate: (update, routed) => void handleUpdate(update, routed),
      onOffline: (accountId, label) => void handleOffline(accountId, label),
      onAccountRemoved: (accountId, label) => void handleAccountRemoved(accountId, label),
      onRemoved: () => void onRemovedRemotely(),
      onPeer: (from, body) => onPeer(from, body),
    });

    // Listeners are registered synchronously so Chrome can wake the worker for them.
    browser.runtime.onStartup.addListener(() => void boot());
    browser.runtime.onInstalled.addListener((details) => {
      void boot();
      // A new version may have new commands: refresh Telegram's "/" menu.
      if (details.reason === 'update') void registerCommands();
    });
    browser.alarms.onAlarm.addListener((alarm) => void onAlarm(alarm));
    browser.tabs.onRemoved.addListener((tabId, info) => void onTabRemoved(tabId, info));
    // The watch tab must rest on /inbox: re-check when it navigates or is hidden or shown.
    browser.tabs.onActivated.addListener(() => void restWatchTab());
    browser.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url) void getSession().then((s) => (s.watchTabId === tabId ? restWatchTab() : undefined));
    });
    browser.windows.onFocusChanged.addListener(() => void restWatchTab());
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
    // Profiles set up before removal codes existed get one now; the relay
    // learns its hash at the connect below.
    if (s.botKey && !s.removalCode) await setLocal({ removalCode: newRemovalCode() });
    // Before the relay connects, so no button press is handled first: a
    // reply left in "sending" by a stopped worker becomes "unknown", never
    // "preview" again (see replies.ts).
    await recoverReplies().catch((e) => console.warn('[reply] recovery failed', e));
    // At every start, as Chrome keeps the uninstall URL only per install.
    await applyUninstallUrl();
    // Reconnect check every minute. It also wakes a stopped worker.
    await ensureRelayAlarm();
    await connectRelay().catch(() => undefined);
    if (isConfigured(await getLocal())) await ensureWatchTab().catch((e) => console.warn('[watch] ensure failed', e));
  })().finally(() => (booting = null));
  return booting;
}

async function onAlarm(alarm: Browser.alarms.Alarm) {
  if (alarm.name === RELAY_ALARM) {
    await relayHeartbeat();
    await watchdog().catch((e) => console.warn('[watch] watchdog failed', e));
    return;
  }
  if (alarm.name === REPLY_ALARM) {
    await sweepReplies().catch((e) => console.warn('[reply] sweep failed', e));
    return;
  }
  if (alarm.name === RELOAD_ALARM) {
    // Schedule the next one first, so a failed reload does not stop the cycle.
    await scheduleReload();
    if (!isConfigured(await getLocal())) return;
    try {
      await reloadAndCompare();
    } catch (e) {
      console.warn('[watch] reload failed', e);
    }
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function onStorageChanged(changes: Record<string, Browser.storage.StorageChange>, area: string) {
  if (area !== 'local') return;
  // The relay learns botKey, accountId and label at auth: reconnect when they change.
  if (changes.botKey || changes.relayUrl || changes.label || changes.accountId || changes.detectedUsername) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connectRelay(true).catch(() => undefined), 800);
  }
  if (changes.botKey || changes.relayUrl || changes.accountId || changes.removalCode) void applyUninstallUrl();
  if (changes.chatId && changes.chatId.newValue && !changes.chatId.oldValue) void onLinked();
  // Confirm a new account name in Telegram (the "Linked" reply may have come
  // before the name was set, see linkedText).
  if (changes.label) {
    const label = typeof changes.label.newValue === 'string' ? changes.label.newValue.trim() : '';
    if (label && label !== changes.label.oldValue) {
      void getLocal().then((s) => (s.chatId ? notify(labelSavedText(label)) : undefined)).catch(() => undefined);
    }
  }
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
      case 'listMessage':
        return handleListMessage(msg.message);
      case 'threadMessage':
        return handleThreadMessage(msg.message);
      case 'listState':
        return onListState(msg.rows, msg.page, sender.tab?.id);
      case 'stale':
        return onStale(msg.reason === 'resume' ? 'resume' : 'no-list', sender.tab?.id);
      case 'buyerHeader':
        return saveBuyerZone(msg.header);
      case 'username':
        // Every Fiverr page sends it; write only a change (it restarts the relay connection).
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(msg.username) && (await getLocal()).detectedUsername !== msg.username) {
          await setLocal({ detectedUsername: msg.username });
        }
        return;
      case 'capture':
        return updateLocal('captures', (c) => ({ ...c, [msg.kind]: { at: Date.now(), url: msg.url, html: msg.html.slice(0, 500_000) } }));
      case 'diag':
        return recordDiagnostics(msg.entries, sender.tab?.id);
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
      const snapshot = await reloadAndCompare();
      return { snapshot };
    }
    case 'alerts:set': {
      // The popup or settings switch. One Telegram message per change, so
      // every device with the chat sees that this account was paused.
      const on = msg.on === true;
      if (await setAlertsOn(on)) {
        const s = await getLocal();
        if (isConfigured(s)) await notify(pauseText(labelOf(s), on, 'chrome')).catch(() => undefined);
      }
      return;
    }
    case 'watch:ensure': {
      const tabId = await ensureWatchTab();
      return { tabId };
    }
    case 'watch:reschedule':
      return scheduleReload();
    case 'profile:disconnect':
      return { ...(await disconnectProfile()) };
    case 'diag:clear':
      return writeDiagnostics(() => []);
  }
}

let diagChain: Promise<unknown> = Promise.resolve();

/**
 * All writes to the diagnostics log go through this one queue, so entries
 * from several tabs arriving at once are all kept. It reads only the
 * `diagnostics` key, not the whole storage, because it runs often.
 */
function writeDiagnostics(fn: (log: DiagEntry[]) => DiagEntry[]): Promise<void> {
  const run = diagChain.then(async () => {
    const { diagnostics } = (await browser.storage.local.get('diagnostics')) as { diagnostics?: DiagEntry[] };
    await browser.storage.local.set({ diagnostics: fn(diagnostics ?? []) });
  });
  diagChain = run.catch(() => undefined);
  return run;
}

async function recordDiagnostics(raw: unknown, tabId: number | undefined): Promise<void> {
  const { settings } = (await browser.storage.local.get('settings')) as { settings?: { debug?: boolean } };
  if (!settings?.debug) return;
  // The text of a reply sent from Telegram never goes into the log.
  const entries = redactReplies(sanitizeEntries(raw), replyProbes());
  if (!entries.length) return;
  // Tag each entry with its tab, and whether that tab is the watch tab.
  const { watchTabId } = await getSession();
  for (const e of entries) {
    e.tab = tabId;
    e.watch = tabId != null && tabId === watchTabId;
  }
  await writeDiagnostics((log) => appendDiag(log, entries));
}
