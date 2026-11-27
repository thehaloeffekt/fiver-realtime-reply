// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * "My time zone" with a browser that lies about its zone.
 *
 * The whole file runs with the process zone set to America/Bogota (UTC-5 all
 * year, no daylight saving), like an anti-detect browser profile configured
 * for UTC-5, while the user's selected zone is Africa/Lagos (UTC+1). Every
 * time shown to the user must follow the selected zone, and the buyer's
 * offset (header clock compared with UTC) must not move at all.
 * Names and texts are made up; the times are the ones from the bug report.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { fullReplyParts, formatConversation, seenText, statusLine, timesLine, zoneStatusText } from '../src/background/commands';
import { readBuyerHeader } from '../src/content/reader';
import { formatBuyerAt, offsetFromClock, parseClock, type BuyerZone } from '../src/lib/buyerTime';
import { formatDiagnosticsLog, logTime, type DiagEntry } from '../src/lib/diagnostics';
import { formatAgo, formatTime } from '../src/lib/format';
import { browserZone, isValidZone, lookupZone, myZone, zoneNote, zoneOffsetAt, zoneOffsetText } from '../src/lib/myZone';

const FIXTURES: Record<string, string> = import.meta.glob('./fixtures/*.html', { query: '?raw', import: 'default', eager: true });

// Set before anything below reads the zone (UNSET reads it at load). Node
// applies a TZ change to both Date and Intl at once.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const savedTz = env.TZ;
env.TZ = 'America/Bogota';
afterAll(() => {
  if (savedTz === undefined) delete env.TZ;
  else env.TZ = savedTz;
});

function v1(ms: number): string {
  const ticks = (BigInt(ms) + 12_219_292_800_000n) * 10_000n;
  const hex = (n: bigint, len: number) => n.toString(16).padStart(len, '0');
  return `${hex(ticks & 0xffffffffn, 8)}-${hex((ticks >> 32n) & 0xffffn, 4)}-1${hex((ticks >> 48n) & 0xfffn, 3)}-8000-000000000000`;
}
const id = (ms: number) => `00000000-0000-4000-8000-000000000000_${v1(ms)}`;
const at = (iso: string) => Date.parse(iso);

const LAGOS = { zone: 'Africa/Lagos', set: true };
const UNSET = myZone({ myTimeZone: '' }); // the browser zone: America/Bogota
// The message from the report: 6:52 PM in Lagos, 5:52 PM for a buyer at UTC+0.
const SENT = at('2026-11-16T17:52:00Z');
const NOW = at('2026-11-16T18:07:00Z');
const UK: BuyerZone = { offset: 0, at: NOW, country: 'United Kingdom' };

describe('the test browser really is at UTC-5', () => {
  it('Date and Intl both report America/Bogota', () => {
    expect(new Date(NOW).getTimezoneOffset()).toBe(300);
    expect(new Date(NOW).getHours()).toBe(13); // 18:07 UTC is 1:07 PM in the browser
    expect(browserZone()).toBe('America/Bogota');
  });
});

describe('buyer offset does not depend on the browser zone', () => {
  // The header clock is compared with UTC (getUTCHours), never with local time.
  it('offsetFromClock gives the same offsets with the browser at UTC-5', () => {
    expect(offsetFromClock(parseClock('6:07 PM')!, NOW + 30_000)).toBe(0); // United Kingdom
    expect(offsetFromClock(parseClock('7:07 PM')!, NOW + 30_000)).toBe(60); // Lagos
    expect(offsetFromClock(parseClock('1:07 PM')!, NOW + 30_000)).toBe(-300); // New York, the browser's own offset
    expect(offsetFromClock(parseClock('11:37 PM')!, NOW + 30_000)).toBe(330); // India
  });

  it('the header fixture reads the same offsets as with a UTC browser', () => {
    document.body.innerHTML = FIXTURES['./fixtures/conversation.html']!;
    expect(readBuyerHeader('buyer_one', at('2026-11-16T02:57:30Z'))?.offset).toBe(0);
    expect(readBuyerHeader('buyer_one', at('2026-11-16T07:57:30Z'))?.offset).toBe(-300);
    document.body.innerHTML = '';
  });
});

