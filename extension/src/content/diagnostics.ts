/**
 * Background diagnostics recorder (debug mode only).
 *
 * Records what a Fiverr page does, with timestamps and visibilityState, so we
 * can see which signals still fire while the watch tab is hidden. It only
 * reads: MutationObservers and event listeners in the content script's
 * isolated world. It does not touch visibilityState, does not inject into
 * the page's main world and does not change the DOM.
 *
 * The inbox conversation list and the "Unread" chip have no final selectors
 * yet, so they are found by broad structural matching (see the finders
 * below) and logged as outerHTML snippets to pick real selectors from.
 */
import { DIAG_MAX_CHANGES, normText, snippet, type DiagEntry, type DiagKind } from '../lib/diagnostics';
import { TOAST } from '../lib/selectors';
import { isInboxToast } from '../lib/toast';

const OBSERVE_ALL: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  characterDataOldValue: true,
  attributes: true,
  attributeOldValue: true,
};
/** Don't rescan the whole page for the list or chip more often than this. */
const SCAN_INTERVAL_MS = 1500;
const HEARTBEAT_MS = 5 * 60_000;

const CONVERSATION_PATH = /^\/(?:inbox|conversations)\/[^/?#]+/;

export function isConversationHref(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    return CONVERSATION_PATH.test(new URL(href, 'https://www.fiverr.com').pathname);
  } catch {
    return false;
  }
}

/**
 * Finds the inbox conversation list without a known selector.
 *
 * 1. "links": rows link to /inbox/<user> (or /conversations/<user>). Walk up
 *    from every such link and count, for each ancestor, how many *different*
 *    children contain a link. The list element is the one with the most:
 *    each row is one child. Higher ancestors hold all rows inside a single
 *    child, so their count drops to 1.
 * 2. "structure": if rows are not links, take the element with the most
 *    look-alike children (same tag and class string) that each have an image
 *    (the avatar) and some text.
 */
export function findConversationList(root: Document | Element = document): { list: Element; how: 'links' | 'structure' } | null {
  const rowsByParent = new Map<Element, Set<Element>>();
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    if (!isConversationHref(a.getAttribute('href')) || a.closest(TOAST.container)) continue;
    let child: Element = a;
    for (let depth = 0; depth < 12 && child.parentElement; depth++) {
      const parent: Element = child.parentElement;
      let rows = rowsByParent.get(parent);
      if (!rows) rowsByParent.set(parent, (rows = new Set()));
      rows.add(child);
      child = parent;
    }
  }
  let best: Element | null = null;
  let bestCount = 0;
  for (const [parent, rows] of rowsByParent) {
    if (rows.size > bestCount) {
      best = parent;
      bestCount = rows.size;
    }
  }
  if (best && bestCount >= 2) return { list: best, how: 'links' };

  const scope = root instanceof Document ? root.body : root;
  if (!scope) return null;
  let bestS: Element | null = null;
  let bestScore = 0;
  for (const el of Array.from(scope.querySelectorAll('*'))) {
    if (el.childElementCount < 3 || el.closest(TOAST.container)) continue;
    const groups = new Map<string, number>();
    for (const c of Array.from(el.children)) {
      if (!c.querySelector('img') || normText(c.textContent).length < 3) continue;
      const sig = `${c.tagName}|${c.getAttribute('class') ?? ''}`;
      groups.set(sig, (groups.get(sig) ?? 0) + 1);
    }
    const score = Math.max(0, ...groups.values());
    if (score > bestScore) {
      bestS = el;
      bestScore = score;
    }
  }
  return bestS && bestScore >= 3 ? { list: bestS, how: 'structure' } : null;
}

/** "Unread", "Unread 3", "Unread (3)", "Unread3" (badge in its own span), "Unread messages". */
const CHIP_TEXT = /^unread(?:\s+(?:messages|conversations|chats))?\s*[([]?\s*\d*\s*[)\]]?$/i;

/**
 * Finds the "Unread" filter chip: the largest element whose whole text is
 * "Unread" plus an optional count, outside the conversation list. Starts at
 * the text node and climbs while the parent's text still matches, so a count
 * badge next to the label is included. English UI only for now.
 */
