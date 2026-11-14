// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { findConversationList, findUnreadChip, isConversationHref, rowKey, startDiagnostics } from '../src/content/diagnostics';
import { appendDiag, DIAG_MAX_ENTRIES, DIAG_SNIPPET_CHARS, formatDiagnosticsLog, sanitizeEntries, snippet, type DiagEntry } from '../src/lib/diagnostics';

/** Made-up inbox markup with hashed classes, as Fiverr would have. Not a real sample. */
const row = (user: string, name: string, preview: string) =>
  `<div class="x9a1 row"><a href="/inbox/${user}"><img src="a.png" alt=""><span class="n">${name}</span><p class="p">${preview}</p></a></div>`;
const INBOX = `
  <header><a href="/inbox">Inbox</a></header>
  <div class="filters"><button class="c1"><span>All</span></button><button class="c2"><span>Unread</span><span class="b">2</span></button></div>
  <div class="k3 list">${row('alice', 'Alice', 'Hi there')}${row('bob', 'Bob', 'Me: thanks')}${row('carol', 'Carol', 'Is it done?')}</div>
  <ul class="realtime-notifications"></ul>`;

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('finders', () => {
  it('recognises conversation links', () => {
    expect(isConversationHref('/inbox/alice')).toBe(true);
    expect(isConversationHref('https://www.fiverr.com/conversations/bob?x=1')).toBe(true);
    expect(isConversationHref('/inbox')).toBe(false);
    expect(isConversationHref('/inbox/')).toBe(false);
    expect(isConversationHref('/users/alice')).toBe(false);
  });

  it('finds the list by its conversation links, not a wrapper or the header', () => {
    document.body.innerHTML = INBOX;
    const found = findConversationList(document);
    expect(found?.how).toBe('links');
    expect(found?.list.classList.contains('list')).toBe(true);
    expect(Array.from(found!.list.children).map(rowKey)).toEqual(['/inbox/alice', '/inbox/bob', '/inbox/carol']);
  });

  it('falls back to look-alike rows with an avatar when rows are not links', () => {
    document.body.innerHTML = `<div class="nav"><span>a</span><span>b</span><span>c</span></div>
      <div class="list">${['Alice', 'Bob', 'Carol', 'Dan'].map((n) => `<div class="r"><img src="a.png"><b>${n}</b> hello</div>`).join('')}</div>`;
    const found = findConversationList(document);
    expect(found?.how).toBe('structure');
    expect(found?.list.classList.contains('list')).toBe(true);
    expect(rowKey(found!.list.children[0]!)).toBe('text:Alice · hello');
  });

  it('finds the Unread chip including its count badge, and ignores other "unread" text', () => {
    document.body.innerHTML = `<div class="list"><p>Mark as unread</p><p>Unread</p></div>` + INBOX;
    const list = document.querySelector('.list');
    const chip = findUnreadChip(document, list);
    expect(chip?.classList.contains('c2')).toBe(true);
    expect(chip?.textContent).toBe('Unread2');
  });

  it.each(['Unread', 'Unread (3)', 'Unread 12', 'Unread messages'])('accepts chip text %j', (label) => {
    document.body.innerHTML = `<div><button class="chip">${label}</button><button>All</button></div>`;
    expect(findUnreadChip(document)?.classList.contains('chip')).toBe(true);
  });
});

