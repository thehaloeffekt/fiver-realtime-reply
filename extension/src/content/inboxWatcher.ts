/**
 * Second detector, for hidden tabs: watches the /inbox conversation list.
 *
 * Fiverr does not render toasts in a hidden tab, but the real hidden-tab log
 * shows that it keeps the conversation list live: within seconds of each
 * message the buyer's row gets the new preview and a higher unread count.
 *
 * A new incoming message is a row whose state changes so that:
 *   - it is not mine (no "Me:") and not "Typing...", and
 *   - it is unread (count > 0), and
 *   - its unread count went up, or its preview text changed.
 * The count catches the same text sent twice ("ok?", "ok?"); the preview
 * catches a new message when the count does not move (e.g. a capped badge).
 *
 * Rows that are already there when the list first appears are the baseline
 * and never alert. (The gap while the watch tab reloads is covered by the
 * background, which compares the fresh list with the saved state; see
 * src/lib/listState.ts.) State is kept per username, not per element, so if
 * React re-mounts the rows nothing looks new, and two buyers with the same
 * display name stay apart. A batch that adds more than
 * one row (the list re-rendered or more rows loaded) only refreshes the
 * baseline. A single new row with an unread count is a new conversation.
 *
 * A row whose preview changes to a buyer message while it stays at 0 unread
 * was read at once (its conversation is open in a tab, so Fiverr marks each
 * new message read). It alerts as `read`, only while this tab is hidden or
 * unfocused; the background then checks that nobody is looking at that
 * conversation.
 *
 * Everything runs inside the MutationObserver callback, with no timers:
 * hidden tabs delay timers by up to a minute, but observer callbacks run at
 * once. Read-only, like the rest of the content script.
 */
import { parseRow, rowKey, type InboxRow, type ListMessage } from '../lib/inboxRow';
import { isNewMessage, isReadAtOnce, toListMessage, toRowState, type RowState } from '../lib/listState';
import { INBOX } from '../lib/selectors';

/** New rows in the first seconds after the list appears are part of the page load. */
const SETTLE_AFTER_ATTACH_MS = 5000;

export interface InboxListHooks {
  /** The per-conversation state changed (sent to the background to be saved). */
  onState?: (rows: Record<string, RowState>) => void;
  /** The list appeared (true) or disappeared (false). */
  onPresence?: (present: boolean) => void;
  /**
   * May a row that was read at once (new buyer preview, 0 unread) alert?
   * Default: only while this tab is hidden or its window has no focus. A
   * visible, focused tab means the user is on Fiverr and sees it.
   */
  mayAlertRead?: () => boolean;
}

/** Hidden tab, or a window without focus. Reads the page's state; changes nothing. */
export const userAway = () => document.visibilityState === 'hidden' || !document.hasFocus();

export function watchInboxList(onMessage: (m: ListMessage) => void, hooks: InboxListHooks = {}): () => void {
  let list: Element | null = null;
  let attachedAt = 0;
  let listObserver: MutationObserver | null = null;
  let present: boolean | null = null;
  const state = new Map<string, RowState>();
  let sentSignature = '';

  const rowsOf = (el: Element) => Array.from(el.children).filter((c) => c.matches(INBOX.row));

  const report = () => {
    if (!hooks.onState) return;
    const rows = Object.fromEntries(state);
    const sig = JSON.stringify(rows);
    if (sig === sentSignature) return; // e.g. only the "3 minutes" text ticked
    sentSignature = sig;
    hooks.onState(rows);
  };
  const setPresent = (p: boolean) => {
    if (p === present) return;
    present = p;
    hooks.onPresence?.(p);
  };

  /** Records the current rows without alerting. */
  const baseline = (el: Element) => {
    for (const row of rowsOf(el)) {
      const r = parseRow(row);
      if (r && !r.typing) state.set(rowKey(r), toRowState(r));
    }
    report();
  };

  const check = (r: InboxRow, isNewTopRow: boolean) => {
    const key = rowKey(r);
    const prev = state.get(key);
    if (r.typing) return; // keep the last real preview; "Typing..." is not a message
    state.set(key, toRowState(r));
    if (!prev) {
      // A conversation that was not in the list: alert only for a single new
      // row at the top, which is where Fiverr puts a new conversation.
      if (isNewTopRow && !r.mine && r.unread > 0) onMessage(toListMessage(r, r.unread));
      return;
    }
    if (isNewMessage(prev, r)) onMessage(toListMessage(r, r.unread - prev.unread));
    // The conversation is open somewhere, so Fiverr marked the message read
    // at once and the count stays 0. Only the preview tells.
    else if (isReadAtOnce(prev, r) && (hooks.mayAlertRead ?? userAway)()) onMessage({ ...toListMessage(r, 1), read: true });
  };
  const onMutations = (ms: MutationRecord[]) => {
    const l = list;
    if (!l) return;
    // Rows added directly to the list in this batch. A moved row shows up as
    // removed + added (same element), so it is not new.
    const removed = new Set<Node>();
    const added: Element[] = [];
    for (const m of ms) {
      if (m.type !== 'childList' || m.target !== l) continue;
      for (const n of Array.from(m.removedNodes)) removed.add(n);
      for (const n of Array.from(m.addedNodes)) if (n instanceof Element && n.matches(INBOX.row)) added.push(n);
    }
    const fresh = added.filter((n) => !removed.has(n) && n.isConnected);
    // Several new rows at once, or rows still arriving right after the list
    // appeared: the list is (re)rendering, not receiving a message.
    if (fresh.length > 1 || (fresh.length === 1 && Date.now() - attachedAt < SETTLE_AFTER_ATTACH_MS)) {
      baseline(l);
      return;
    }
    const rows = rowsOf(l);
    for (const row of rows) {
      const r = parseRow(row);
      if (r) check(r, fresh[0] === row && rows[0] === row);
    }
    report();
  };

  const attach = (el: Element) => {
    listObserver?.disconnect();
    list = el;
    attachedAt = Date.now();
    baseline(el);
    listObserver = new MutationObserver(onMutations);
    listObserver.observe(el, { childList: true, subtree: true, characterData: true });
    setPresent(true);
  };

  const find = () => {
    if (list?.isConnected) return;
    const row = document.querySelector(INBOX.row);
    if (row?.parentElement) attach(row.parentElement);
    else {
      if (list) {
        listObserver?.disconnect();
        list = null;
      }
      setPresent(false);
    }
  };

  // Cheap while the list is live: one isConnected check per batch.
  const bodyObserver = new MutationObserver(find);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  find();

  return () => {
    bodyObserver.disconnect();
    listObserver?.disconnect();
  };
}