export function findUnreadChip(root: Document | Element = document, exclude?: Element | null): Element | null {
  const scope = root instanceof Document ? root.body : root;
  if (!scope) return null;
  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/unread/i.test(n.nodeValue ?? '')) continue;
    let el = n.parentElement;
    if (!el || exclude?.contains(el) || el.closest('script,style,noscript')) continue;
    if (!CHIP_TEXT.test(normText(el.textContent))) continue;
    while (el.parentElement && el.parentElement !== scope && CHIP_TEXT.test(normText(el.parentElement.textContent))) el = el.parentElement;
    return el;
  }
  return null;
}

/** Key of a list row: its conversation path, or the start of its text. */
export function rowKey(row: Element): string {
  const links = row.matches('a[href]') ? [row] : Array.from(row.querySelectorAll('a[href]'));
  const link = links.find((a) => isConversationHref(a.getAttribute('href')));
  if (link) return new URL(link.getAttribute('href')!, 'https://www.fiverr.com').pathname;
  return `text:${rowText(row, 40)}`;
}

/**
 * Visible text of a row, one piece per text node joined with " · ", e.g.
 * "Alice · @alice · Hi there · 2 min". textContent would run them together
 * ("AliceHi there"), which hides where the name ends and the preview starts.
 */
export function rowText(row: Element, max = 200): string {
  const parts: string[] = [];
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('script,style')) continue;
    const t = normText(n.nodeValue, max);
    if (t) parts.push(t);
  }
  return normText(parts.join(' · '), max);
}

function describeRow(row: Element, withHtml = true) {
  return { key: rowKey(row), text: rowText(row), ...(withHtml ? { html: snippet(row) } : {}) };
}

function topRows(list: Element, n = 5) {
  return Array.from(list.children)
    .slice(0, n)
    .map((r, i) => describeRow(r, i === 0));
}

/** The direct child of `list` that contains `node`, or null (the list itself, or outside it). */
function rowOf(list: Element, node: Node): Element | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el && el.parentElement !== list) el = el.parentElement;
  return el;
}

