// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Item 1 and 2: the thread detector, on the real conversation markup
 * (tests/fixtures/conversation.html, made-up names and texts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CLOCK_SKEW_MS, SETTLE_MS, watchThread } from '../src/content/threadWatcher';
import type { ThreadMessage } from '../src/lib/messages';

const FIXTURES: Record<string, string> = import.meta.glob('./fixtures/*.html', { query: '?raw', import: 'default', eager: true });
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`]!;
const flush = () => new Promise((r) => setTimeout(r, 0));
const at = (iso: string) => Date.parse(iso);

/** A version-1 UUID for a time, as in Fiverr's message ids. */
function v1(ms: number): string {
  const ticks = (BigInt(ms) + 12_219_292_800_000n) * 10_000n;
  const hex = (n: bigint, len: number) => n.toString(16).padStart(len, '0');
  return `${hex(ticks & 0xffffffffn, 8)}-${hex((ticks >> 32n) & 0xffffn, 4)}-1${hex((ticks >> 48n) & 0xfffn, 3)}-8000-000000000000`;
}

const messages = () => Array.from(document.querySelectorAll<HTMLElement>('div.message[id]'));
const conv = () => messages()[0]!.id.split('_')[0]!;

/** Adds a copy of message `from` (index in the fixture) with a new id, time and text. */
function addMessage(from: number, sentAt: number, edit: (html: string) => string = (h) => h, where: 'end' | 'start' = 'end'): string {
  const src = messages()[from]!;
  const el = src.cloneNode(true) as HTMLElement;
  el.id = `${conv()}_${v1(sentAt)}`;
  el.innerHTML = edit(el.innerHTML);
  if (where === 'end') messages().at(-1)!.after(el);
  else messages()[0]!.before(el);
  return el.id;
}
const BUYER_LAST = 29; // "please review the draft tomorrow", from buyer_one
const MINE = 0; // from my_seller ("Me")
const FILE_ONLY = 15; // website.zip, no text

function start(opts: { away?: () => boolean; path?: string; me?: string } = {}) {
  document.body.innerHTML = fixture('conversation.html');
  let clock = at('2026-11-16T02:58:00Z'); // opened 7 min after the newest message (02:51)
  let path = opts.path ?? '/inbox/buyer_one';
  const out: ThreadMessage[] = [];
  const stop = watchThread((m) => out.push(m), {
    now: () => clock,
    path: () => path,
    mayAlert: opts.away ?? (() => true),
    myUsername: () => opts.me ?? 'my_seller',
  });
  return {
    out,
    stop,
    tick: (ms: number) => (clock += ms),
    go: (p: string) => (path = p),
  };
}

afterEach(() => (document.body.innerHTML = ''));

describe('thread detector', () => {
  it('the messages on the page when the conversation opens never alert', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    document.body.append(document.createElement('div')); // any mutation
    await flush();
    expect(t.out).toEqual([]);
    t.stop();
  });

  it('a new message from the buyer alerts with its id, name and text', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    const id = addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'), (h) => h.replace('please review the draft tomorrow', 'are you there?'));
    await flush();
    expect(t.out).toEqual([{ username: 'buyer_one', displayName: 'Buyer One', id, sentAt: at('2026-11-16T03:00:00Z'), text: 'are you there?', files: [] }]);
    t.stop();
  });

  it('files come as names, never content; a file-only message has no text', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    addMessage(FILE_ONLY, at('2026-11-16T03:01:00Z'));
    await flush();
    expect(t.out).toHaveLength(1);
    expect(t.out[0]).toMatchObject({ text: '', files: ['website.zip'] });
    t.stop();
  });

  it('my own new message does not alert ("Me" and my username)', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    addMessage(MINE, at('2026-11-16T03:00:00Z'));
    await flush();
    expect(t.out).toEqual([]);
    t.stop();
  });

  it('older history loaded by scrolling up does not alert', async () => {
    const t = start();
    t.tick(60_000);
    addMessage(BUYER_LAST, at('2026-10-01T10:00:00Z'), (h) => h, 'start');
    // Even a buyer message just before the newest one on the page is history.
    addMessage(BUYER_LAST, at('2026-11-16T02:50:00Z'), (h) => h, 'start');
    await flush();
    expect(t.out).toEqual([]);
    t.stop();
  });

  it('a message older than the moment the conversation was opened (beyond clock skew) does not alert', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    // Newer than the page's newest message, but well before opening.
    // 02:52:30: after the newest message on the page (02:51), but more than
    // CLOCK_SKEW_MS before the conversation was opened (02:58).
    expect(at('2026-11-16T02:58:00Z') - at('2026-11-16T02:52:30Z')).toBeGreaterThan(CLOCK_SKEW_MS);
    addMessage(BUYER_LAST, at('2026-11-16T02:52:30Z'));
    await flush();
    expect(t.out).toEqual([]);
    t.stop();
  });

  it('item 2: no alert while I am reading the conversation (visible and focused), and none later for it', async () => {
    let away = false;
    const t = start({ away: () => away });
    t.tick(SETTLE_MS + 100);
    addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'), (h) => h.replace('please review the draft tomorrow', 'seen while reading'));
    await flush();
    expect(t.out).toEqual([]);
    away = true; // I switch away: that message was seen, it does not alert now
    document.body.append(document.createElement('div'));
    await flush();
    expect(t.out).toEqual([]);
    addMessage(BUYER_LAST, at('2026-11-16T03:02:00Z'), (h) => h.replace('please review the draft tomorrow', 'sent while away'));
    await flush();
    expect(t.out.map((m) => m.text)).toEqual(['sent while away']);
    t.stop();
  });

  it('a re-render of the same messages does not alert again', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'));
    await flush();
    const html = document.body.innerHTML;
    document.body.innerHTML = html; // React re-mounts the thread
    await flush();
    expect(t.out).toHaveLength(1);
    t.stop();
  });

  it('a grouped message without its own avatar takes the sender from the one before', async () => {
    const t = start();
    t.tick(SETTLE_MS + 100);
    addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'), (h) => h.replace('please review the draft tomorrow', 'first'));
    const id = addMessage(BUYER_LAST, at('2026-11-16T03:00:05Z'), (h) => h.replace('please review the draft tomorrow', 'second'));
    document.getElementById(id)!.querySelector('[data-track-tag="avatar"]')!.remove();
    await flush();
    expect(t.out.map((m) => [m.username, m.text])).toEqual([
      ['buyer_one', 'first'],
      ['buyer_one', 'second'],
    ]);
    t.stop();
  });

  it('messages rendered while the conversation is still opening are the baseline', async () => {
    const t = start();
    t.tick(SETTLE_MS - 500);
    addMessage(BUYER_LAST, at('2026-11-16T02:57:00Z'));
    await flush();
    expect(t.out).toEqual([]);
    t.stop();
  });

  it('only on /inbox/{username}, and a message must be from that buyer', async () => {
    const t = start({ path: '/inbox' });
    t.tick(SETTLE_MS + 100);
    addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'));
    await flush();
    expect(t.out).toEqual([]);
    t.stop();

    const u = start({ path: '/inbox/someone_else' });
    u.tick(SETTLE_MS + 100);
    addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'));
    await flush();
    expect(u.out).toEqual([]);
    u.stop();
  });

  it('opening another conversation without a page load starts a new baseline', async () => {
    const t = start({ path: '/inbox/other_buyer' });
    t.tick(SETTLE_MS + 100);
    t.go('/inbox/buyer_one'); // the thread now shows buyer_one; its messages are the baseline
    document.body.append(document.createElement('div'));
    await flush();
    t.tick(SETTLE_MS + 100);
    addMessage(BUYER_LAST, at('2026-11-16T03:00:00Z'), (h) => h.replace('please review the draft tomorrow', 'after switching'));
    await flush();
    expect(t.out.map((m) => m.text)).toEqual(['after switching']);
    t.stop();
  });
});
