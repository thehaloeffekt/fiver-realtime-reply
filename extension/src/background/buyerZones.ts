/**
 * Saved buyer time zones (UTC offsets), one per buyer username, learned from
 * the conversation header whenever a conversation is open anyway.
 */
import { sanitizeZone, type BuyerZone } from '../lib/buyerTime';
import type { BuyerHeader } from '../lib/messages';
import { updateLocal, type LocalState } from '../lib/storage';

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ZONES = 500;
/** An unchanged reading rewrites the date at most this often. */
const REFRESH_MS = 60 * 60_000;

/** Saves a header reading. Same offset and country: only refresh the date (hourly). */
export function saveBuyerZone(raw: BuyerHeader | null | undefined, now = Date.now()): Promise<void> {
  const username = typeof raw?.username === 'string' && USERNAME.test(raw.username) ? raw.username.toLowerCase() : '';
  const zone = username ? sanitizeZone(raw, now) : null;
  if (!zone) return Promise.resolve();
  return updateLocal('buyerZones', (zones) => {
    const old = zones[username];
    // Keep a country seen before when this page did not show the panel.
    if (!zone.country && old?.country && old.offset === zone.offset) zone.country = old.country;
    if (old && old.offset === zone.offset && old.country === zone.country && now - old.at < REFRESH_MS) return zones;
    const next = { ...zones };
    delete next[username];
    next[username] = zone; // newest last
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ZONES))) delete next[k];
    return next;
  });
}

export function zoneFor(s: Pick<LocalState, 'buyerZones'>, username: string): BuyerZone | null {
  return (username && s.buyerZones?.[username.toLowerCase()]) || null;
}
