import { DEDUPE_WINDOW_MS, Deduper, REPLAY_WINDOW_MS, SenderGate, dedupeKey, senderId, senderKey, type AlertSource } from '../lib/dedupe';
import { formatAlert } from '../lib/format';
import { INBOX_URL } from '../lib/constants';
import type { ListMessage } from '../lib/inboxRow';
import { getLocal, getSession, isConfigured, labelOf, setLocal, setSession, updateLocal, type RecentAlert } from '../lib/storage';
import { describeBody, type Toast } from '../lib/toast';
import { notify } from './notify';

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
}

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
  const displayName = String(m.displayName ?? '').trim().slice(0, 100);
  if (!displayName) return;
  // The row's avatar gives the username. The map learned from toasts is only
  // a fallback, for a row read without its attributes.
  let username = typeof m.username === 'string' && USERNAME.test(m.username) ? m.username : '';
  if (!username) username = (await getLocal()).knownUsers[senderKey(displayName)] ?? '';
  const count = Number.isFinite(m.count) ? Math.max(1, Math.min(99, Math.floor(m.count))) : 1;
  return handleIncoming({ source: 'list', displayName, username, body: String(m.body ?? '').slice(0, 5000), more: count - 1 });
}

async function handleIncoming(m: Incoming): Promise<void> {
  await loadDedupe();
  const s = await getLocal();
  if (!s.settings.sendAlerts || !s.accountId) return;

  const described = describeBody(m.body);
  // Some unread rows in the list have an empty preview: that is not an empty message.
  const body = described.kind === 'empty' && m.source === 'list' ? { ...described, text: 'New message (no preview in the inbox list). Check Fiverr.' } : described;
  if (body.kind === 'attachment' && !s.settings.attachmentAlerts) return;

  // Check and record in one synchronous step (no await in between), so the
  // same message from two tabs, or from the toast and the list, cannot both pass.
  const now = Date.now();
  // Keyed on the username, so two buyers with the same display name stay apart.
  if (!m.username) m.username = s.knownUsers[senderKey(m.displayName)] ?? '';
  const sender = senderId(m.username, m.displayName);
  const key = dedupeKey(s.accountId, sender, m.body);
  // A replayed toast is old news if this message was alerted in the last 2 hours.
  if (!deduper.take(key, now, m.replay ? REPLAY_WINDOW_MS : DEDUPE_WINDOW_MS)) return;
  if (!senderGate.take(sender, m.source, body.kind === 'text', now)) return;
  void setSession({ dedupe: deduper.entries() });

  const recent: RecentAlert = { at: now, displayName: m.displayName, username: m.username, text: body.text, status: 'sent' };
  if (!isConfigured(s)) {
    await remember({ ...recent, status: 'not-linked' });
    return;
  }

  const { html, keyboard } = formatAlert(labelOf(s), m, body.text, s.accountId, m.more ?? 0);
  try {
    await notify(html, { keyboard, claim: true, retries: 3 });
    await setLocal({ lastAlertAt: now });
    await remember(recent);
  } catch (err) {
    console.warn('[alert] send failed', err);
    // Let a copy of this message from another tab or detector try again.
    deduper.release(key, now);
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
