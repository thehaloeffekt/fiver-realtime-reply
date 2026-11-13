import { Deduper, dedupeKey } from '../lib/dedupe';
import { formatAlert, formatUnread } from '../lib/format';
import { INBOX_URL } from '../lib/constants';
import type { InboxSnapshot } from '../lib/messages';
import { getLocal, getSession, isConfigured, labelOf, setLocal, setSession, updateLocal, type RecentAlert } from '../lib/storage';
import { describeBody, type Toast } from '../lib/toast';
import { notify } from './notify';

const deduper = new Deduper();
let loaded: Promise<void> | null = null;

/** The dedupe table lives in memory; a copy in storage.session survives a worker restart. */
function loadDedupe(): Promise<void> {
  loaded ??= getSession().then((s) => deduper.load(s.dedupe, Date.now()));
  return loaded;
}

function remember(alert: RecentAlert) {
  return updateLocal('recentAlerts', (list) => [alert, ...list].slice(0, 20));
}

/** A toast reported by any Fiverr tab of this profile. */
export async function handleToast(toast: Toast): Promise<void> {
  await loadDedupe();
  const s = await getLocal();
  if (!s.settings.sendAlerts || !s.accountId) return;

  const body = describeBody(toast.body);
  if (body.kind === 'attachment' && !s.settings.attachmentAlerts) return;

  // Check and record in one synchronous step (no await in between), so the
  // same toast from two tabs cannot both pass.
  const now = Date.now();
  const key = dedupeKey(s.accountId, toast.conversationId, toast.body);
  if (!deduper.take(key, now)) return;
  void setSession({ dedupe: deduper.entries() });

  const recent: RecentAlert = { at: now, displayName: toast.displayName, username: toast.username, text: body.text, status: 'sent' };
  if (!isConfigured(s)) {
    await remember({ ...recent, status: 'not-linked' });
    return;
  }

  const { html, keyboard } = formatAlert(labelOf(s), toast, body.text, s.accountId);
  try {
    await notify(html, { keyboard, claim: true, retries: 3 });
    await setLocal({ lastAlertAt: now });
    await remember(recent);
  } catch (err) {
    console.warn('[alert] send failed', err);
    // Let a copy of this toast from another tab try again.
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

/**
 * After each watch-tab reload: alert when the unread count went up. The
 * first reading after setup only sets the baseline.
 */
export async function afterReload(snapshot: InboxSnapshot): Promise<void> {
  if (!snapshot.unread.ok) return;
  const n = snapshot.unread.value;
  const s = await getLocal();
  const previous = s.lastUnread;
  await setLocal({ lastUnread: n });
  if (previous === undefined || n <= previous) return;
  if (!s.settings.sendAlerts || !s.settings.unreadCheck || !isConfigured(s)) return;
  const { html, keyboard } = formatUnread(labelOf(s), n);
  await notify(html, { keyboard, claim: true, retries: 3 }).catch((e) => console.warn('[unread] send failed', e));
}
