/**
 * Keeps the watch tab's inbox list state saved, and closes the gaps when the
 * page is replaced (a reload, browser start, a frozen or broken page).
 *
 * The live detector only sees changes while its page runs. A message that
 * arrives while the watch tab reloads (a few seconds), or while Chrome is
 * closed, changes the list before the new page reads it, so the new page
 * takes it as its baseline. To catch those:
 *
 *   1. The watch tab's content script sends its list state (per username:
 *      unread count, preview, mine) whenever it changes, tagged with its page
 *      id (the page's load time). It is saved in chrome.storage.local.
 *   2. Right before each reload we ask the page once more and save that.
 *   3. When a report comes from a *new* page, it does not overwrite the
 *      saved state. Instead we read the fresh list and compare it with the
 *      saved one (if under 24 h old): each row that is unread and changed is
 *      an alert. Then the new page's state is saved.
 *
 * Step 3 is triggered by the new page itself, so it runs for every way the
 * page can be replaced: the reload alarm, "Check now", a manual reload,
 * Chrome restoring the pinned tab at startup, or the stale-page reload.
 * Copies of a message that the live detector also caught are dropped by the
 * same dedupe (account + username + body).
 */
import { browser } from 'wxt/browser';
import { INBOX_URL } from '../lib/constants';
import type { InboxSnapshot, ListStatus, StaleReason } from '../lib/messages';
import { compareWithSaved, sanitizeRows, stateOf, usableSaved, type RowState } from '../lib/listState';
import { escapeHtml } from '../lib/telegram';
import { getLocal, getSession, isConfigured, labelOf, setLocal, setSession, updateLocal } from '../lib/storage';
import { handleListMessage } from './alerts';
import { notify } from './notify';
import { askTabOnce, readInbox, reloadAndRead, setBeforeReload, setOnAdopted, watchTabBusy, withWatchTab } from './watchTab';

/** More gap alerts than this become one summary line. */
const MAX_GAP_ALERTS = 8;

async function isWatchTab(tabId: number | undefined): Promise<boolean> {
  if (tabId == null) return false;
  const { watchTabId } = await getSession();
  return tabId === watchTabId;
}

/** Saves `rows` for `page` unless the saved state belongs to an older page. Returns false then. */
async function save(page: string, rows: Record<string, RowState>): Promise<boolean> {
  let saved = true;
  await updateLocal('listState', (cur) => {
    if (cur && cur.page && cur.page !== page) {
      saved = false;
      return cur; // keep it: the compare for the new page needs it
    }
    return { at: Date.now(), page, rows };
  });
  return saved;
}

/** A list state report from a content script. Only the watch tab's count. */
export async function onListState(raw: unknown, page: unknown, tabId: number | undefined): Promise<void> {
  if (!(await isWatchTab(tabId))) return;
  const rows = sanitizeRows(raw);
  const id = typeof page === 'string' ? page.slice(0, 40) : '';
  if (!rows || !id) return;
  if (!(await save(id, rows))) scheduleCompare(id);
}

let compareQueued = false;

/** Reads the watch tab's fresh list and compares it with the saved state (one at a time). */
function scheduleCompare(page: string) {
  if (compareQueued) return;
  compareQueued = true;
  void withWatchTab(async (tabId) => {
    compareQueued = false;
    // Already done for this page (e.g. by the reload that created it).
    if ((await getLocal()).listState?.page === page) return;
    await applyCompare(await readInbox(tabId));
  }).catch((e) => {
    compareQueued = false;
    console.warn('[list] compare failed', e);
  });
}

/**
 * Compares a fresh snapshot with the saved state and alerts for each row
 * that got a new buyer message in between. Then saves the snapshot's state.
 */
export async function applyCompare(snap: InboxSnapshot): Promise<void> {
  if (snap.unread.ok) await setLocal({ lastUnread: snap.unread.value });
  const fresh = snap.rows.ok ? snap.rows.value : [];
  if (!fresh.length || !snap.page) return; // not the inbox: keep the old state
  const now = Date.now();
  const s = await getLocal();
  const saved = usableSaved(s.listState, now);
  const gap = saved && saved.page !== snap.page ? compareWithSaved(saved.rows, fresh) : [];
  await updateLocal('listState', () => ({ at: now, page: snap.page, rows: stateOf(fresh, saved?.rows) }));

  if (!gap.length || !s.settings.unreadCheck) return;
  for (const m of gap.slice(0, MAX_GAP_ALERTS)) await handleListMessage(m);
  const rest = gap.length - MAX_GAP_ALERTS;
  if (rest > 0 && s.settings.sendAlerts && isConfigured(s)) {
    await notify(`<b>${escapeHtml(labelOf(s))}</b>: ${rest} more ${rest === 1 ? 'conversation has' : 'conversations have'} new messages.`, {
      keyboard: [[{ text: 'Open inbox', url: INBOX_URL }]],
      claim: true,
      retries: 3,
    }).catch(() => undefined);
  }
}

