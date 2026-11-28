import { DEDUPE_WINDOW_MS, Deduper, REPLAY_WINDOW_MS, SenderGate, dedupeKey, senderId, senderKey, type AlertSource } from '../lib/dedupe';
import { formatBuyerAt } from '../lib/buyerTime';
import { myZone } from '../lib/myZone';
import { formatAlert } from '../lib/format';
import { sliceSafe } from '../lib/split';
import { INBOX_URL } from '../lib/constants';
import type { ListMessage } from '../lib/inboxRow';
import type { ThreadMessage } from '../lib/messages';
import { getLocal, getSession, isConfigured, labelOf, setLocal, setSession, updateLocal, type RecentAlert } from '../lib/storage';
import { describeBody, type Toast } from '../lib/toast';
import { zoneFor } from './buyerZones';
import { notify } from './notify';
import { rememberReplyTarget } from './replyTargets';
import { conversationInView } from './view';

/** Keys are kept for REPLAY_WINDOW_MS so replayed toasts can be checked against them. */
const deduper = new Deduper(DEDUPE_WINDOW_MS, REPLAY_WINDOW_MS);
const senderGate = new SenderGate();
let loaded: Promise<void> | null = null;

/** The dedupe table lives in memory; a copy in storage.session survives a worker restart. */
function loadDedupe(): Promise<void> {
  loaded ??= getSession().then((s) => deduper.load(s.dedupe, Date.now()));
  return loaded;
}

function remember(alert: RecentAlert) {
  return updateLocal('recentAlerts', (list) => [alert, ...list].slice(0, 20));
}

/** A new message from either detector, in one shape. */
interface Incoming {
  source: AlertSource;
  displayName: string;
  /** Empty only when neither the row nor the name → username map had it. */
  username: string;
  body: string;
  /** Toast shown when a long-hidden tab became visible again. */
  replay?: boolean;
  /** Extra messages this one change stands for (list only). */
  more?: number;
  /** Text for the dedupe key when it differs from `body` (thread: the text without "[file: …]"). */
  keyBody?: string;
  /** What the alert says, when `body` is not run through describeBody (thread). */
  shown?: { kind: 'text' | 'attachment'; text: string };
  /** Fiverr's message id (thread only): a second key, so two tabs never alert twice. */
  messageId?: string;
  /** Dedupe window for the body key (default 20 s). */
  windowMs?: number;
}

/**
 * Window for alerts that may follow a thread alert for the same message
 * later than the usual 20 s: a list row read at once, seen after a reload.
 */
const READ_WINDOW_MS = 10 * 60_000;

