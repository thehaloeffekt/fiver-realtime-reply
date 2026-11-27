/**
 * Message times and the buyer's time zone.
 *
 * A Fiverr conversation page shows three time zones at once:
 * - message times ("Nov 16, 4:53 AM") are in the Fiverr account's zone,
 * - the conversation header shows the buyer's local time now ("9:59 AM (local time)"),
 * - the user has their own zone ("My time zone", see myZone.ts).
 *
 * Message times here come from the message id instead: its second half is a
 * version-1 UUID, which holds the moment the message was created. That is an
 * absolute time, so it can be shown in any zone. The buyer's zone is learned
 * as a UTC offset by comparing the header clock with the current UTC time.
 */

/** 100 ns ticks between 1582-10-15 (UUID epoch) and 1970-01-01. */
const UUID_EPOCH_OFFSET_MS = 12_219_292_800_000;
const UUID_V1 = /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * When a message was sent (ms since 1970), from its id
 * `{conversation uuid}_{message uuid}`. Null if the second half is not a
 * version-1 UUID or gives a time outside 2010–2100.
 */
export function messageSentAt(id: string): number | null {
  const part = id.split('_').pop() ?? '';
  const m = UUID_V1.exec(part);
  if (!m) return null;
  const ticks = (BigInt(`0x${m[3]}`) << 48n) | (BigInt(`0x${m[2]}`) << 32n) | BigInt(`0x${m[1]}`);
  const ms = Number(ticks / 10_000n) - UUID_EPOCH_OFFSET_MS;
  return ms > Date.UTC(2010, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

/** "2:57 AM", "14:57" → minutes since midnight, or null. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(text.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].toLowerCase() === 'pm';
    h = (h % 12) + (pm ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + min;
}

/** Offsets that exist: UTC-12:00 … UTC+14:00. */
export const MIN_OFFSET = -12 * 60;
export const MAX_OFFSET = 14 * 60;

/**
 * The buyer's UTC offset in minutes, from the header clock and the current
 * time. The clock has no date, so the difference is only known modulo 24 h:
 * it is rounded to 15 minutes and put in [-10:00, +14:00). That range covers
 * every inhabited zone except Baker/Howland (-12) and Niue/American Samoa
 * (-11), which read as +12 and +13 (New Zealand, Fiji and Tonga, where far
 * more buyers live). The result is always in the -12 to +14 range.
 */
export function offsetFromClock(clockMinutes: number, now: number): number {
  const d = new Date(now);
  const utc = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  // The clock shows whole minutes: the buyer's time is on average 30 s later.
  let diff = Math.round((clockMinutes + 0.5 - utc) / 15) * 15;
  diff = ((diff % 1440) + 1440) % 1440; // 0 … 1425
  if (diff >= 14 * 60) diff -= 1440; // [-600, 840)
  return diff;
}

/** "UTC+0", "UTC+5:30", "UTC-3:30" */
export function formatOffset(offset: number): string {
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** A buyer's zone as saved per username. */
export interface BuyerZone {
  /** Minutes east of UTC. */
  offset: number;
  /** When the header was last read. */
  at: number;
  /** From the About panel ("From" row), when the page shows it. */
  country?: string;
}

/** After 30 days a saved offset is still used, with a "?": daylight saving may have changed it. */
export const ZONE_STALE_MS = 30 * 24 * 60 * 60_000;
export const isStaleZone = (z: BuyerZone, now: number) => now - z.at > ZONE_STALE_MS;

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** Date and time parts of `ts` in an explicit zone (never the default local zone). */
function partsIn(ts: number, timeZone: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
}

/** Parts at a fixed offset: shift the instant and read it as UTC. */
const partsAtOffset = (ts: number, offset: number): Parts => partsIn(ts + offset * 60_000, 'UTC');

const clock = (p: Parts) => `${p.h % 12 || 12}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`;
const day = (p: Parts) => `${MONTHS[p.mo - 1]} ${p.d}`;
const sameDay = (a: Parts, b: Parts) => a.y === b.y && a.mo === b.mo && a.d === b.d;

/** "Nov 16, 10:53 AM" in `timeZone` (My time zone). */
export function formatMine(ts: number, timeZone: string): string {
  const p = partsIn(ts, timeZone);
  return `${day(p)}, ${clock(p)}`;
}

/** "10:53 AM" when `ts` is on the same day as `now` in `timeZone`, else "Nov 16, 10:53 AM". */
export function formatMineShort(ts: number, now: number, timeZone: string): string {
  const p = partsIn(ts, timeZone);
  return sameDay(p, partsIn(now, timeZone)) ? clock(p) : `${day(p)}, ${clock(p)}`;
}

/**
 * The buyer's time for a moment: "9:53 AM", or "Nov 15, 9:53 PM" when the
 * buyer's date differs from mine (my date in `timeZone`). A "?" follows when
 * the offset is old. The buyer's side never uses a zone name: it is the
 * moment shifted by the saved offset and read as UTC.
 */
export function formatBuyerAt(ts: number, zone: BuyerZone, now: number, timeZone: string): string {
  const b = partsAtOffset(ts, zone.offset);
  const text = sameDay(b, partsIn(ts, timeZone)) ? clock(b) : `${day(b)}, ${clock(b)}`;
  return isStaleZone(zone, now) ? `${text}?` : text;
}

/** "Buyer local time now: 9:54 AM (UTC+0, United Kingdom)" */
export function buyerNowLine(zone: BuyerZone, now: number, timeZone: string): string {
  const inside = [formatOffset(zone.offset), zone.country].filter(Boolean).join(', ');
  return `Buyer local time now: ${formatBuyerAt(now, zone, now, timeZone)} (${inside})`;
}

/** Cleans a zone sent by a content script. */
export function sanitizeZone(raw: unknown, now: number): BuyerZone | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const offset = Number(r.offset);
  if (!Number.isInteger(offset) || offset % 15 !== 0 || offset < MIN_OFFSET || offset > MAX_OFFSET) return null;
  const country = typeof r.country === 'string' ? r.country.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return country ? { offset, at: now, country } : { offset, at: now };
}
