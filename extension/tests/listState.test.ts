// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { labelSavedText, linkedText } from '../src/background/commands';
import { watchInboxList } from '../src/content/inboxWatcher';
import { readRows } from '../src/content/reader';
import { Deduper, dedupeKey, senderId } from '../src/lib/dedupe';
import type { InboxRow, ListMessage } from '../src/lib/inboxRow';
import { SAVED_STATE_MAX_AGE_MS, compareWithSaved, stateOf, usableSaved, type RowState } from '../src/lib/listState';
import { DEFAULT_SETTINGS, type LocalState } from '../src/lib/storage';

// Fixtures are imported as text by Vite (`?raw`), no file system access needed
const FIXTURES: Record<string, string> = import.meta.glob('./fixtures/*.html', { query: '?raw', import: 'default', eager: true });
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`]!;
const rowsOfFixture = (html = fixture('inbox-list.html')): InboxRow[] => {
  document.body.innerHTML = html;
  const r = readRows();
  return r.ok ? r.value : [];
};
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** Changes one row of the list capture in place. */
function editRow(i: number, { preview, unread, mine }: { preview?: string; unread?: number; mine?: boolean }) {
  const row = document.querySelectorAll('[data-testid="contact"]')[i]!;
  const span = row.querySelector('.contact-excerpt span[data-track-tag="text"]') ?? row.querySelector('.contact-excerpt')!.appendChild(Object.assign(document.createElement('span'), {}));
  span.setAttribute('data-track-tag', 'text');
  if (preview !== undefined) span.innerHTML = `${mine ? '<span>Me: </span>' : ''}${preview}`;
  if (unread !== undefined) {
    const count = Array.from(row.querySelectorAll('p[data-track-tag="typography"]')).find((p) => /^\d+$/.test(p.textContent ?? ''));
    if (count) count.textContent = String(unread);
    else row.insertAdjacentHTML('beforeend', `<p data-track-tag="typography">${unread}</p>`);
  }
}

describe('compareWithSaved (the reload gap)', () => {
  it('nothing changed: no alerts', () => {
    const rows = rowsOfFixture();
    expect(compareWithSaved(stateOf(rows), rows)).toEqual([]);
  });

  it('alerts each unread row that changed while the page reloaded, with the username', () => {
    const saved = stateOf(rowsOfFixture());
    editRow(0, { preview: 'are you there?', unread: 5 }); // buyer_one: new text, count 4 → 5
    editRow(1, { preview: 'Got it, thanks', unread: 1 }); // client_two: last was mine, now theirs
    editRow(3, { unread: 4 }); // client_four: empty excerpt, count 3 → 4
    const out = compareWithSaved(saved, readRows().ok ? (readRows() as { value: InboxRow[] }).value : []);
    expect(out).toEqual([
      { username: 'buyer_one', displayName: 'Buyer One', body: 'are you there?', count: 1 },
      { username: 'client_two', displayName: 'client_two', body: 'Got it, thanks', count: 1 },
      { username: 'client_four', displayName: 'Client Four', body: '', count: 1 },
    ]);
  });

  it('ignores my own new message and rows that went read', () => {
    const saved = stateOf(rowsOfFixture());
    editRow(0, { preview: 'On it', mine: true, unread: 0 });
    editRow(4, { unread: 0 });
    expect(compareWithSaved(saved, (readRows() as { value: InboxRow[] }).value)).toEqual([]);
  });

  it('a new conversation above all saved rows alerts; an unknown row further down does not', () => {
    const saved = stateOf(rowsOfFixture());
    delete saved['u:client_seven']; // as if the old page never saw that row
    const fresh = (readRows() as { value: InboxRow[] }).value;
    const newcomer: InboxRow = { username: 'new_buyer', name: 'New Buyer', time: 'Just now', unread: 1, mine: false, typing: false, preview: 'Hello!' };
    expect(compareWithSaved(saved, [newcomer, ...fresh])).toEqual([{ username: 'new_buyer', displayName: 'New Buyer', body: 'Hello!', count: 1 }]);
  });

  it('keeps two buyers with the same display name apart', () => {
    const a: InboxRow = { username: 'sam_a', name: 'Sam', time: '1 day', unread: 0, mine: true, typing: false, preview: 'ok' };
    const b: InboxRow = { ...a, username: 'sam_b', mine: false, unread: 1, preview: 'hi' };
    const saved = stateOf([a, b]);
    expect(Object.keys(saved)).toEqual(['u:sam_a', 'u:sam_b']);
    const out = compareWithSaved(saved, [{ ...b, unread: 2, preview: 'hello?' }, a]);
    expect(out).toEqual([{ username: 'sam_b', displayName: 'Sam', body: 'hello?', count: 1 }]);
  });

  it('a "Typing..." row keeps its saved state', () => {
    const r: InboxRow = { username: 'u1', name: 'U', time: 'now', unread: 1, mine: false, typing: false, preview: 'hi' };
    const kept = stateOf([{ ...r, typing: true, preview: 'Typing...' }], stateOf([r]));
    expect(kept['u:u1']?.preview).toBe('hi');
  });

  it('saved state is used for 24 hours only', () => {
    const rows: Record<string, RowState> = {};
    expect(usableSaved({ at: 1000, page: 'p', rows }, 1000 + SAVED_STATE_MAX_AGE_MS - 1)).not.toBeNull();
    expect(usableSaved({ at: 1000, page: 'p', rows }, 1000 + SAVED_STATE_MAX_AGE_MS + 1)).toBeNull();
    expect(usableSaved(undefined, 1000)).toBeNull();
  });
});

describe('watchInboxList on the real list markup', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('alerts with the username, reports state per username, and reports presence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    document.body.innerHTML = fixture('inbox-list.html');
    const messages: ListMessage[] = [];
    const states: Array<Record<string, RowState>> = [];
    const presence: boolean[] = [];
    const stop = watchInboxList((m) => messages.push(m), { onState: (s) => states.push(s), onPresence: (p) => presence.push(p) });
    vi.setSystemTime(Date.now() + 10_000);
    expect(messages).toEqual([]); // rows at page load never alert
    expect(presence).toEqual([true]);
    expect(Object.keys(states[0]!)).toContain('u:buyer_one');

    editRow(0, { preview: 'one more thing', unread: 5 });
    await flush();
    expect(messages).toEqual([{ username: 'buyer_one', displayName: 'Buyer One', body: 'one more thing', count: 1 }]);
    expect(states.at(-1)!['u:buyer_one']).toMatchObject({ unread: 5, preview: 'one more thing' });

    // Only the relative time ticks: no alert and no new state report.
    const reports = states.length;
    document.querySelector('time')!.textContent = '4 minutes';
    await flush();
    expect(messages).toHaveLength(1);
    expect(states.length).toBe(reports);

    document.querySelector('nav')!.remove();
    document.body.append(document.createElement('div')); // body mutation → list looked up again
    await flush();
    expect(presence).toEqual([true, false]);
    stop();
  });
});

describe('dedupe on the username', () => {
  it('toast and list give the same key; same display name, different usernames do not', () => {
    const toast = dedupeKey('acc', senderId('buyer_one', 'Buyer One'), 'please review the draft tomorrow');
    const list = dedupeKey('acc', senderId('Buyer_One', 'Someone else'), 'please review the draft tomorrow');
    expect(toast).toBe(list);
    const d = new Deduper();
    expect(d.take(dedupeKey('acc', senderId('sam_a', 'Sam'), 'hi'), 0)).toBe(true);
    expect(d.take(dedupeKey('acc', senderId('sam_b', 'Sam'), 'hi'), 1)).toBe(true);
  });
});

describe('Linked message', () => {
  const base: LocalState = { relayUrl: '', settings: DEFAULT_SETTINGS, recentAlerts: [], seenUpdateIds: [], pendingClaims: [], captures: {}, knownUsers: {}, buyerZones: {}, diagnostics: [] };

  it('never shows the "Fiverr account" placeholder', () => {
    expect(linkedText(base)).not.toContain('Fiverr account');
    expect(linkedText(base)).toContain('step 4');
  });

  it('uses the username read from Fiverr, or the saved label', () => {
    expect(linkedText({ ...base, detectedUsername: 'my_seller' })).toContain('<b>my_seller</b>');
    expect(linkedText({ ...base, detectedUsername: 'my_seller', label: 'Main' })).toContain('<b>Main</b>');
    expect(labelSavedText('Main <2>')).toContain('<b>Main &lt;2&gt;</b>');
  });
});
