// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchInboxList } from '../src/content/inboxWatcher';
import { parseRowPieces, type ListMessage } from '../src/lib/inboxRow';

/** Row text sequences exactly as in the real hidden-tab log (2026-11-15). */
const split = (s: string) => s.split(' · ');

describe('parseRowPieces (real rows from the log)', () => {
  it.each([
    ['M · Buyer One · Just now · Good, any news · 1', { name: 'Buyer One', unread: 1, mine: false, typing: false, preview: "Good, any news" }],
    ['M · Buyer One · 3 minutes · Typing... · 2', { name: 'Buyer One', unread: 2, typing: true }],
    ['M · Buyer One · 19 hours · Typing...', { name: 'Buyer One', unread: 0, typing: true }],
    ['M · Buyer One · Just now · Did you receive it?', { name: 'Buyer One', unread: 0, preview: 'Did you receive it?' }],
    ["M · Buyer One · 1 minute · Me: · Sample text fourteen", { name: 'Buyer One', unread: 0, mine: true, preview: "Sample text fourteen" }],
    ["R · Robert · 4 weeks · Me: · Alright whenever you're ready", { name: 'Robert', mine: true, preview: "Alright whenever you're ready" }],
    ['A · Anastasia · 5 months · 3', { name: 'Anastasia', unread: 3, preview: '' }],
    ['mikelavery · 6 days · Me: Hi Mike', { name: 'mikelavery', mine: true, preview: 'Hi Mike' }],
  ])('%s', (text, expected) => {
    expect(parseRowPieces(split(text))).toMatchObject(expected);
  });

  it('needs a time piece with a name before it', () => {
    expect(parseRowPieces(['Buyer One', 'Hello'])).toBeNull();
    expect(parseRowPieces(['Just now', 'Hello'])).toBeNull();
  });
});

// --- the watcher -----------------------------------------------------------

/** Made-up markup: hashed classes like the real row, text pieces like the log. */
function rowHtml(text: string): string {
  return split(text).map((p) => `<span class="x${p.length}">${p}</span>`).join('');
}
function makeRow(text: string): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('data-testid', 'contact');
  div.setAttribute('role', 'button');
  div.className = 'g4eepik ax65pu14';
  div.innerHTML = rowHtml(text);
  return div;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

let messages: ListMessage[];
let stop: () => void;
let list: HTMLElement;

