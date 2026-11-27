import { browser } from 'wxt/browser';
import type { BuyerZone } from './buyerTime';
import type { DiagEntry } from './diagnostics';
import type { SavedListState } from './listState';
import type { CaptureKind } from './selectors';
import { DEFAULT_RELAY_URL } from './constants';

/** chrome.storage.local: survives restarts. The bot token lives here and nowhere else. */
export interface LocalState {
  token?: string;
  bot?: { id: number; username: string; firstName: string };
  botKey?: string;
  secret?: string;
  relayUrl: string;
  webhookUrl?: string;
  chatId?: number;
  /** Until this time, this profile is "waiting at step 3" and replies "Linked" to /start. */
  linkWaitUntil?: number;
  accountId?: string;
  /**
   * Random code (64 hex chars) made at setup. The relay keeps only its
   * SHA-256; the uninstall URL carries the code, so the relay can remove
   * this one account after an uninstall. Never the token or the secret.
   */
  removalCode?: string;
  /** Set when the relay removed this profile (/remove or uninstall elsewhere); drives the popup notice. */
  removedAt?: number;
  label?: string;
  /** Logged-in Fiverr username, read from the profile button in the page header. */
  detectedUsername?: string;
  settings: Settings;
  recentAlerts: RecentAlert[];
  lastAlertAt?: number;
  /** Last "Unread" chip count (unread conversations) after a reload. */
  lastUnread?: number;
  /**
   * The watch tab's inbox list per conversation, kept current while the tab
   * runs. After a reload (or at browser start) the fresh list is compared
   * with it, so messages that arrived in between still alert.
   */
  listState?: SavedListState;
  seenUpdateIds: number[];
  /** Claims for alerts sent while the relay was down; sent on reconnect. */
  pendingClaims: Array<{ chatId: number; messageId: number }>;
  captures: Partial<Record<CaptureKind, Capture>>;
  /**
   * Display name (lowercased) → username, learned from toasts. Only a
   * fallback now: list rows carry the username themselves. Used when a row
   * was read by the text fallback, which has no username.
   */
  knownUsers: Record<string, string>;
  /**
   * Buyer username (lowercased) → UTC offset read from the conversation
   * header, with the date it was read. Learned only from conversations that
   * were open anyway; newest 500 kept.
   */
  buyerZones: Record<string, BuyerZone>;
  /** Background diagnostics (debug mode): the last 300 entries from Fiverr pages. */
  diagnostics: DiagEntry[];
}

export interface Settings {
  sendAlerts: boolean;
  attachmentAlerts: boolean;
  unreadCheck: boolean;
  keepWatchTab: boolean;
  debug: boolean;
  reloadMinMinutes: number;
  reloadMaxMinutes: number;
  /**
   * IANA zone that times are shown in ("Africa/Lagos"). Empty: the browser's
   * zone, marked "not set". A setting because an anti-detect browser reports
   * the profile's configured zone, not the computer's. See myZone.ts.
   */
  myTimeZone: string;
}

export interface RecentAlert {
  at: number;
  displayName: string;
  username: string;
  text: string;
  /** "sent", or why it was not. */
  status: 'sent' | 'failed' | 'not-linked';
}

export interface Capture {
  at: number;
  url: string;
  html: string;
}

export const DEFAULT_SETTINGS: Settings = {
  sendAlerts: true,
  attachmentAlerts: true,
  unreadCheck: true,
  keepWatchTab: true,
  debug: false,
  reloadMinMinutes: 25,
  reloadMaxMinutes: 35,
  myTimeZone: '',
};

const LOCAL_DEFAULTS: LocalState = {
  relayUrl: DEFAULT_RELAY_URL,
  settings: DEFAULT_SETTINGS,
  recentAlerts: [],
  seenUpdateIds: [],
  pendingClaims: [],
  captures: {},
  knownUsers: {},
  buyerZones: {},
  diagnostics: [],
};

