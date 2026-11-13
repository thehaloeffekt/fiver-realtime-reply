/**
 * The watch tab: one pinned tab on https://www.fiverr.com/inbox that this
 * extension owns. It keeps a Fiverr page open (so toasts arrive), is the only
 * tab the extension ever reloads or navigates, and is where commands read the
 * inbox. All work on it goes through one queue so a reload never runs in the
 * middle of a "Full message" read.
 */
import { browser, type Browser } from 'wxt/browser';
import { FIVERR_ORIGIN, INBOX_URL, inboxUrlFor } from '../lib/constants';
import type { BackgroundToContent, ConversationMessage, InboxSnapshot, ReadResult } from '../lib/messages';
import { getLocal, getSession, isConfigured, removeSession, setSession } from '../lib/storage';

export const RELOAD_ALARM = 'watch-reload';
const LOAD_TIMEOUT_MS = 60_000;
const CONTENT_TIMEOUT_MS = 25_000;

let queue: Promise<unknown> = Promise.resolve();
let ensuring: Promise<number | null> | null = null;
/** Times we re-created the tab after the user closed it; stops a fight with the user. */
let recreations: number[] = [];

/** Runs `fn` with the watch tab id, one job at a time. */
export function withWatchTab<T>(fn: (tabId: number) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const tabId = await ensureWatchTab();
    if (tabId == null) throw new Error('No browser window is open for the watch tab.');
    return fn(tabId);
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Returns the watch tab id, creating the tab if needed. Concurrent calls share one result. */
export function ensureWatchTab(): Promise<number | null> {
  ensuring ??= doEnsure().finally(() => (ensuring = null));
  return ensuring;
}

async function doEnsure(): Promise<number | null> {
  const { watchTabId } = await getSession();
  if (watchTabId != null) {
    const tab = await browser.tabs.get(watchTabId).catch(() => null);
    if (tab) return watchTabId;
  }

  // After a browser restart, Chrome may have restored our pinned tab from the
  // last session. Tab ids do not survive a restart, so adopt a pinned inbox
  // tab instead of adding another one each time.
  const restored = (await browser.tabs.query({ pinned: true, url: `${FIVERR_ORIGIN}/inbox*` }))[0];
  let tab: Browser.tabs.Tab | undefined = restored;
  if (!tab) {
    const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
    const target = windows.find((w) => w.focused) ?? windows[0];
    if (!target?.id) return null;
    tab = await browser.tabs.create({ windowId: target.id, url: INBOX_URL, pinned: true, active: false });
  }
  if (tab.id == null) return null;
  // Chrome must not discard it to save memory, or toasts stop arriving.
  await browser.tabs.update(tab.id, { autoDiscardable: false }).catch(() => undefined);
  await setSession({ watchTabId: tab.id });
  const alarm = await browser.alarms.get(RELOAD_ALARM);
  if (!alarm) await scheduleReload();
  return tab.id;
}

/** Called from tabs.onRemoved. Re-creates the watch tab if the setting is on. */
export async function onTabRemoved(tabId: number, info: { isWindowClosing: boolean }) {
  const { watchTabId } = await getSession();
  if (tabId !== watchTabId) return;
  await removeSession(['watchTabId']);
  const s = await getLocal();
  if (!s.settings.keepWatchTab || !isConfigured(s)) return;

  const now = Date.now();
  recreations = recreations.filter((t) => now - t < 60_000);
  if (recreations.length >= 3) return; // the user really wants it gone for now
  recreations.push(now);

  // When a whole window closes, wait: the browser may be quitting. If other
  // windows stay open, ensureWatchTab puts the tab in one of them.
  setTimeout(() => void ensureWatchTab().catch(() => undefined), info.isWindowClosing ? 3000 : 1000);
}

/** Next reload at a random time between the configured minimum and maximum (default 25–35 min). */
export async function scheduleReload(): Promise<void> {
  const { settings } = await getLocal();
  const min = Math.max(5, settings.reloadMinMinutes);
  const max = Math.max(min, settings.reloadMaxMinutes);
  const when = Date.now() + (min + Math.random() * (max - min)) * 60_000;
  await browser.alarms.create(RELOAD_ALARM, { when });
  await setSession({ nextReloadAt: when });
}

/** Resolves when the tab finished loading after a navigation we started. */
function waitForLoad(tabId: number): { promise: Promise<void>; cancel: () => void } {
  let listener: ((id: number, info: Browser.tabs.OnUpdatedInfo) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (listener) browser.tabs.onUpdated.removeListener(listener);
    clearTimeout(timer);
  };
  const promise = new Promise<void>((resolve, reject) => {
    let started = false;
    listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) {
        cancel();
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => {
      cancel();
      reject(new Error('Fiverr did not finish loading in 60 seconds.'));
    }, LOAD_TIMEOUT_MS);
  });
  return { promise, cancel };
}

/** Navigates the watch tab (never any other tab) and waits for the page to load. */
async function navigate(tabId: number, url: string, reload: boolean): Promise<void> {
  const load = waitForLoad(tabId);
  try {
    if (reload) await browser.tabs.reload(tabId);
    else await browser.tabs.update(tabId, { url });
  } catch (e) {
    load.cancel();
    throw e;
  }
  await load.promise;
}

/** Reloads /inbox, or goes back to it if the tab is somewhere else. */
export async function reloadInbox(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  const onInbox = tab.url ? new URL(tab.url).pathname === '/inbox' : false;
  await navigate(tabId, INBOX_URL, onInbox);
}

/** Sends a message to the watch tab's content script, retrying until it is ready. */
async function askTab<T>(tabId: number, msg: BackgroundToContent): Promise<T> {
  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await browser.tabs.sendMessage(tabId, msg);
      if (res !== undefined) return res as T;
    } catch (e) {
      lastErr = e; // content script not injected yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The Fiverr page did not answer (${String(lastErr ?? 'timeout')}).`);
}

export const readInbox = (tabId: number) => askTab<InboxSnapshot>(tabId, { type: 'readInbox' });

/** Reload + read: used by the reload alarm, "Check now" and /check. */
export async function reloadAndRead(): Promise<InboxSnapshot> {
  return withWatchTab(async (tabId) => {
    await reloadInbox(tabId);
    return readInbox(tabId);
  });
}

/**
 * "Full message": open the conversation in the watch tab, read the buyer's
 * last messages, then go back to /inbox. Opening it marks it read on Fiverr.
 */
export async function readConversation(username: string, limit = 10): Promise<ReadResult<ConversationMessage[]>> {
  return withWatchTab(async (tabId) => {
    await navigate(tabId, inboxUrlFor(username), false);
    try {
      return await askTab<ReadResult<ConversationMessage[]>>(tabId, { type: 'readConversation', limit });
    } finally {
      await navigate(tabId, INBOX_URL, false).catch(() => undefined);
    }
  });
}

export async function closeWatchTab(): Promise<void> {
  const { watchTabId } = await getSession();
  await removeSession(['watchTabId', 'nextReloadAt']);
  await browser.alarms.clear(RELOAD_ALARM);
  if (watchTabId != null) await browser.tabs.remove(watchTabId).catch(() => undefined);
}
