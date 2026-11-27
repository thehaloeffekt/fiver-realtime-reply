/**
 * "My time zone": the zone every time shown to the user is written in.
 *
 * The browser's own zone cannot be trusted for this. An anti-detect browser
 * reports the zone configured for each profile (for example UTC-5), not the
 * zone of the computer, and it hides the real one. So the zone is a setting
 * (Settings.myTimeZone, an IANA name such as "Africa/Lagos"), and every
 * formatter takes the zone as an explicit argument and passes it to
 * Intl.DateTimeFormat's timeZone option. Nothing formats with the default
 * local zone.
 *
 * When the setting is empty, the browser's zone is used, and the zone name is
 * shown next to the times with "not set", so a wrong time is visibly
 * explained instead of silently trusted.
 */
import { formatOffset } from './buyerTime';

export interface MyZone {
  /** The IANA zone to format with. Always valid. */
  zone: string;
  /** False: the setting is empty and `zone` is the browser's zone. */
  set: boolean;
}

/** The zone this browser (or this anti-detect profile) reports. */
export function browserZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Letters, digits and _ + - /, starting with a letter: rules out "+01:00" style offsets. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** True if Intl can format in this zone. */
export function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !ZONE_SHAPE.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone to show times in: the setting when it is valid, else the browser's zone. */
export function myZone(settings: { myTimeZone?: string }, fallback: string = browserZone()): MyZone {
  const z = settings.myTimeZone?.trim();
  return z && isValidZone(z) ? { zone: z, set: true } : { zone: fallback, set: false };
}

/** "Africa/Lagos", or "America/Bogota, browser zone, not set" */
export function zoneNote(z: MyZone): string {
  return z.set ? z.zone : `${z.zone}, browser zone, not set`;
}

/** Minutes east of UTC that `zone` is at the moment `ts`. */
export function zoneOffsetAt(ts: number, zone: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60_000);
}

/** "UTC+1" for the zone at `ts`. */
export const zoneOffsetText = (ts: number, zone: string) => formatOffset(zoneOffsetAt(ts, zone));

/** Every IANA zone this browser knows, for the settings list. */
export function allZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

/** The top-level areas of IANA names, for short forms that are only an alias ("Kolkata", "Kyiv"). */
const AREAS = ['Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific'];

export type ZoneLookup = { ok: true; zone: string } | { ok: false; matches: string[] };

/**
 * A zone from what the user typed: a full IANA name in any case
 * ("africa/lagos", "Asia/Kolkata"), or a short form that matches exactly one
 * zone ("Lagos", "new york", "Indiana/Indianapolis"). `matches` lists the
 * candidates when a short form is ambiguous, and is empty when nothing matches.
 */
export function lookupZone(input: string, zones: string[] = allZones()): ZoneLookup {
  const raw = input.trim().replace(/\s+/g, '_');
  if (!raw || !ZONE_SHAPE.test(raw)) return { ok: false, matches: [] };
  const lower = raw.toLowerCase();

  // A full name: use the list's spelling when it has one, else what Intl accepts (aliases).
  const exact = zones.find((z) => z.toLowerCase() === lower);
  if (exact) return { ok: true, zone: exact };
  if (raw.includes('/') && isValidZone(raw)) return { ok: true, zone: raw };
  if (lower === 'utc' || lower === 'gmt') return { ok: true, zone: 'UTC' };

  // A short form: the end of a name, after a "/".
  const found = zones.filter((z) => z.toLowerCase().endsWith(`/${lower}`));
  // Aliases that the list does not contain (it holds only one spelling per zone).
  if (!found.length) {
    for (const area of AREAS) {
      const name = `${area}/${raw}`;
      if (isValidZone(name)) found.push(name);
    }
  }
  return found.length === 1 ? { ok: true, zone: found[0]! } : { ok: false, matches: found.slice(0, 10) };
}