describe('recorder', () => {
  const record = () => {
    const entries: DiagEntry[] = [];
    window.history.replaceState(null, '', '/inbox');
    document.title = 'Inbox | Fiverr';
    document.body.innerHTML = INBOX;
    const stop = startDiagnostics((e) => entries.push(e));
    return { entries, stop, kinds: () => entries.map((e) => e.kind) };
  };

  it('logs start, the list, the chip and the toast container with the visibility state', () => {
    const { entries, stop, kinds } = record();
    expect(kinds()).toEqual(['start', 'toast-container', 'list-found', 'chip-found']);
    expect(entries.every((e) => e.vis === 'visible' && e.path === '/inbox')).toBe(true);
    expect(entries[3]!.data).toMatchObject({ text: 'Unread2' });
    stop();
  });

  it('logs a row that moves to the top with new preview text as a move plus an order change', async () => {
    const { entries, stop } = record();
    const list = document.querySelector('.list')!;
    const carol = list.children[2]!;
    carol.querySelector('p')!.textContent = 'New message!';
    list.insertBefore(carol, list.firstChild);
    await flush();
    const change = entries.find((e) => e.kind === 'list');
    expect(change?.data).toMatchObject({ moved: [{ index: 0, key: '/inbox/carol', text: 'Carol · New message!' }] });
    const order = entries.find((e) => e.kind === 'list-order');
    expect(order?.data).toMatchObject({ reordered: true, topChanged: true, topWasAt: 2 });
    stop();
  });

  it('logs added rows, text changes, chip changes and title changes', async () => {
    const { entries, stop } = record();
    const list = document.querySelector('.list')!;
    list.insertAdjacentHTML('afterbegin', row('dave', 'Dave', 'Hello'));
    (list.querySelector('a[href="/inbox/alice"] p')!.firstChild as Text).data = 'Hi there, again';
    document.querySelector('.c2 .b')!.textContent = '3';
    document.title = '(3) Inbox | Fiverr';
    await flush();
    const listEntry = entries.find((e) => e.kind === 'list')!;
    expect(listEntry.data).toMatchObject({ added: [{ index: 0, key: '/inbox/dave' }], changed: [{ key: '/inbox/alice', what: ['text'] }] });
    expect(entries.find((e) => e.kind === 'chip')?.data).toMatchObject({ old: 'Unread2', now: 'Unread3' });
    expect(entries.find((e) => e.kind === 'title')?.data).toEqual({ old: 'Inbox | Fiverr', now: '(3) Inbox | Fiverr' });
    stop();
  });

  it('logs toasts added to ul.realtime-notifications', async () => {
    const { entries, stop } = record();
    document.querySelector('ul.realtime-notifications')!.innerHTML =
      '<li class="toast" data-testid="inbox_1_2"><a href="/conversations/eve"><p class="content">Hi</p></a></li>';
    await flush();
    expect(entries.find((e) => e.kind === 'toast')?.data).toMatchObject({ addedCount: 1, inboxToasts: 1 });
    stop();
  });

  it('logs visibilitychange and stops cleanly', async () => {
    const { entries, stop, kinds } = record();
    document.dispatchEvent(new Event('visibilitychange'));
    stop();
    document.title = 'after stop';
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(kinds().filter((k) => k === 'visibility')).toHaveLength(1);
    expect(kinds().at(-1)).toBe('stop');
    expect(entries.some((e) => e.kind === 'title')).toBe(false);
  });
});

describe('log storage and format', () => {
  const entry = (t: number): DiagEntry => ({ t, vis: 'hidden', focus: false, path: '/inbox', kind: 'title', data: { now: String(t) } });

  it('keeps only the newest 300 entries', () => {
    let log: DiagEntry[] = [];
    for (let i = 0; i < 320; i += 10) log = appendDiag(log, Array.from({ length: 10 }, (_, j) => entry(i + j)));
    expect(log).toHaveLength(DIAG_MAX_ENTRIES);
    expect(log[0]!.t).toBe(20);
    expect(log.at(-1)!.t).toBe(319);
  });

  it('cuts outerHTML snippets to 300 characters', () => {
    const el = document.createElement('div');
    el.textContent = 'x'.repeat(1000);
    expect(snippet(el)).toHaveLength(DIAG_SNIPPET_CHARS);
  });

  it('drops malformed entries from content scripts', () => {
    const ok = sanitizeEntries([entry(1), { t: 'x', kind: 'title' }, { t: 2, kind: 'nope' }, null, { t: 3, kind: 'list', data: { big: 'y'.repeat(9000) } }]);
    expect(ok.map((e) => e.t)).toEqual([1, 3]);
    expect(Object.keys(ok[1]!.data!)).toEqual(['truncated']);
    expect(sanitizeEntries('nope')).toEqual([]);
  });

  it('formats one line per entry with the watch-tab marker', () => {
    const text = formatDiagnosticsLog([{ ...entry(0), tab: 7, watch: true }], { version: '0.1.0', userAgent: 'UA', watchTabId: 7, now: 0 });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/background diagnostics/);
    expect(lines.at(-1)).toBe('1970-01-01T00:00:00.000Z | hidden | nofocus | 7W | /inbox | title | {"now":"0"}');
  });
});
