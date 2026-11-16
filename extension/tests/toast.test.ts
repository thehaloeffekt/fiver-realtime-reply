// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isInboxToast, parseToast, usernameFromHref } from '../src/lib/toast';

/** The real sample from Fiverr (image markup shortened). */
const SAMPLE = `<ul class="realtime-notifications effeba9"><li data-testid="inbox_100000001_200000002" class="drawer-item _4acffc toast"><a href="/conversations/buyer_one" class="main-action" id="inbox_100000001_200000002"><div class="image-wrapper"><img src="x.png" alt="" /></div><div class="item-content-wrapper"><p class="content"><div class="content-container"><strong class="display-name">Buyer One</strong><span class="username">@buyer_one</span></div>Later today</p></div><div class="item-gutter"><div class="preview-image-wrapper"></div></div></a><button data-testid="dismiss" class="dismiss">x</button></li></ul>`;

/**
 * The live page builds this markup through the DOM, so <p> really contains the
 * <div>. innerHTML would let the HTML parser close the <p> early, so parse as
 * XHTML, which keeps the nesting exactly as written.
 */
function liveDom(markup: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<div xmlns="http://www.w3.org/1999/xhtml">${markup}</div>`, 'application/xhtml+xml');
  const root = document.importNode(doc.documentElement, true) as HTMLElement;
  document.body.replaceChildren(root);
  return root;
}

const li = (root: Element) => root.querySelector('li')!;

describe('parseToast', () => {
  it('parses the real sample', () => {
    const root = liveDom(SAMPLE);
    expect(li(root).querySelector('p.content > div.content-container')).not.toBeNull(); // nesting kept
    expect(parseToast(li(root))).toEqual({
      conversationId: 'inbox_100000001_200000002',
      username: 'buyer_one',
      displayName: 'Buyer One',
      body: 'Later today',
    });
  });

  it('reads the body when the HTML parser moved the text out of p.content', () => {
    document.body.innerHTML = SAMPLE; // <p> closes at <div>
    const el = document.querySelector('li')!;
    expect(el.querySelector('p.content > div.content-container')).toBeNull();
    expect(parseToast(el)?.body).toBe('Later today');
  });

  it('uses only direct text nodes of p.content and trims them', () => {
    const root = liveDom(SAMPLE.replace('Later today', '\n   Hello <b>bold</b> there  \n'));
    expect(parseToast(li(root))?.body).toBe('Hello  there');
  });

  it('falls back to span.username when the href has no /conversations/ segment', () => {
    const root = liveDom(SAMPLE.replace('href="/conversations/buyer_one"', 'href="/inbox"'));
    expect(parseToast(li(root))?.username).toBe('buyer_one');
  });

  it('prefers the href over span.username', () => {
    const root = liveDom(SAMPLE.replace('/conversations/buyer_one', '/conversations/real_user?source=toast'));
    expect(parseToast(li(root))?.username).toBe('real_user');
  });

  it('uses the username as display name when strong.display-name is missing', () => {
    const root = liveDom(SAMPLE.replace('<strong class="display-name">Buyer One</strong>', ''));
    expect(parseToast(li(root))?.displayName).toBe('buyer_one');
  });

  it('returns an empty body for an empty message', () => {
    const root = liveDom(SAMPLE.replace('Later today', '   '));
    expect(parseToast(li(root))?.body).toBe('');
  });

  it('ignores toasts whose data-testid does not start with inbox_', () => {
    const root = liveDom(SAMPLE.replace('data-testid="inbox_100000001_200000002"', 'data-testid="order_123"'));
    expect(isInboxToast(li(root))).toBe(false);
    expect(parseToast(li(root))).toBeNull();
  });

  it('ignores li elements without the toast class', () => {
    const root = liveDom(SAMPLE.replace('class="drawer-item _4acffc toast"', 'class="drawer-item"'));
    expect(parseToast(li(root))).toBeNull();
  });

  it('does not depend on the hashed classes', () => {
    const root = liveDom(SAMPLE.replace('effeba9', 'zz9').replace('_4acffc', '_q1w2e3'));
    expect(parseToast(li(root))?.username).toBe('buyer_one');
  });

  it('returns null when no username can be found', () => {
    const root = liveDom(SAMPLE.replace('href="/conversations/buyer_one"', 'href="/inbox"').replace('<span class="username">@buyer_one</span>', ''));
    expect(parseToast(li(root))).toBeNull();
  });
});

describe('usernameFromHref', () => {
  it.each([
    ['/conversations/buyer_one', 'buyer_one'],
    ['https://www.fiverr.com/conversations/buyer_one', 'buyer_one'],
    ['/conversations/buyer_one/', 'buyer_one'],
    ['/conversations/buyer_one#x', 'buyer_one'],
    ['/conversations/na%20me', 'na me'],
    ['/inbox/buyer_one', ''],
    [null, ''],
  ])('%s → %s', (href, expected) => {
    expect(usernameFromHref(href)).toBe(expected);
  });
});