function tagOf(node: Node): string {
  if (!(node instanceof Element)) return '#text';
  const cls = node.getAttribute('class');
  return `${node.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}`;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Generic summary of one MutationObserver batch (used for the toast container). Null if only style changed. */
function summarize(ms: MutationRecord[]): Record<string, unknown> | null {
  const added: string[] = [];
  const removed: string[] = [];
  const text: Array<{ old: string; now: string }> = [];
  const attrs: Array<{ el: string; name: string; old: string | null; now: string | null }> = [];
  let inboxToasts = 0;
  for (const m of ms) {
    if (m.type === 'childList') {
      for (const n of Array.from(m.addedNodes)) {
        if (n instanceof Element) {
          added.push(snippet(n));
          const lis = n.matches(TOAST.item) ? [n] : Array.from(n.querySelectorAll(TOAST.item));
          inboxToasts += lis.filter(isInboxToast).length;
        } else if (normText(n.textContent)) added.push(snippet(n));
      }
      for (const n of Array.from(m.removedNodes)) if (n instanceof Element || normText(n.textContent)) removed.push(snippet(n));
    } else if (m.type === 'characterData') {
      text.push({ old: normText(m.oldValue, 120), now: normText(m.target.textContent, 120) });
    } else if (m.type === 'attributes' && m.attributeName !== 'style') {
      const el = m.target as Element;
      attrs.push({ el: tagOf(el), name: m.attributeName!, old: m.oldValue?.slice(0, 120) ?? null, now: el.getAttribute(m.attributeName!)?.slice(0, 120) ?? null });
    }
  }
  if (!added.length && !removed.length && !text.length && !attrs.length) return null;
  const out: Record<string, unknown> = { mutations: ms.length };
  if (added.length) Object.assign(out, { addedCount: added.length, added: added.slice(0, DIAG_MAX_CHANGES), inboxToasts });
  if (removed.length) Object.assign(out, { removedCount: removed.length, removed: removed.slice(0, DIAG_MAX_CHANGES) });
  if (text.length) Object.assign(out, { textCount: text.length, text: text.slice(0, DIAG_MAX_CHANGES) });
  if (attrs.length) Object.assign(out, { attrCount: attrs.length, attrs: attrs.slice(0, DIAG_MAX_CHANGES) });
  return out;
}

/** Starts recording. `emit` gets each entry as it happens. Returns a stop function. */
export function startDiagnostics(emit: (entry: DiagEntry) => void): () => void {
  const rec = (kind: DiagKind, data?: Record<string, unknown>) =>
    emit({
      t: Date.now(),
      vis: document.visibilityState,
      focus: document.hasFocus(),
      path: location.pathname,
      kind,
      ...(data ? { data } : {}),
    });
  const onInbox = () => location.pathname === '/inbox' || location.pathname.startsWith('/inbox/');
  const cleanups: Array<() => void> = [];

  // --- page visibility and lifecycle ---------------------------------------
  const listen = (target: EventTarget, type: string, fn: () => void) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  listen(document, 'visibilitychange', () => rec('visibility', { state: document.visibilityState }));
  for (const type of ['freeze', 'resume']) listen(document, type, () => rec('lifecycle', { event: type }));
  for (const type of ['focus', 'blur', 'pageshow', 'pagehide', 'online', 'offline']) listen(window, type, () => rec('lifecycle', { event: type }));

  // --- document.title -------------------------------------------------------
  let lastTitle = document.title;
  const checkTitle = () => {
    if (document.title === lastTitle) return;
    rec('title', { old: lastTitle, now: document.title });
    lastTitle = document.title;
  };
  const headObserver = new MutationObserver(checkTitle);
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  cleanups.push(() => headObserver.disconnect());

  // --- URL (in-app navigation) ----------------------------------------------
  let lastPath = location.pathname + location.search;
  const checkUrl = () => {
    const now = location.pathname + location.search;
    if (now === lastPath) return;
    rec('url', { from: lastPath });
    lastPath = now;
  };

  // --- ul.realtime-notifications ---------------------------------------------
  let toastBox: Element | null = null;
  let toastObserver: MutationObserver | null = null;
  const watchToastBox = () => {
    if (toastBox?.isConnected) return;
    if (toastBox) {
      rec('toast-container', { state: 'lost' });
      toastObserver?.disconnect();
      toastBox = null;
    }
    const el = document.querySelector(TOAST.container);
    if (!el) return;
    toastBox = el;
    rec('toast-container', { state: 'found', items: el.children.length, html: snippet(el) });
    toastObserver = new MutationObserver((ms) => {
      const data = summarize(ms);
      if (data) rec('toast', data);
    });
    toastObserver.observe(el, OBSERVE_ALL);
  };

  // --- inbox conversation list -------------------------------------------------
  let list: Element | null = null;
  let listObserver: MutationObserver | null = null;
  let order: string[] = [];
  const keysOf = (el: Element) => Array.from(el.children).map(rowKey);

  const onListMutations = (ms: MutationRecord[]) => {
    if (!list) return;
    const l = list;
    const added: Element[] = [];
    const removed: Element[] = [];
    const changed = new Map<Element, Set<string>>();
    for (const m of ms) {
      if (m.type === 'attributes' && m.attributeName === 'style') continue;
      if (m.type === 'childList' && m.target === l) {
        for (const n of Array.from(m.addedNodes)) if (n instanceof Element) added.push(n);
        for (const n of Array.from(m.removedNodes)) if (n instanceof Element) removed.push(n);
        continue;
      }
      const row = rowOf(l, m.target);
      if (!row) continue;
      let what = changed.get(row);
      if (!what) changed.set(row, (what = new Set()));
      what.add(m.type === 'attributes' ? `attr:${m.attributeName}` : m.type === 'characterData' ? 'text' : 'children');
    }
    for (const a of added) changed.delete(a);
    // A row moved by insertBefore shows up as removed + added: report it once, as a move.
    const addedSet = new Set(added);
    const moved = removed.filter((r) => addedSet.has(r));
    const children = Array.from(l.children);

    const data: Record<string, unknown> = { mutations: ms.length, rows: children.length };
    const realAdded = added.filter((a) => !moved.includes(a) && a.isConnected);
    const realRemoved = removed.filter((r) => !moved.includes(r) && !r.isConnected);
    if (realAdded.length) Object.assign(data, { addedCount: realAdded.length, added: realAdded.slice(0, DIAG_MAX_CHANGES).map((r) => ({ index: children.indexOf(r), ...describeRow(r) })) });
    if (realRemoved.length) Object.assign(data, { removedCount: realRemoved.length, removed: realRemoved.slice(0, DIAG_MAX_CHANGES).map((r) => describeRow(r)) });
    if (moved.length) Object.assign(data, { moved: moved.slice(0, DIAG_MAX_CHANGES).map((r) => ({ index: children.indexOf(r), ...describeRow(r) })) });
    if (changed.size) {
      Object.assign(data, {
        changedCount: changed.size,
        changed: Array.from(changed)
          .slice(0, DIAG_MAX_CHANGES)
          .map(([row, what]) => ({ index: children.indexOf(row), what: [...what], ...describeRow(row) })),
      });
    }
    if (realAdded.length || realRemoved.length || moved.length || changed.size) rec('list', data);

    const next = keysOf(l);
    const nextSet = new Set(next);
    const prevSet = new Set(order);
    const reordered = !sameList(next.filter((k) => prevSet.has(k)), order.filter((k) => nextSet.has(k)));
    const topChanged = !sameList(next.slice(0, 5), order.slice(0, 5));
    if (reordered || topChanged) {
      rec('list-order', { reordered, topChanged, topWasAt: order.indexOf(next[0] ?? ''), rows: next.length, top: topRows(l) });
    }
    order = next;
  };

  // --- "Unread" filter chip ----------------------------------------------------------
  let chip: Element | null = null;
  let chipObserver: MutationObserver | null = null;
  let chipText = '';
  const onChipMutations = (ms: MutationRecord[]) => {
    if (!chip) return;
    const now = normText(chip.textContent, 80);
    const attrs = ms
      .filter((m) => m.type === 'attributes' && m.attributeName !== 'style')
      .slice(0, DIAG_MAX_CHANGES)
      .map((m) => ({ el: tagOf(m.target), name: m.attributeName, old: m.oldValue?.slice(0, 120) ?? null, now: (m.target as Element).getAttribute(m.attributeName!)?.slice(0, 120) ?? null }));
    if (now === chipText && !attrs.length) return;
    rec('chip', { old: chipText, now, ...(attrs.length ? { attrs } : {}), html: snippet(chip) });
    chipText = now;
  };

  // --- finding (and re-finding) the targets ----------------------------------------
  let lastScan = 0;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scan = () => {
    scanTimer = undefined;
    lastScan = Date.now();
    if (!list) {
      const found = findConversationList(document);
      if (found) {
        list = found.list;
        order = keysOf(list);
        rec('list-found', { how: found.how, rows: list.children.length, html: snippet(list), top: topRows(list) });
        listObserver = new MutationObserver(onListMutations);
        listObserver.observe(list, OBSERVE_ALL);
      }
    }
    if (!chip) {
      const found = findUnreadChip(document, list);
      if (found) {
        chip = found;
        chipText = normText(found.textContent, 80);
        rec('chip-found', { text: chipText, html: snippet(found) });
        chipObserver = new MutationObserver(onChipMutations);
        chipObserver.observe(found, OBSERVE_ALL);
      }
    }
  };
  const ensureTargets = () => {
    if (list && !list.isConnected) {
      rec('list-lost', { rows: order.length });
      listObserver?.disconnect();
      list = null;
      order = [];
    }
    if (chip && !chip.isConnected) {
      rec('chip-lost', { text: chipText });
      chipObserver?.disconnect();
      chip = null;
    }
    if ((list && chip) || !onInbox() || scanTimer) return;
    // A full-page scan is the expensive part: at most once per SCAN_INTERVAL_MS,
    // with a trailing scan so the last change before a quiet period is not missed.
    const wait = SCAN_INTERVAL_MS - (Date.now() - lastScan);
    if (wait <= 0) scan();
    else scanTimer = setTimeout(scan, wait);
  };

  const bodyObserver = new MutationObserver(() => {
    checkUrl();
    watchToastBox();
    ensureTargets();
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => {
    bodyObserver.disconnect();
    toastObserver?.disconnect();
    listObserver?.disconnect();
    chipObserver?.disconnect();
    clearTimeout(scanTimer);
  });

  // --- heartbeat: shows throttling/freezing as a long gap, and the current state -----
  let lastBeat = Date.now();
  const beat = setInterval(() => {
    const now = Date.now();
    rec('heartbeat', {
      gapMs: now - lastBeat,
      title: document.title,
      toastContainer: Boolean(toastBox?.isConnected),
      toastItems: toastBox?.children.length ?? 0,
      listRows: list?.isConnected ? list.children.length : null,
      chip: chip?.isConnected ? chipText : null,
    });
    lastBeat = now;
  }, HEARTBEAT_MS);
  cleanups.push(() => clearInterval(beat));

  rec('start', { title: document.title, toastContainer: Boolean(document.querySelector(TOAST.container)) });
  watchToastBox();
  if (onInbox()) scan();

  return () => {
    for (const c of cleanups) c();
    rec('stop');
  };
}
