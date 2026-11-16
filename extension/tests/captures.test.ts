// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Tests built from the real Fiverr captures of 2026-11-16, sanitized
 * (buyer names, usernames, image and download links replaced): see
 * tests/fixtures/*.html. The structure, attributes and hashed class names are
 * as captured; the code must not depend on the hashed ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatCheck, formatConversation } from '../src/background/commands';
import { buyerMessages, parseConversation, readLoggedInUsername, readRows, readUnreadChip } from '../src/content/reader';
import { parseRow, parseRowStructure } from '../src/lib/inboxRow';
import { formatMine, messageSentAt } from '../src/lib/buyerTime';
import { formatAlert } from '../src/lib/format';

// Fixtures are imported as text by Vite (`?raw`), no file system access needed
const FIXTURES: Record<string, string> = import.meta.glob('./fixtures/*.html', { query: '?raw', import: 'default', eager: true });
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`]!;
const load = (html: string) => {
  document.body.innerHTML = html;
  return document.body;
};
afterEach(() => (document.body.innerHTML = ''));

describe('inbox list capture', () => {
  it('reads every row: username, name, time, preview, mine, unread', () => {
    load(fixture('inbox-list.html'));
    const rows = readRows();
    expect(rows.ok).toBe(true);
    const value = rows.ok ? rows.value : [];
    expect(value.map((r) => [r.username, r.name, r.time, r.unread, r.mine])).toEqual([
      ['buyer_one', 'Buyer One', '3 minutes', 4, false],
      ['client_two', 'client_two', '6 days', 0, true],
      ['client_three', 'Client Three', '5 weeks', 0, true],
      ['client_four', 'Client Four', '5 months', 3, false],
      ['client_five', 'Client Five', '5 months', 3, false],
      ['client_six', 'client_six', '5 months', 2, false],
      ['client_seven', 'client_seven', '5 months', 2, false],
    ]);
    expect(value[0]!.preview).toBe('please review the draft tomorrow');
  });

  it('strips the "Me: " span and keeps the line breaks of a long preview', () => {
    load(fixture('inbox-list.html'));
    const rows = readRows();
    const mine = rows.ok ? rows.value[1]! : null;
    expect(mine?.mine).toBe(true);
    expect(mine?.preview.startsWith('Hi,')).toBe(true);
    expect(mine?.preview).toContain('\n\nThe milestone is done.');
  });

  it('handles an unread row with an empty excerpt', () => {
    load(fixture('inbox-list.html'));
    const rows = readRows();
    const r = rows.ok ? rows.value[3]! : null;
    expect(r).toMatchObject({ username: 'client_four', unread: 3, preview: '', mine: false, typing: false });
  });

  it('reads a single row capture (with the hover menu open)', () => {
    load(fixture('inbox-row.html'));
    const row = document.querySelector('[data-testid="contact"]')!;
    expect(parseRowStructure(row)).toMatchObject({ username: 'buyer_one', name: 'Buyer One', time: '5 minutes', unread: 4, preview: 'please review the draft tomorrow' });
  });

  it('does not use hashed class names: the row parses with every class removed', () => {
    load(fixture('inbox-row.html'));
    for (const el of Array.from(document.querySelectorAll('[class]'))) {
      const keep = el.className.split(/\s+/).filter((c) => c === 'contact-excerpt');
      el.setAttribute('class', keep.join(' '));
    }
    expect(parseRow(document.querySelector('[data-testid="contact"]')!)).toMatchObject({ username: 'buyer_one', unread: 4 });
  });

  it('falls back to the text order when the attributes are gone (no username)', () => {
    load(fixture('inbox-row.html'));
    const row = document.querySelector('[data-testid="contact"]')!;
    row.querySelector('.contact-excerpt')!.classList.remove('contact-excerpt');
    expect(parseRow(row)).toMatchObject({ username: '', name: 'Buyer One', unread: 4, preview: 'please review the draft tomorrow' });
  });
});

describe('Unread chip capture', () => {
  it('reads the count of unread conversations', () => {
    load(fixture('unread-chip.html'));
    expect(readUnreadChip()).toEqual({ ok: true, value: 5 });
  });

  it('a chip without a count is 0; no chip is an error', () => {
    load(fixture('unread-chip.html'));
    document.querySelector('button[aria-label="Unread"] [data-track-tag="box"]')!.remove();
    expect(readUnreadChip()).toEqual({ ok: true, value: 0 });
    load('<div></div>');
    expect(readUnreadChip().ok).toBe(false);
  });

  it('the chip count matches the unread rows in the list capture', () => {
    load(fixture('inbox-list.html'));
    const rows = readRows();
    expect(rows.ok && rows.value.filter((r) => r.unread > 0).length).toBe(5);
  });
});

describe('/check and Check now', () => {
  it('lists the chip count and each unread row with name and username', () => {
    load(fixture('inbox-list.html') + fixture('unread-chip.html'));
    const html = formatCheck('my_seller', { page: '1', unread: readUnreadChip(), rows: readRows() });
    expect(html.split('\n')).toEqual([
      '<b>my_seller</b>: 5 unread conversations',
      '• Buyer One (@buyer_one): 4 unread',
      '• Client Four (@client_four): 3 unread',
      '• Client Five (@client_five): 3 unread',
      '• client_six (@client_six): 2 unread',
      '• client_seven (@client_seven): 2 unread',
    ]);
  });
});

describe('list alerts with the username', () => {
  it('have "(@user)", Full message and a direct Open inbox link', () => {
    const { html, keyboard } = formatAlert('my_seller', { username: 'buyer_one', displayName: 'Buyer One' }, 'please review the draft', 'acc1');
    expect(html).toContain('(@buyer_one)');
    expect(keyboard[0]![0]).toEqual({ text: 'Open inbox', url: 'https://www.fiverr.com/inbox/buyer_one' });
    expect(keyboard[1]!.map((b) => b.text)).toEqual(['Full message', 'Check now']);
  });
});

describe('conversation capture', () => {
  it('message ids are unique, share the conversation part, and are time-based UUIDs matching the shown time', () => {
    load(fixture('conversation.html'));
    const ids = Array.from(document.querySelectorAll('div.message[id]')).map((e) => e.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    const parts = ids.map((id) => id.split('_'));
    expect(new Set(parts.map((p) => p[0])).size).toBe(1);
    // Version-1 UUID: 100 ns ticks since 1582-10-15 in the time fields.
    const sentAt = (u: string) => {
      const [low, mid, hi] = u.split('-');
      const ticks = (BigInt(`0x${hi!.slice(1)}`) << 48n) | (BigInt(`0x${mid}`) << 32n) | BigInt(`0x${low}`);
      return Number(ticks / 10_000n) - 12_219_292_800_000;
    };
    for (const p of parts) expect(p[1]![14]).toBe('1'); // version digit
    // Last message is shown as "Nov 15, 9:51 PM" (UTC-5): 2026-11-16 02:51 UTC.
    expect(new Date(sentAt(parts[29]![1]!)).toISOString().slice(0, 16)).toBe('2026-11-16T02:51');
  });

  it('reads sender, time, body and files; skips interface text', () => {
    load(fixture('conversation.html'));
    const all = parseConversation();
    expect(all).toHaveLength(30);
    expect(all[0]).toMatchObject({ sender: 'my_seller', me: true, time: 'Oct 06, 9:25 AM' });
    expect(all[4]).toMatchObject({ sender: 'buyer_one', me: false, time: 'Nov 13, 1:49 AM', text: 'hello', files: [] }); // had "Translate to English"
    expect(all[14]).toMatchObject({ text: 'see the attached sketch', files: ['logo-draft.png'] });
    expect(all[15]).toMatchObject({ text: '', files: ['website.zip'] }); // body was "1 File"
    expect(all[29]).toMatchObject({ text: 'please review the draft tomorrow', time: 'Nov 15, 9:51 PM' });
    for (const m of all) {
      expect(m.text).not.toMatch(/Translate to English|Create an offer|Buyer One|^Me$/);
      expect(m.id).toMatch(/_/);
    }
  });

  it('Full message: the buyer\'s last 10, with time and [file: name]', () => {
    load(fixture('conversation.html'));
    const last = buyerMessages(parseConversation(), 10, 'my_seller');
    expect(last).toHaveLength(10);
    expect(last.every((m) => m.id)).toBe(true);
    // The account's zone was UTC-5: the time from each message id, shown in
    // that zone, is exactly the time the page showed. So the ids carry the
    // real send time.
    expect(formatConversation(last, null, Date.UTC(2026, 10, 16, 3), 'America/New_York').split('\n')).toEqual([
      "<i>Nov 14, 4:20 PM</i>: Hello, how is the work going",
      '<i>Nov 14, 4:32 PM</i>: Checking in once more',
      '<i>Nov 14, 4:34 PM</i>: Did the site files make sense',
      "<i>Nov 15, 11:30 AM</i>: Good, any news",
      "<i>Nov 15, 11:33 AM</i>: Extra details attached [file: brief-a.pdf]",
      '<i>Nov 15, 11:36 AM</i>: Did you receive it?',
      '<i>Nov 15, 9:45 PM</i>: Any progress today',
      '<i>Nov 15, 9:47 PM</i>: [file: notes-b.txt]',
      "<i>Nov 15, 9:49 PM</i>: Correct file attached now [file: brief-a.pdf]",
      '<i>Nov 15, 9:51 PM</i>: please review the draft tomorrow',
    ]);
    for (const m of last) expect(formatMine(messageSentAt(m.id)!, 'America/New_York')).toBe(m.time);
  });

  it('tells my messages apart by the "Me" name even without my username', () => {
    load(fixture('conversation.html'));
    const last = buyerMessages(parseConversation(), 50);
    expect(last).toHaveLength(21); // 30 messages, 9 of them "Me"
  });

  it('does not take the buyer in the conversation header for the logged-in user', () => {
    load(fixture('conversation.html'));
    expect(readLoggedInUsername()).toBeNull();
  });
});

describe('account menu capture', () => {
  it('reads my username from the header avatar', () => {
    load(`<div class="main-header"><header>${fixture('account-menu.html')}</header></div>` + fixture('conversation.html'));
    expect(readLoggedInUsername()).toBe('my_seller');
  });

  it('accepts a header avatar outside .main-header when its img alt matches', () => {
    load(`<header>${fixture('account-menu.html')}</header>`);
    expect(readLoggedInUsername()).toBe('my_seller');
  });
});
