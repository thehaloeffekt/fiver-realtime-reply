// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Message times (from the message id) and the buyer's time zone (from the
 * conversation header). Names, usernames and texts are made up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatConversation, fullReplyText } from '../src/background/commands';
import {
  MAX_OFFSET,
  MIN_OFFSET,
  ZONE_STALE_MS,
  buyerNowLine,
  formatBuyerAt,
  formatMine,
  formatOffset,
  messageSentAt,
  offsetFromClock,
  parseClock,
  sanitizeZone,
  type BuyerZone,
} from '../src/lib/buyerTime';
import { formatAlert } from '../src/lib/format';
import { conversationUsername, readBuyerHeader, readCountry } from '../src/content/reader';

const FIXTURES: Record<string, string> = import.meta.glob('./fixtures/*.html', { query: '?raw', import: 'default', eager: true });
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`]!;
afterEach(() => (document.body.innerHTML = ''));

/** A version-1 UUID for a given time (what Fiverr's message ids hold). */
function v1(ms: number): string {
  const ticks = (BigInt(ms) + 12_219_292_800_000n) * 10_000n;
  const hex = (n: bigint, len: number) => n.toString(16).padStart(len, '0');
  const low = hex(ticks & 0xffffffffn, 8);
  const mid = hex((ticks >> 32n) & 0xffffn, 4);
  const hi = hex((ticks >> 48n) & 0xfffn, 3);
  return `${low}-${mid}-1${hi}-8000-000000000000`;
}
const id = (ms: number) => `00000000-0000-4000-8000-000000000000_${v1(ms)}`;
const at = (iso: string) => Date.parse(iso);

describe('message time from the id', () => {
  it('reads the time-based UUID after the "_"', () => {
    expect(messageSentAt(id(at('2026-11-16T09:53:00Z')))).toBe(at('2026-11-16T09:53:00Z'));
  });
  it('null for ids that are not version-1 UUIDs', () => {
    expect(messageSentAt('00000000-0000-4000-8000-000000000000_11111111-2222-4333-8444-555555555555')).toBeNull();
    expect(messageSentAt('abc')).toBeNull();
    expect(messageSentAt('')).toBeNull();
  });
});

describe('buyer offset from the header clock', () => {
  it('parses 12- and 24-hour clocks', () => {
    expect(parseClock('2:57 AM')).toBe(177);
    expect(parseClock('12:05 AM')).toBe(5);
    expect(parseClock('12:30 PM')).toBe(750);
    expect(parseClock('9:59 pm')).toBe(21 * 60 + 59);
    expect(parseClock('14:57')).toBe(14 * 60 + 57);
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('13:00 PM')).toBeNull();
    expect(parseClock('Online')).toBeNull();
  });

  it('the real example: header 9:59 AM when UTC is 9:59 → UTC+0', () => {
    expect(offsetFromClock(parseClock('9:59 AM')!, at('2026-11-16T09:59:20Z'))).toBe(0);
  });

  it('rounds to 15 minutes, so a clock a few minutes old still gives the right offset', () => {
    expect(offsetFromClock(parseClock('9:53 AM')!, at('2026-11-16T09:59:50Z'))).toBe(0); // 7 min stale
    expect(offsetFromClock(parseClock('10:06 AM')!, at('2026-11-16T09:59:10Z'))).toBe(0); // 7 min fast
    expect(offsetFromClock(parseClock('3:27 PM')!, at('2026-11-16T09:57:00Z'))).toBe(330); // India
    expect(offsetFromClock(parseClock('1:42 PM')!, at('2026-11-16T07:57:00Z'))).toBe(345); // Nepal
  });

  it('wraps across midnight', () => {
    expect(offsetFromClock(parseClock('11:00 PM')!, at('2026-11-16T01:00:00Z'))).toBe(-120);
    expect(offsetFromClock(parseClock('2:57 AM')!, at('2026-11-16T07:57:00Z'))).toBe(-300);
  });

  it('picks one offset in -12 … +14: -10 stays (Hawaii), -11 reads as +13, +14 reads as -10', () => {
    expect(offsetFromClock(parseClock('11:00 PM')!, at('2026-11-16T09:00:00Z'))).toBe(-600);
    expect(offsetFromClock(parseClock('10:00 PM')!, at('2026-11-16T09:00:00Z'))).toBe(780);
    expect(offsetFromClock(parseClock('9:00 PM')!, at('2026-11-16T09:00:00Z'))).toBe(720);
    for (let m = 0; m < 1440; m += 7) {
      const o = offsetFromClock(m, at('2026-11-16T09:00:00Z'));
      expect(o).toBeGreaterThanOrEqual(MIN_OFFSET);
      expect(o).toBeLessThanOrEqual(MAX_OFFSET);
      expect(Math.abs(o % 15)).toBe(0);
    }
  });

  it('formats the offset', () => {
    expect(formatOffset(0)).toBe('UTC+0');
    expect(formatOffset(330)).toBe('UTC+5:30');
    expect(formatOffset(-210)).toBe('UTC-3:30');
    expect(formatOffset(-300)).toBe('UTC-5');
  });

  it('rejects offsets that do not exist', () => {
    expect(sanitizeZone({ offset: 15 * 60 }, 0)).toBeNull();
    expect(sanitizeZone({ offset: 7 }, 0)).toBeNull();
    expect(sanitizeZone({ offset: 'x' }, 0)).toBeNull();
    expect(sanitizeZone({ offset: -300, country: '  Some  Country ' }, 5)).toEqual({ offset: -300, at: 5, country: 'Some Country' });
  });
});

describe('conversation header capture', () => {
  it('reads the buyer clock "2:57 AM (local time)" and the offset it implies', () => {
    document.body.innerHTML = fixture('conversation.html');
    expect(readBuyerHeader('buyer_one', at('2026-11-16T02:57:30Z'))).toEqual({ username: 'buyer_one', offset: 0, clock: '2:57 AM' });
    expect(readBuyerHeader('Buyer_One', at('2026-11-16T07:57:30Z'))?.offset).toBe(-300);
  });

  it('ignores a header that names another buyer (page still changing)', () => {
    document.body.innerHTML = fixture('conversation.html');
    expect(readBuyerHeader('someone_else', at('2026-11-16T02:57:30Z'))).toBeNull();
  });

  it('message times are not taken for the header clock', () => {
    document.body.innerHTML = fixture('conversation.html');
    document.querySelector('header')!.remove();
    expect(readBuyerHeader('buyer_one', at('2026-11-16T02:57:30Z'))).toBeNull();
  });

  it('takes the username only from a conversation URL', () => {
    expect(conversationUsername('/inbox/buyer_one')).toBe('buyer_one');
    expect(conversationUsername('/inbox/buyer_one/')).toBe('buyer_one');
    expect(conversationUsername('/inbox')).toBe('');
    expect(conversationUsername('/inbox/a/b')).toBe('');
    expect(conversationUsername('/users/buyer_one')).toBe('');
  });

  it('details pane capture: reads the country from the "From" row', () => {
    document.body.innerHTML = fixture('conversation.html') + fixture('details-pane.html');
    expect(readCountry()).toBe('Example Country');
    expect(readBuyerHeader('buyer_one', at('2026-11-16T02:57:30Z'))).toEqual({ username: 'buyer_one', offset: 0, clock: '2:57 AM', country: 'Example Country' });
  });

  it('no country when the sidebar is closed, or the pane has no "From" row', () => {
    document.body.innerHTML = fixture('conversation.html');
    expect(readCountry()).toBe('');
    expect(readBuyerHeader('buyer_one', at('2026-11-16T02:57:30Z'))).not.toHaveProperty('country');
    document.body.innerHTML = fixture('details-pane.html');
    const from = Array.from(document.querySelectorAll('p[data-track-tag="text"]')).find((p) => p.textContent === 'From')!;
    from.textContent = 'Language';
    expect(readCountry()).toBe('');
  });

  it('other rows of the pane are never taken for the country ("English: Fluent", "On Fiverr since")', () => {
    document.body.innerHTML = fixture('details-pane.html');
    document.querySelector('ul[data-track-tag="list"]')!.lastElementChild!.remove(); // drop "From"
    expect(readCountry()).toBe('');
  });

  it('does not use hashed class names: the pane parses with every class removed', () => {
    document.body.innerHTML = fixture('details-pane.html');
    for (const el of Array.from(document.querySelectorAll('[class]'))) el.removeAttribute('class');
    expect(readCountry()).toBe('Example Country');
  });

  it('rejects a value that is not a plain place name', () => {
    document.body.innerHTML = fixture('details-pane.html');
    const value = Array.from(document.querySelectorAll('p[data-track-tag="typography"]')).find((p) => p.textContent === 'Example Country')!;
    value.textContent = '<b>12345</b> https://x';
    expect(readCountry()).toBe('');
  });
});

describe('Full message with my time and the buyer time', () => {
  const uk: BuyerZone = { offset: 0, at: at('2026-11-10T00:00:00Z') };
  const now = at('2026-11-16T09:54:00Z');

  it('the real example: account UTC-5 showed 4:53 AM, me UTC+1, buyer UTC+0', () => {
    const msg = { id: id(at('2026-11-16T09:53:00Z')), time: 'Nov 16, 4:53 AM', text: 'hello there', files: [] };
    expect(formatConversation([msg], uk, 'Europe/Paris', now)).toBe('<i>Nov 16, 10:53 AM (buyer 9:53 AM)</i>: hello there');
  });

  it('shows the buyer\'s day when it is a different day from mine', () => {
    const msg = { id: id(at('2026-11-16T02:51:00Z')), time: '', text: 'late one', files: ['plan.pdf'] };
    const west: BuyerZone = { offset: -300, at: now };
    expect(formatConversation([msg], west, 'Europe/Paris', now)).toBe('<i>Nov 16, 3:51 AM (buyer Nov 15, 9:51 PM)</i>: late one [file: plan.pdf]');
  });

  it('no buyer time when the offset is unknown', () => {
    const msg = { id: id(at('2026-11-16T09:53:00Z')), time: '', text: 'hi', files: [] };
    expect(formatConversation([msg], null, 'Europe/Paris', now)).toBe('<i>Nov 16, 10:53 AM</i>: hi');
  });

  it('falls back to the page time, marked as the Fiverr account time, when the id gives none', () => {
    const msg = { id: 'not-a-uuid', time: 'Nov 16, 4:53 AM', text: 'hi', files: [] };
    expect(formatConversation([msg], uk, 'Europe/Paris', now)).toBe('<i>Nov 16, 4:53 AM (Fiverr account time)</i>: hi');
  });

  it('adds "?" after the buyer time when the offset is over 30 days old', () => {
    const old: BuyerZone = { offset: 0, at: now - ZONE_STALE_MS - 1000 };
    expect(formatBuyerAt(at('2026-11-16T09:53:00Z'), old, now, 'Europe/Paris')).toBe('9:53 AM?');
    expect(buyerNowLine(old, now, 'Europe/Paris')).toBe('Buyer local time now: 9:54 AM? (UTC+0)');
  });

  it('top line: buyer local time now, offset and country', () => {
    const paris = { zone: 'Europe/Paris', set: true };
    const html = fullReplyText('Main', 'some_buyer', 'line', { ...uk, country: 'Example Country' }, paris, now);
    expect(html.split('\n').slice(0, 3)).toEqual([
      '<b>Main</b>: last messages from <b>@some_buyer</b>',
      'Times: Europe/Paris. Buyer local time now: 9:54 AM (UTC+0, Example Country)',
      'line',
    ]);
    expect(fullReplyText('Main', 'some_buyer', 'line', null, paris, now).split('\n').slice(1, 3)).toEqual(['Times: Europe/Paris.', 'line']);
  });

  it('my time uses the zone it is given', () => {
    expect(formatMine(at('2026-11-16T09:53:00Z'), 'Asia/Tokyo')).toBe('Nov 16, 6:53 PM');
  });
});

describe('alert: Buyer time line', () => {
  it('is the last line when the offset is known, absent otherwise', () => {
    const withTime = formatAlert('Main', { username: 'some_buyer', displayName: 'Some Buyer' }, 'hi', 'acc1', 1, '9:54 AM');
    expect(withTime.html.split('\n').at(-1)).toBe('Buyer time: 9:54 AM');
    const without = formatAlert('Main', { username: 'some_buyer', displayName: 'Some Buyer' }, 'hi', 'acc1');
    expect(without.html).not.toContain('Buyer time');
  });
});
