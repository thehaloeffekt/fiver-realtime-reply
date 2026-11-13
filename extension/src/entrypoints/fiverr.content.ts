import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { watchToasts } from '../content/observer';
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
