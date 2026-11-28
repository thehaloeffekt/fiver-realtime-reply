/**
 * Background diagnostics (debug mode only): a record of what a Fiverr page
 * does while it is hidden, so we can see which signals still fire there.
 * Pure helpers live here; the recorder itself is src/content/diagnostics.ts.
 */
import { zoneNote, zoneOffsetAt, type MyZone } from './myZone';

export const DIAG_MAX_ENTRIES = 300;
/** outerHTML snippets are cut to this length. */
export const DIAG_SNIPPET_CHARS = 300;
/** At most this many row/node changes inside one entry, so one big re-render cannot fill the log. */
export const DIAG_MAX_CHANGES = 6;

export type DiagKind =
  | 'start' // recorder started on this page
  | 'stop'
  | 'visibility' // visibilitychange
  | 'lifecycle' // focus, blur, freeze, resume, pageshow, pagehide, online, offline
  | 'heartbeat' // every 5 min; a long gap means timers were throttled or the page was frozen
  | 'url' // in-app navigation
  | 'title' // document.title changed
  | 'toast-container' // ul.realtime-notifications found / lost
  | 'toast' // mutation inside ul.realtime-notifications
  | 'list-found'
  | 'list-lost'
  | 'list' // rows added, removed or changed in the inbox conversation list
  | 'list-order' // row order changed
  | 'chip-found'
  | 'chip-lost'
  | 'chip'; // text or attribute change in the "Unread" filter chip

export interface DiagEntry {
  /** Epoch ms when the event happened in the page (not when it was stored). */
  t: number;
  /** document.visibilityState at that moment. */
  vis: string;
  /** document.hasFocus() at that moment. */
  focus: boolean;
  /** location.pathname. */
  path: string;
  kind: DiagKind;
  data?: Record<string, unknown>;
  /** Added by the background: the sender tab, and whether it is the watch tab. */
  tab?: number;
  watch?: boolean;
}

/** Collapses whitespace and cuts to `max` characters. */
export function normText(s: string | null | undefined, max = 200): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** First DIAG_SNIPPET_CHARS characters of an element's outerHTML (or a text node's text). */
export function snippet(node: Node | null | undefined): string {
  if (!node) return '';
  const raw = node instanceof Element ? node.outerHTML : `#text ${JSON.stringify(node.textContent ?? '')}`;
  return raw.length > DIAG_SNIPPET_CHARS ? raw.slice(0, DIAG_SNIPPET_CHARS) : raw;
}

/** Appends entries and keeps the newest DIAG_MAX_ENTRIES. */
export function appendDiag(log: DiagEntry[], entries: DiagEntry[]): DiagEntry[] {
  const next = log.concat(entries);
  return next.length > DIAG_MAX_ENTRIES ? next.slice(next.length - DIAG_MAX_ENTRIES) : next;
}

const KINDS = new Set<string>([
  'start', 'stop', 'visibility', 'lifecycle', 'heartbeat', 'url', 'title', 'toast-container', 'toast',
  'list-found', 'list-lost', 'list', 'list-order', 'chip-found', 'chip-lost', 'chip',
]);

/** The background accepts only well-formed entries of bounded size from content scripts. */
export function sanitizeEntries(input: unknown): DiagEntry[] {
  if (!Array.isArray(input)) return [];
  const out: DiagEntry[] = [];
  for (const e of input.slice(0, 100)) {
    if (!e || typeof e !== 'object') continue;
    const { t, vis, focus, path, kind, data } = e as Record<string, unknown>;
    if (typeof t !== 'number' || typeof kind !== 'string' || !KINDS.has(kind)) continue;
    const entry: DiagEntry = {
      t,
      vis: String(vis ?? '').slice(0, 16),
      focus: Boolean(focus),
      path: String(path ?? '').slice(0, 200),
      kind: kind as DiagKind,
    };
    if (data && typeof data === 'object') {
      const json = JSON.stringify(data);
      entry.data = json.length <= 8000 ? (data as Record<string, unknown>) : { truncated: json.slice(0, 8000) };
    }
    out.push(entry);
  }
  return out;
}

/**
 * "2026-11-16 18:52:03.120 +01:00": wall time in `timeZone` (My time zone)
 * with its offset, so a line reads in the user's own time and still pins one
 * exact moment.
 */
export function logTime(ts: number, timeZone: string): string {
  const offset = zoneOffsetAt(ts, timeZone);
  const d = new Date(ts + offset * 60_000); // read as UTC: the wall time in timeZone
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const abs = Math.abs(offset);
  const off = `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)} ${off}`;
}

/** The text that "Copy diagnostics log" puts on the clipboard: a header, then one line per entry. */
export function formatDiagnosticsLog(entries: DiagEntry[], meta: { version: string; userAgent: string; watchTabId?: number; now?: number; zone: MyZone }): string {
  const now = meta.now ?? Date.now();
  const tz = meta.zone.zone;
  const header = [
    `# Fiverr Telegram Alerts background diagnostics`,
    `# copied ${logTime(now, tz)} · extension ${meta.version} · ${entries.length} entries`,
    `# times: ${zoneNote(meta.zone)}`,
    `# ${meta.userAgent}`,
    `# watch tab id: ${meta.watchTabId ?? 'none'}`,
    `# columns: time | visibility | focus | tab (W = watch tab) | path | kind | data`,
  ];
  const lines = entries.map((e) => {
    const tab = e.tab == null ? '-' : `${e.tab}${e.watch ? 'W' : ''}`;
    const data = e.data ? JSON.stringify(e.data) : '';
    return [logTime(e.t, tz), e.vis, e.focus ? 'focus' : 'nofocus', tab, e.path, e.kind, data].join(' | ');
  });
  return [...header, ...lines].join('\n');
}

/** Normalized start of a reply text, for finding it in diagnostics entries. */
export function replyProbe(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 24);
}

/**
 * Leaves out every entry that holds the start of a reply sent from Telegram
 * (the list row "Me: …" and the new message in the thread show it), so the
 * reply text never lands in the diagnostics log. An entry is kept as a stub
 * with its time and kind, so the log still shows that something happened.
 */
export function redactReplies(entries: DiagEntry[], probes: string[]): DiagEntry[] {
  const list = probes.filter(Boolean);
  if (!list.length) return entries;
  const escaped = list.map((p) => p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return entries.map((e) => {
    if (!e.data) return e;
    const hay = JSON.stringify(e.data).replace(/\\n|\\t|\\r/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    if (!list.some((p) => hay.includes(p)) && !escaped.some((p) => hay.includes(p))) return e;
    return { ...e, data: { redacted: 'left out: holds a reply sent from Telegram' } };
  });
}
