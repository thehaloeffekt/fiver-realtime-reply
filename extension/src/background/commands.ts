/**
 * Telegram updates that reach this profile through the relay: /start, /check,
 * /status, button presses, and the relay's "offline" notices.
 */
import { decodeCallback, isCallbackForMe } from '../lib/callback';
import { INBOX_URL, inboxUrlFor } from '../lib/constants';
import { formatTime, truncate } from '../lib/format';
import type { ConversationMessage, InboxSnapshot } from '../lib/messages';
import { getLocal, getSession, knownLabel, labelOf, setLocal, type LocalState } from '../lib/storage';
import { escapeHtml } from '../lib/telegram';
import { answerCallback, notify, sendTo } from './notify';
import { isRelayOpen } from './relay';
import { reloadAndCompare } from './listSync';
import { readConversation } from './watchTab';

type Json = Record<string, any>;

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** "/check@MyBot arg" → "check" */
export function commandOf(text: unknown): string | null {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  return text.slice(1).split(/[\s@]/)[0]!.toLowerCase();
}

/**
 * One profile speaks for the group (offline accounts in /status): the online
 * account with the smallest accountId, from the relay's presence frames.
 */
async function isLeader(myId: string): Promise<boolean> {
  const { presence } = await getSession();
  const online = presence.filter((a) => a.online).map((a) => a.accountId);
  if (!online.includes(myId)) online.push(myId);
  return online.sort()[0] === myId;
}

export async function handleUpdate(update: Json, routed: boolean): Promise<void> {
  try {
    if (update.message) await onMessage(update.message, routed);
    else if (update.callback_query) await onCallback(update.callback_query, routed);
  } catch (err) {
    console.warn('[update] failed', err);
  }
}

async function onMessage(message: Json, routed: boolean) {
  const s = await getLocal();
  const chat = message.chat ?? {};
  const command = commandOf(message.text);

  // Step 3 of setup. The relay sends /start to every profile on this bot.
  // Each one that has no chat yet saves it; only the profile whose options
  // page is waiting at this step answers, so the user gets one "Linked".
  if (!s.chatId) {
    if (command === 'start' && chat.type === 'private' && typeof chat.id === 'number') {
      await setLocal({ chatId: chat.id });
      if (s.linkWaitUntil && s.linkWaitUntil > Date.now()) {
        await setLocal({ linkWaitUntil: undefined });
        await sendTo(chat.id, linkedText(await getLocal()));
      }
    }
    return;
  }
  // From now on, only the linked chat counts.
  if (chat.id !== s.chatId) return;

  switch (command) {
    case 'start':
      if (s.linkWaitUntil && s.linkWaitUntil > Date.now()) {
        await setLocal({ linkWaitUntil: undefined });
        await notify(linkedText(s));
      }
      return;
    case 'check':
      return replyCheck(s);
    case 'status':
      return replyStatus(s);
    case 'help':
      if (await isLeader(s.accountId!)) await notify(HELP);
      return;
    case null:
      // A plain reply to one of our alerts (routed:true). Never sent to Fiverr.
      if (routed) {
        await notify('Replies are not sent to Fiverr. Open the inbox to answer the buyer.', {
          replyTo: message.message_id,
          keyboard: [[{ text: 'Open inbox', url: INBOX_URL }]],
        });
      }
      return;
  }
}

/**
 * The "Linked" reply. Setup links the chat (step 3) before the user names
 * the account (step 4), so the label may not exist yet. Use the saved label
 * or the username read from Fiverr, and never the "Fiverr account"
 * placeholder: without a name, say where to set one. Saving the label later
 * sends labelSavedText().
 */
export function linkedText(s: LocalState): string {
  const name = knownLabel(s);
  return name
    ? `Linked. Alerts for <b>${escapeHtml(name)}</b> will come to this chat.`
    : 'Linked. Alerts from this Chrome profile will come to this chat. Name the account in step 4 of the setup page; I will confirm the name here.';
}

export function labelSavedText(label: string): string {
  return `Account named <b>${escapeHtml(label)}</b>. Alerts from this Chrome profile start with this name.`;
}

const HELP = [
  '<b>Fiverr Telegram Alerts</b>',
  '/check: unread messages on every account',
  '/status: which accounts are online',
  'Buttons under an alert work only while the relay is online.',
].join('\n');

async function onCallback(cq: Json, routed: boolean) {
  const s = await getLocal();
  const data = decodeCallback(cq.data);
  // Not ours: another profile's button that the relay sent to everyone.
  if (!s.accountId || !isCallbackForMe(data, routed, s.accountId)) return;
  const chatId = cq.message?.chat?.id ?? cq.from?.id;
  if (!s.chatId || chatId !== s.chatId) return;
  const replyTo: number | undefined = cq.message?.message_id;

  switch (data!.action) {
    case 'check':
      await answerCallback(cq.id, 'Checking the inbox…');
      return replyCheck(s, replyTo);
    case 'full': {
      const username = data!.arg;
      if (!username) {
        await answerCallback(cq.id, 'This was a test alert. There is no message to open.');
        return;
      }
      if (!USERNAME.test(username)) {
        await answerCallback(cq.id, 'Invalid username.');
        return;
      }
      await answerCallback(cq.id, 'Opening the conversation…');
      return replyFull(s, username, replyTo);
    }
    default:
      await answerCallback(cq.id, 'This button is not supported by this version.');
  }
}