/** chrome.storage.session: cleared when the browser closes. Tab ids are only valid until then. */
export interface SessionState {
  watchTabId?: number;
  nextReloadAt?: number;
  relay: RelayStatus;
  presence: PresenceAccount[];
  telegram: { lastError?: string; lastErrorAt?: number; lastOkAt?: number };
  dedupe: Array<[string, number]>;
  /** Since when the watch tab has been hidden on a conversation (it returns to /inbox after 60 s). */
  watchOffInboxSince?: number;
  /** Last time the watch tab was reloaded because its page looked stale. */
  lastStaleReloadAt?: number;
}

export type RelayPhase = 'idle' | 'connecting' | 'connected' | 'offline';

export interface RelayStatus {
  phase: RelayPhase;
  since?: number;
  lastError?: string;
  closeCode?: number;
  attempts: number;
  nextAttemptAt?: number;
}

export interface PresenceAccount {
  accountId: string;
  label: string;
  online: boolean;
  lastSeen: number;
}

const SESSION_DEFAULTS: SessionState = {
  relay: { phase: 'idle', attempts: 0 },
  presence: [],
  telegram: {},
  dedupe: [],
};

export async function getLocal(): Promise<LocalState> {
  const raw = (await browser.storage.local.get(null)) as Partial<LocalState>;
  return { ...LOCAL_DEFAULTS, ...raw, settings: { ...DEFAULT_SETTINGS, ...raw.settings } };
}

/**
 * chrome.storage drops keys whose value is undefined instead of clearing
 * them, so `{ key: undefined }` in a patch means "remove key".
 */
async function applyPatch(area: typeof browser.storage.local, patch: object): Promise<void> {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [k, v] of Object.entries(patch)) (v === undefined ? remove.push(k) : (set[k] = v));
  if (remove.length) await area.remove(remove);
  if (Object.keys(set).length) await area.set(set);
}

export async function setLocal(patch: Partial<LocalState>): Promise<void> {
  await applyPatch(browser.storage.local, patch);
}

let localChain: Promise<unknown> = Promise.resolve();
let sessionChain: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write of one key, one at a time. Two alerts that arrive in the
 * same moment would otherwise both read the old list and one write would win.
 */
export function updateLocal<K extends keyof LocalState>(key: K, fn: (value: LocalState[K]) => LocalState[K]): Promise<void> {
  const run = localChain.then(async () => {
    const s = await getLocal();
    await setLocal({ [key]: fn(s[key]) } as Partial<LocalState>);
  });
  localChain = run.catch(() => undefined);
  return run;
}

export function updateSession<K extends keyof SessionState>(key: K, fn: (value: SessionState[K]) => SessionState[K]): Promise<void> {
  const run = sessionChain.then(async () => {
    const s = await getSession();
    await setSession({ [key]: fn(s[key]) } as Partial<SessionState>);
  });
  sessionChain = run.catch(() => undefined);
  return run;
}

export async function removeLocal(keys: Array<keyof LocalState>): Promise<void> {
  await browser.storage.local.remove(keys);
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const { settings } = await getLocal();
  const next = { ...settings, ...patch };
  await setLocal({ settings: next });
  return next;
}

export async function getSession(): Promise<SessionState> {
  const raw = (await browser.storage.session.get(null)) as Partial<SessionState>;
  return { ...SESSION_DEFAULTS, ...raw };
}

export async function setSession(patch: Partial<SessionState>): Promise<void> {
  await applyPatch(browser.storage.session, patch);
}

export async function removeSession(keys: Array<keyof SessionState>): Promise<void> {
  await browser.storage.session.remove(keys);
}

/** Setup is done when the bot is linked to a chat and the relay keys exist. */
export function isConfigured(s: LocalState): s is LocalState & Required<Pick<LocalState, 'token' | 'chatId' | 'accountId' | 'botKey' | 'secret'>> {
  return Boolean(s.token && s.chatId && s.accountId && s.botKey && s.secret);
}

export function labelOf(s: LocalState): string {
  return knownLabel(s) ?? 'Fiverr account';
}

/** The label the user saved, else the username read from Fiverr, else null. */
export function knownLabel(s: LocalState): string | null {
  return s.label?.trim() || s.detectedUsername || null;
}
