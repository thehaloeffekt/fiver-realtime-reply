import { TOAST } from '../lib/selectors';
import { isInboxToast, parseToast, type Toast } from '../lib/toast';

/** Wait this long after the last change to a toast before reading it, so React finishes rendering. */
const SETTLE_MS = 150;

/**
 * Watches Fiverr's realtime toast list and calls `onToast` for each new inbox
 * toast, and again when Fiverr reuses an <li> and replaces its text.
 *
 * ul.realtime-notifications may not exist at page load. A cheap observer on
 * document.body waits for it; after that, a second observer watches only the
 * container (childList + subtree + characterData). If Fiverr replaces the
 * container during in-app navigation, the body observer finds the new one.
 */
export function watchToasts(onToast: (toast: Toast) => void): () => void {
  let container: Element | null = null;
  let containerObserver: MutationObserver | null = null;
  /** Last text we reported per <li>, so unrelated re-renders do not resend. */
  const lastSignature = new WeakMap<Element, string>();
  const dirty = new Set<Element>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    flushTimer = undefined;
    for (const li of dirty) {
      if (!li.isConnected) continue;
      const toast = parseToast(li);
      if (!toast) continue;
      const signature = `${toast.conversationId}\u0000${toast.body}`;
      if (lastSignature.get(li) === signature) continue;
      lastSignature.set(li, signature);
      onToast(toast);
    }
    dirty.clear();
  };

  const markToast = (node: Node | null) => {
    const el = node instanceof Element ? node : node?.parentElement;
    if (!el) return;
    const li = el.closest(TOAST.item);
    if (li && isInboxToast(li)) dirty.add(li);
    // An added subtree may contain toasts.
    for (const inner of Array.from(el.querySelectorAll(TOAST.item))) if (isInboxToast(inner)) dirty.add(inner);
  };

  const schedule = () => {
    if (!dirty.size) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, SETTLE_MS);
  };

  const attach = (el: Element) => {
    containerObserver?.disconnect();
    container = el;
    containerObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        markToast(m.target);
        for (const n of Array.from(m.addedNodes)) markToast(n);
      }
      schedule();
    });
    containerObserver.observe(el, { childList: true, subtree: true, characterData: true });
    markToast(el); // toasts that were already there
    schedule();
  };

  const findContainer = () => {
    if (container?.isConnected) return;
    const el = document.querySelector(TOAST.container);
    if (el) attach(el);
  };

  // Only does work while we have no live container: one isConnected check per batch.
  const bodyObserver = new MutationObserver(findContainer);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  findContainer();

  return () => {
    bodyObserver.disconnect();
    containerObserver?.disconnect();
    clearTimeout(flushTimer);
  };
}