function missingNote(what: string, verb: 'is' | 'are', missing?: string, error?: string): string {
  if (missing) return `${what} ${verb} not available yet: selector <code>${escapeHtml(missing)}</code> is not set up.`;
  return `${what} could not be read${error ? `: ${escapeHtml(error)}` : ''}.`;
}

/** "/check" and "Check now": the Unread chip count, then each unread row with name and username. */
export function formatCheck(label: string, snap: InboxSnapshot): string {
  const lines = [`<b>${escapeHtml(label)}</b>`];
  if (snap.unread.ok) {
    const n = snap.unread.value;
    lines[0] += `: ${n === 0 ? 'no unread conversations' : `${n} unread ${n === 1 ? 'conversation' : 'conversations'}`}`;
  } else {
    lines.push(missingNote('The unread count', 'is', snap.unread.missing, snap.unread.error));
  }
  if (snap.rows.ok) {
    const unread = snap.rows.value.filter((r) => r.unread > 0);
    for (const r of unread.slice(0, 20)) {
      const who = r.username ? `${escapeHtml(r.name)} (@${escapeHtml(r.username)})` : escapeHtml(r.name);
      lines.push(`• ${who}: ${r.unread} unread`);
    }
    if (unread.length > 20) lines.push(`…and ${unread.length - 20} more`);
  } else if (!snap.unread.ok || snap.unread.value > 0) {
    lines.push(missingNote('The conversation list', 'is', snap.rows.missing, snap.rows.error));
  }
  return lines.join('\n');
}

async function replyCheck(s: LocalState, replyTo?: number) {
  const label = labelOf(s);
  let html: string;
  try {
    // The reload is a gap like any other: the compare alerts for messages
    // that arrived during it, before this summary is sent.
    const snap = await reloadAndCompare();
    html = formatCheck(label, snap);
  } catch (err) {
    html = `<b>${escapeHtml(label)}</b>: check failed. ${escapeHtml(String((err as Error).message ?? err))}`;
  }
  await notify(html, { replyTo, keyboard: [[{ text: 'Open inbox', url: INBOX_URL }]] });
}

/** One line per message: "Nov 15, 9:49 PM: text [file: name]". Files are named, never sent. */
export function formatConversation(messages: ConversationMessage[]): string {
  if (!messages.length) return 'No messages from the buyer found.';
  return messages
    .map((m) => {
      const parts = [m.text ? escapeHtml(truncate(m.text, 600)) : '', ...m.files.map((f) => `[file: ${escapeHtml(truncate(f, 120))}]`)].filter(Boolean);
      const when = m.time ? `<i>${escapeHtml(m.time)}</i>: ` : '';
      return `${when}${parts.join(' ') || '(no text)'}`;
    })
    .join('\n');
}

async function replyFull(s: LocalState, username: string, replyTo?: number) {
  const label = labelOf(s);
  const header = `<b>${escapeHtml(label)}</b>: last messages from <b>@${escapeHtml(username)}</b>`;
  let body: string;
  try {
    const res = await readConversation(username, 10);
    body = res.ok ? formatConversation(res.value) : missingNote('The conversation', 'is', res.missing, res.error);
  } catch (err) {
    body = `Could not read the conversation. ${escapeHtml(String((err as Error).message ?? err))}`;
  }
  const footer = '\n\n<i>Opening the conversation marked it as read on Fiverr.</i>';
  // Keep under Telegram's 4096 limit without cutting an HTML tag: drop the
  // oldest lines first.
  const lines = body.split('\n');
  while (lines.length > 1 && header.length + footer.length + lines.join('\n').length + 1 > 4000) lines.shift();
  const html = `${header}\n${lines.join('\n')}${footer}`;
  await notify(html, { replyTo, keyboard: [[{ text: 'Open conversation', url: inboxUrlFor(username) }]] });
}

async function replyStatus(s: LocalState) {
  const lines = [
    `<b>${escapeHtml(labelOf(s))}</b>: online, alerts ${s.settings.sendAlerts ? 'on' : 'paused'}, last alert ${escapeHtml(formatTime(s.lastAlertAt))}`,
  ];
  if (await isLeader(s.accountId!)) {
    const { presence } = await getSession();
    for (const a of presence.filter((a) => !a.online && a.accountId !== s.accountId)) {
      lines.push(`<b>${escapeHtml(a.label || a.accountId)}</b>: offline since ${escapeHtml(formatTime(a.lastSeen))}`);
    }
  }
  if (!isRelayOpen()) lines.push('<i>Relay connection is down.</i>');
  await notify(lines.join('\n'));
}

/** The relay says another account has updates waiting and no open socket. */
export async function handleOffline(accountId: string, label: string): Promise<void> {
  const s = await getLocal();
  if (!s.chatId || accountId === s.accountId) return;
  await notify(`<b>${escapeHtml(label || accountId)}</b> is offline. Open Chrome on that profile.`).catch(() => undefined);
}
