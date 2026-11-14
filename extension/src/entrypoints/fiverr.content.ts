import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { startDiagnostics } from '../content/diagnostics';
import { watchToasts } from '../content/observer';
import type { DiagEntry, DiagKind } from '../lib/diagnostics';
import { startPicker } from '../content/picker';
import { readConversation, readInbox, readLoggedInUsername } from '../content/reader';
import type { BackgroundToContent, ContentToBackground } from '../lib/messages';

/**
 * Runs on every Fiverr page. It only reads the page: it never types, clicks
 * or submits anything. (The debug picker swallows the user's own click.)
 */
export default defineContentScript({
  matches: ['https://www.fiverr.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const send = (msg: ContentToBackground) => {
      if (!ctx.isValid) return;
      browser.runtime.sendMessage(msg).catch(() => undefined);
    };

    const stopToasts = watchToasts((toast) => send({ type: 'toast', toast }));
    ctx.onInvalidated(stopToasts); // extension reloaded or updated

    const username = readLoggedInUsername();
    if (username) send({ type: 'username', username });

    // Background diagnostics: runs only while Settings → Debug mode is on,
    // and starts or stops in open tabs when the setting changes.
    let stopDiag: (() => void) | null = null;
    const diagOut = diagnosticsSender((entries) => send({ type: 'diag', entries }));
    const applyDebug = (on: boolean) => {
      if (on && !stopDiag) stopDiag = startDiagnostics(diagOut.push);
      else if (!on && stopDiag) {
        stopDiag();
        stopDiag = null;
        diagOut.flush();
      }
    };
    browser.storage.local.get('settings').then((r) => applyDebug(Boolean((r.settings as { debug?: boolean } | undefined)?.debug)), () => undefined);
    const onSettings = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes.settings) applyDebug(Boolean((changes.settings.newValue as { debug?: boolean } | undefined)?.debug));
    };
    browser.storage.onChanged.addListener(onSettings);
    ctx.onInvalidated(() => {
      browser.storage.onChanged.removeListener(onSettings);
      stopDiag?.();
    });

    browser.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, sendResponse) => {
      switch (msg.type) {
        case 'ping':
          sendResponse('pong');
          return;
        case 'readInbox':
          readInbox().then(sendResponse, (e) => sendResponse({ unread: { ok: false, error: String(e) }, names: { ok: false, error: String(e) } }));
          return true;
        case 'readConversation':
          readConversation(msg.limit).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case 'startCapture':
          startPicker(msg.kind, async (html) => send({ type: 'capture', kind: msg.kind, html, url: location.href }));
          sendResponse(true);
          return;
      }
    });
  },
});

/** Kinds sent at once: the page may be frozen or closed right after them. */
const URGENT: ReadonlySet<DiagKind> = new Set(['start', 'stop', 'visibility', 'lifecycle', 'heartbeat']);

/**
 * Sends diagnostics entries to the background almost at once (each entry
 * keeps the time it happened, so a late send does not change the log), but
 * at most one message per 500 ms, so a burst of re-renders is one message.
 * Timers in hidden tabs can be delayed by up to a minute; that only delays
 * the send, not the timestamp.
 */
function diagnosticsSender(send: (entries: DiagEntry[]) => void) {
  let buffer: DiagEntry[] = [];
  let lastFlush = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!buffer.length) return;
    lastFlush = Date.now();
    send(buffer);
    buffer = [];
  };
  const push = (entry: DiagEntry) => {
    buffer.push(entry);
    if (URGENT.has(entry.kind) || buffer.length >= 25 || Date.now() - lastFlush >= 500) flush();
    else timer ??= setTimeout(flush, 500);
  };
  return { push, flush };
}