/** A toast reported by any Fiverr tab of this profile. */
export async function handleToast(toast: Toast): Promise<void> {
  // Learn display name → username, so list alerts from this buyer get buttons.
  const name = senderKey(toast.displayName);
  if (name && toast.username) {
    void updateLocal('knownUsers', (m) => {
      if (m[name] === toast.username) return m;
      const next = { ...m, [name]: toast.username };
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete next[k]; // keep the newest 300
      return next;
    });
  }
  return handleIncoming({ source: 'toast', displayName: toast.displayName, username: toast.username, body: toast.body, replay: toast.replay });
}

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** A new message seen in the /inbox conversation list (works in a hidden tab). */
export async function handleListMessage(m: ListMessage): Promise<void> {
  const displayName = sliceSafe(String(m.displayName ?? '').trim(), 100);
  if (!displayName) return;
  // The row's avatar gives the username. The map learned from toasts is only
  // a fallback, for a row read without its attributes.
  let username = typeof m.username === 'string' && USERNAME.test(m.username) ? m.username : '';
  if (!username) username = (await getLocal()).knownUsers[senderKey(displayName)] ?? '';
  const count = Number.isFinite(m.count) ? Math.max(1, Math.min(99, Math.floor(m.count))) : 1;
  const body = sliceSafe(String(m.body ?? ''), 5000);
  if (m.read === true) {
    // Read at once: the conversation is open in some tab. If the user is
    // looking at it, they see the message; otherwise alert (deduped against
    // the thread detector's alert for the same message).
    if (!username || (await conversationInView(username))) return;
    return handleIncoming({ source: 'list', displayName, username, body, windowMs: READ_WINDOW_MS });
  }
  return handleIncoming({ source: 'list', displayName, username, body, more: count - 1 });
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{8,120}$/;

/**
 * A new buyer message in an open conversation (a tab the user is not
 * looking at). Text plus "[file: name]" for each file, as in "Full message";
 * the file itself is never read or sent.
 */
export async function handleThreadMessage(m: ThreadMessage): Promise<void> {
  const username = typeof m?.username === 'string' && USERNAME.test(m.username) ? m.username : '';
  const id = typeof m?.id === 'string' && MESSAGE_ID.test(m.id) ? m.id : '';
  if (!username || !id) return;
  // Another tab may show this conversation to the user right now.
  if (await conversationInView(username)) return;
  const text = sliceSafe(String(m.text ?? ''), 5000).trim();
  const files = (Array.isArray(m.files) ? m.files : []).map((f) => sliceSafe(String(f).replace(/\s+/g, ' ').trim(), 120)).filter(Boolean).slice(0, 10);
  const shownText = [text, ...files.map((f) => `[file: ${f}]`)].filter(Boolean).join(' ');
  if (!shownText) return;
  // Key on the text alone, as the toast and the list show it. A message with
  // only files is "1 File" / "2 Files" in a toast: use the same.
  const keyBody = text || `${files.length} ${files.length === 1 ? 'File' : 'Files'}`;
  const displayName = sliceSafe(String(m.displayName ?? '').replace(/\s+/g, ' ').trim(), 100) || username;
  return handleIncoming({ source: 'thread', displayName, username, body: shownText, keyBody, shown: { kind: text ? 'text' : 'attachment', text: shownText }, messageId: id });
}

/**
 * Messages this profile sent itself ("Send replies from Telegram"): key →
 * until when. The detectors already skip my own messages ("Me", my avatar,
 * "Me: " in the list); this is a second guard in case Fiverr shows one
 * without those marks. In memory: a worker restart forgets it, and then the
 * detectors' own rules still apply.
 */
const ownMessages = new Map<string, number>();
export const OWN_MESSAGE_WINDOW_MS = 10 * 60_000;

/** Called right before the extension clicks Send for `username`. */
export async function expectOwnMessage(username: string, text: string): Promise<void> {
  const { accountId } = await getLocal();
  if (!accountId) return;
  const now = Date.now();
  for (const [k, until] of ownMessages) if (until < now) ownMessages.delete(k);
  ownMessages.set(dedupeKey(accountId, senderId(username, ''), text), now + OWN_MESSAGE_WINDOW_MS);
}

function isOwnMessage(key: string, now: number): boolean {
  const until = ownMessages.get(key);
  return until !== undefined && until >= now;
}

async function handleIncoming(m: Incoming): Promise<void> {
  await loadDedupe();
  const s = await getLocal();
  if (!s.settings.sendAlerts || !s.accountId) return;

  const described = m.shown ?? describeBody(m.body);
  // Some unread rows in the list have an empty preview: that is not an empty message.
  const body = described.kind === 'empty' && m.source === 'list' ? { ...described, text: 'New message (no preview in the inbox list). Check Fiverr.' } : described;
  if (body.kind === 'attachment' && !s.settings.attachmentAlerts) return;

  // Check and record in one synchronous step (no await in between), so the
  // same message from two tabs, or from the toast and the list, cannot both pass.
  const now = Date.now();
  // Keyed on the username, so two buyers with the same display name stay apart.
  if (!m.username) m.username = s.knownUsers[senderKey(m.displayName)] ?? '';
  const sender = senderId(m.username, m.displayName);
  const key = dedupeKey(s.accountId, sender, m.keyBody ?? m.body);
  if (isOwnMessage(key, now)) return;
  // The same message id from two tabs (both with the conversation open).
  const idKey = m.messageId ? `${s.accountId}\u0000id\u0000${m.messageId}` : null;
  if (idKey && !deduper.take(idKey, now, REPLAY_WINDOW_MS)) return;
  // A replayed toast is old news if this message was alerted in the last 2 hours.
  if (!deduper.take(key, now, m.replay ? REPLAY_WINDOW_MS : (m.windowMs ?? DEDUPE_WINDOW_MS))) return;
  if (!senderGate.take(sender, m.source, body.kind === 'text', now)) return;
  void setSession({ dedupe: deduper.entries() });

  const recent: RecentAlert = { at: now, displayName: m.displayName, username: m.username, text: body.text, status: 'sent' };
  if (!isConfigured(s)) {
    await remember({ ...recent, status: 'not-linked' });
    return;
  }

  // The buyer's local time now, only when their offset was learned before.
  const zone = zoneFor(s, m.username);
  const buyerTime = zone ? formatBuyerAt(now, zone, now, myZone(s.settings).zone) : undefined;
  const { html, keyboard } = formatAlert(labelOf(s), m, body.text, s.accountId, m.more ?? 0, buyerTime);
  try {
    const sent = await notify(html, { keyboard, claim: true, retries: 3 });
    // A reply to this alert in Telegram goes to this buyer.
    if (m.username && sent) await rememberReplyTarget(sent.message_id, m.username).catch(() => undefined);
    await setLocal({ lastAlertAt: now });
    await remember(recent);
  } catch (err) {
    console.warn('[alert] send failed', err);
    // Let a copy of this message from another tab or detector try again.
    deduper.release(key, now);
    if (idKey) deduper.release(idKey, now);
    void setSession({ dedupe: deduper.entries() });
    await remember({ ...recent, status: 'failed' });
  }
}

export async function sendTestAlert(): Promise<void> {
  const s = await getLocal();
  if (!s.accountId) throw new Error('No account id yet.');
  const sample = { username: 'example_buyer', displayName: 'Example Buyer' };
  const { html, keyboard } = formatAlert(labelOf(s), sample, 'This is a test alert from Fiverr Telegram Alerts.', s.accountId);
  // The sample buyer does not exist: point the buttons at the inbox and at an
  // empty "full" target, which answers "this was a test".
  keyboard[0] = [{ text: 'Open inbox', url: INBOX_URL }];
  keyboard[1] = keyboard[1]!.map((b) => (b.callback_data?.includes('|full|') ? { ...b, callback_data: `c|${s.accountId}|full|` } : b));
  await notify(html, { keyboard, claim: true, retries: 3 });
}