describe('Full message uses the selected zone, not the browser zone', () => {
  const msg = { id: id(SENT), time: 'Nov 16, 12:52 PM', text: 'hello', files: [] };

  it('the report: 6:52 PM my time, 5:52 PM the buyer, with the zone on top', () => {
    const body = formatConversation([msg], UK, LAGOS.zone, NOW);
    expect(body).toBe('<i>Nov 16, 6:52 PM (buyer 5:52 PM)</i>: hello');
    expect(fullReplyParts('Main', 'some_buyer', body, UK, LAGOS, NOW)[0]!.split('\n').slice(0, 3)).toEqual([
      '<b>Main</b>: last messages from <b>@some_buyer</b>',
      'Times: Africa/Lagos. Buyer local time now: 6:07 PM (UTC+0, United Kingdom)',
      '<i>Nov 16, 6:52 PM (buyer 5:52 PM)</i>: hello',
    ]);
  });

  it('without the setting: the browser zone, and the top line says so', () => {
    expect(UNSET).toEqual({ zone: 'America/Bogota', set: false });
    expect(formatConversation([msg], UK, UNSET.zone, NOW)).toBe('<i>Nov 16, 12:52 PM (buyer 5:52 PM)</i>: hello');
    expect(timesLine(UNSET, UK, NOW)).toBe('Times: America/Bogota (browser zone, not set: send /timezone Your/Zone). Buyer local time now: 6:07 PM (UTC+0, United Kingdom)');
    expect(timesLine(LAGOS, null, NOW)).toBe('Times: Africa/Lagos.');
  });

  it('the buyer\'s date is compared with my date in my zone, not the browser\'s', () => {
    // 00:30 UTC: Nov 16, 1:30 AM in Lagos; Nov 15, 7:30 PM for a buyer at UTC-5 (and in the browser).
    const late = at('2026-11-16T00:30:00Z');
    const west: BuyerZone = { offset: -300, at: late };
    expect(formatBuyerAt(late, west, late, LAGOS.zone)).toBe('Nov 15, 7:30 PM');
    expect(formatBuyerAt(late, west, late, UNSET.zone)).toBe('7:30 PM');
  });
});

describe('the setting', () => {
  it('uses a valid saved zone, else falls back to the browser zone', () => {
    expect(myZone({ myTimeZone: 'Africa/Lagos' })).toEqual(LAGOS);
    expect(myZone({ myTimeZone: 'Mars/Olympus' })).toEqual({ zone: 'America/Bogota', set: false });
    expect(myZone({})).toEqual({ zone: 'America/Bogota', set: false });
    expect(zoneNote(LAGOS)).toBe('Africa/Lagos');
    expect(zoneNote(UNSET)).toBe('America/Bogota, browser zone, not set');
  });

  it('offsets of the zone itself, from Intl', () => {
    expect(zoneOffsetAt(NOW, 'Africa/Lagos')).toBe(60);
    expect(zoneOffsetText(NOW, 'Africa/Lagos')).toBe('UTC+1');
    expect(zoneOffsetText(NOW, 'Asia/Kathmandu')).toBe('UTC+5:45');
    expect(zoneOffsetText(NOW, 'America/Bogota')).toBe('UTC-5');
    expect(zoneOffsetText(at('2026-07-01T12:00:00Z'), 'Europe/London')).toBe('UTC+1'); // summer time
  });

  it('accepts full names in any case and short forms that match one zone', () => {
    expect(lookupZone('Africa/Lagos')).toEqual({ ok: true, zone: 'Africa/Lagos' });
    expect(lookupZone('africa/lagos')).toEqual({ ok: true, zone: 'Africa/Lagos' });
    expect(lookupZone('Lagos')).toEqual({ ok: true, zone: 'Africa/Lagos' });
    expect(lookupZone('new york')).toEqual({ ok: true, zone: 'America/New_York' });
    expect(lookupZone('utc')).toEqual({ ok: true, zone: 'UTC' });
    // An alias the list may not hold (it may say Asia/Calcutta): still one zone at +5:30.
    const kolkata = lookupZone('Kolkata');
    expect(kolkata.ok).toBe(true);
    if (kolkata.ok) expect(zoneOffsetAt(NOW, kolkata.zone)).toBe(330);
  });

  it('rejects unknown names and offsets, and lists the candidates of an ambiguous short form', () => {
    expect(lookupZone('Nowhere')).toEqual({ ok: false, matches: [] });
    expect(lookupZone('+01:00')).toEqual({ ok: false, matches: [] });
    expect(lookupZone('<b>x</b>')).toEqual({ ok: false, matches: [] });
    expect(isValidZone('+01:00')).toBe(false);
    expect(lookupZone('Indianapolis', ['America/Indiana/Indianapolis', 'America/Fort_Wayne/Indianapolis'])).toEqual({
      ok: false,
      matches: ['America/Indiana/Indianapolis', 'America/Fort_Wayne/Indianapolis'],
    });
  });
});