function start(rows: string[]) {
  document.body.innerHTML = '<main><div class="list"></div></main>';
  list = document.querySelector('.list')!;
  for (const r of rows) list.append(makeRow(r));
  messages = [];
  stop = watchInboxList((m) => messages.push(m));
  vi.setSystemTime(Date.now() + 10_000); // past the settle time after the list appeared
}
const setRow = async (i: number, text: string) => {
  list.children[i]!.innerHTML = rowHtml(text);
  await flush();
};

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => {
  stop?.();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const OTHERS = ["M · mikelavery · 6 days · Me: · Hi Mike", "R · Robert · 4 weeks · Me: · Alright whenever you're ready", 'A · Anastasia · 5 months · 3'];

describe('watchInboxList', () => {
  it('replays the real hidden-tab log: three buyer messages give three alerts, nothing else does', async () => {
    start(['M · Buyer One · 19 hours · Me: · Sure, sending it now', ...OTHERS]);
    expect(messages).toEqual([]); // rows present at load never alert

    await setRow(0, 'M · Buyer One · 19 hours · Typing...'); // 16:30:42
    await setRow(0, "M · Buyer One · Just now · Good, any news · 1"); // 16:30:49
    await setRow(0, "M · Buyer One · 1 minute · Good, any news · 1"); // time tick
    await setRow(0, "M · Buyer One · Just now · Extra details attached · 2"); // 16:33:52
    await setRow(0, "M · Buyer One · 2 minutes · Extra details attached · 2");
    await setRow(0, 'M · Buyer One · 3 minutes · Typing... · 2'); // 16:36:32
    await setRow(0, 'M · Buyer One · Just now · Did you receive it? · 3'); // 16:36:38
    await setRow(0, 'M · Buyer One · Just now · Did you receive it?'); // 16:37:24 read on the phone
    await setRow(0, "M · Buyer One · Just now · Me: · Sample text fourteen"); // 16:37:37 my reply
    await setRow(0, "M · Buyer One · 1 minute · Me: · Sample text fourteen");

    expect(messages).toEqual([
      { username: '', displayName: 'Buyer One', body: "Good, any news", count: 1 },
      { username: '', displayName: 'Buyer One', body: "Extra details attached", count: 1 },
      { username: '', displayName: 'Buyer One', body: 'Did you receive it?', count: 1 },
    ]);
  });

  it('alerts the same text sent twice (the count goes up)', async () => {
    start(['B · Bob · 2 days · Me: · ok']);
    await setRow(0, 'B · Bob · Just now · ok? · 1');
    await setRow(0, 'B · Bob · Just now · ok? · 2');
    expect(messages.map((m) => m.body)).toEqual(['ok?', 'ok?']);
  });

  it('reports a jump of several messages once, with the count', async () => {
    start(['B · Bob · 2 days · Me: · ok']);
    await setRow(0, 'B · Bob · Just now · third one · 3');
    expect(messages).toEqual([{ username: '', displayName: 'Bob', body: 'third one', count: 3 }]);
  });

  it('alerts a row that moves to the top with a new message', async () => {
    start(OTHERS);
    const robert = list.children[1]!;
    robert.innerHTML = rowHtml('R · Robert · Just now · Ready now · 1');
    list.insertBefore(robert, list.firstChild);
    await flush();
    expect(messages).toEqual([{ username: '', displayName: 'Robert', body: 'Ready now', count: 1 }]);
  });

  it('alerts a single new conversation at the top, not one at the bottom', async () => {
    start(OTHERS);
    list.prepend(makeRow('N · New Buyer · Just now · Hello! · 1'));
    await flush();
    list.append(makeRow('O · Old Buyer · 1 year · Old message · 2'));
    await flush();
    expect(messages).toEqual([{ username: '', displayName: 'New Buyer', body: 'Hello!', count: 1 }]);
  });

  it('does not alert when the whole list re-renders with new elements', async () => {
    start(['M · Buyer One · 1 hour · Hi · 1', ...OTHERS]);
    const texts = Array.from(list.children).map((r) => Array.from(r.children).map((s) => s.textContent).join(' · '));
    list.replaceChildren(...texts.map(makeRow));
    await flush();
    expect(messages).toEqual([]);
  });

  it('treats rows added in the first seconds after the list appeared as page load', async () => {
    document.body.innerHTML = '<div class="list"></div>';
    list = document.querySelector('.list')!;
    list.append(makeRow(OTHERS[0]!));
    messages = [];
    stop = watchInboxList((m) => messages.push(m));
    list.prepend(makeRow('Z · Zed · 2 hours · Unread from before · 1')); // still rendering
    await flush();
    vi.setSystemTime(Date.now() + 10_000);
    await setRow(0, 'Z · Zed · 2 hours · Unread from before · 1'); // unchanged: no alert
    expect(messages).toEqual([]);
  });

  it('finds the list when it appears after the script started, and stops cleanly', async () => {
    document.body.innerHTML = '<main></main>';
    messages = [];
    stop = watchInboxList((m) => messages.push(m));
    document.querySelector('main')!.innerHTML = '<div class="list"></div>';
    list = document.querySelector('.list')!;
    list.append(makeRow('B · Bob · 2 days · Me: · ok'));
    await flush();
    vi.setSystemTime(Date.now() + 10_000);
    await setRow(0, 'B · Bob · Just now · new · 1');
    stop();
    await setRow(0, 'B · Bob · Just now · newer · 2');
    expect(messages.map((m) => m.body)).toEqual(['new']);
  });
});