/** Reload the watch tab, then compare. Used by the reload alarm and stale reloads. */
export async function reloadAndCompare(): Promise<InboxSnapshot> {
  const snap = await reloadAndRead();
  await applyCompare(snap);
  return snap;
}

// Step 2: before every reload, save what the page shows right now.
setBeforeReload(async (tabId) => {
  const status = await askTabOnce<ListStatus>(tabId, { type: 'listStatus' }, 3000);
  if (status?.rows && status.page) await save(status.page, sanitizeRows(status.rows) ?? {});
});

// A tab just became the watch tab. Reports it sent before that were ignored,
// so ask for its state now; this is what runs the compare at browser start.
// If its page is still loading, its own reports arrive later and do the same.
setOnAdopted(async (tabId) => {
  const status = await askTabOnce<ListStatus>(tabId, { type: 'listStatus' }, 3000);
  if (status?.page && status.rows && Object.keys(status.rows).length) await onListState(status.rows, status.page, tabId);
});

// ------------------------------------------------------------ stale page

/** The list may be missing this long before the page counts as broken. */
const MISSING_LIST_MS = 60_000;
/** At most one stale reload per this time, so a logged-out page is not reloaded every minute. */
const STALE_RELOAD_GAP_MS = 5 * 60_000;
/** Watchdog ticks in a row without an answer before the page counts as hung. */
const SILENT_TICKS = 2;
let silent = 0;

async function staleReload(why: string): Promise<void> {
  const now = Date.now();
  const { lastStaleReloadAt } = await getSession();
  if (lastStaleReloadAt && now - lastStaleReloadAt < STALE_RELOAD_GAP_MS) return;
  await setSession({ lastStaleReloadAt: now });
  silent = 0;
  console.info('[watch] stale page, reloading:', why);
  await reloadAndCompare().catch((e) => console.warn('[watch] stale reload failed', e));
}

/** A content script reports its page as stale (resumed from frozen, or no list for 60 s). */
export async function onStale(reason: StaleReason, tabId: number | undefined): Promise<void> {
  if (!(await isWatchTab(tabId)) || !isConfigured(await getLocal())) return;
  // A job is moving the tab on purpose (e.g. "Full message" opens a conversation).
  if (reason === 'no-list' && (watchTabBusy() || (await userIsOnTab(tabId!)))) return;
  await staleReload(reason);
}

/** The user is looking at the watch tab: do not reload it under them for a missing list. */
async function userIsOnTab(tabId: number): Promise<boolean> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.active) return false;
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  return Boolean(win?.focused);
}

/**
 * Runs every minute (from the relay alarm). Asks the watch tab whether its
 * list is there. Backup for the content script's own checks, because a
 * frozen or hung page cannot report anything.
 */
export async function watchdog(): Promise<void> {
  const s = await getLocal();
  if (!isConfigured(s) || watchTabBusy()) return;
  const { watchTabId } = await getSession();
  if (watchTabId == null) return;
  const tab = await browser.tabs.get(watchTabId).catch(() => null);
  if (!tab || tab.status === 'loading') return;
  if (tab.discarded) return staleReload('discarded');

  const status = await askTabOnce<ListStatus>(watchTabId, { type: 'listStatus' }, 5000);
  if (watchTabBusy()) return; // a job started meanwhile
  if (!status) {
    // No answer: frozen, hung, or a content script left over from an older
    // version of the extension (it cannot hear the new one).
    if (++silent >= SILENT_TICKS && !(await userIsOnTab(watchTabId))) await staleReload('no answer');
    return;
  }
  silent = 0;
  if (!status.present && status.missingSince != null && Date.now() - status.missingSince > MISSING_LIST_MS && !(await userIsOnTab(watchTabId))) {
    await staleReload('no list');
  }
}