describe('every other time shown to me uses the same setting', () => {
  it('/status: last alert and offline since, with the zone named', () => {
    expect(seenText(SENT, LAGOS, NOW)).toBe('6:52 PM (Africa/Lagos)');
    expect(seenText(SENT, UNSET, NOW)).toBe('12:52 PM (America/Bogota, browser zone, not set)');
    expect(seenText(undefined, LAGOS, NOW)).toBe('never');
    expect(statusLine('Main', true, { n: 2, live: true }, SENT, LAGOS, NOW)).toBe('<b>Main</b>: online, alerts on, 2 unread conversations, last alert 6:52 PM (Africa/Lagos)');
  });

  it('/timezone without a zone: the zone and its clock now', () => {
    expect(zoneStatusText('Main', LAGOS, NOW)).toBe('<b>Main</b>: Africa/Lagos (now 7:07 PM, UTC+1)');
    expect(zoneStatusText('Main', UNSET, NOW)).toContain('not set. Using the browser zone America/Bogota (now 1:07 PM, UTC-5)');
  });

  it('popup: "last alert" is relative, then the time in my zone after a day', () => {
    expect(formatAgo(SENT, SENT + 5 * 60_000, LAGOS.zone)).toBe('5 min ago');
    const nextDay = SENT + 30 * 60 * 60_000;
    expect(formatAgo(SENT, nextDay, LAGOS.zone)).toBe('Nov 16, 6:52 PM');
    expect(formatTime(SENT, NOW, LAGOS.zone)).toBe('6:52 PM');
    // Same moment, but 6:52 PM Lagos is still "today" at 11:30 PM Lagos, which is already Nov 17 in UTC.
    expect(formatTime(SENT, at('2026-11-16T22:30:00Z'), LAGOS.zone)).toBe('6:52 PM');
  });

  it('diagnostics log: wall time in my zone with its offset, and the zone in the header', () => {
    const e: DiagEntry = { t: SENT + 120, vis: 'hidden', focus: false, path: '/inbox', kind: 'heartbeat', tab: 3, watch: true };
    expect(logTime(SENT + 120, 'Africa/Lagos')).toBe('2026-11-16 18:52:00.120 +01:00');
    const log = formatDiagnosticsLog([e], { version: '1', userAgent: 'UA', now: NOW, zone: LAGOS }).split('\n');
    expect(log[1]).toBe('# copied 2026-11-16 19:07:00.000 +01:00 · extension 1 · 1 entries');
    expect(log[2]).toBe('# times: Africa/Lagos');
    expect(log.at(-1)).toBe('2026-11-16 18:52:00.120 +01:00 | hidden | nofocus | 3W | /inbox | heartbeat | ');
    expect(formatDiagnosticsLog([e], { version: '1', userAgent: 'UA', now: NOW, zone: UNSET }).split('\n')[2]).toBe('# times: America/Bogota, browser zone, not set');
    expect(logTime(SENT, 'Asia/Kathmandu')).toBe('2026-11-16 23:37:00.000 +05:45');
  });
});
