/**
 * Telegram updates that reach this profile through the relay: the commands
 * in BOT_COMMANDS, button presses, and the relay's "offline" notices.
 *
 * The relay sends every command to every connected profile (routed:false).
 * Each profile decides for itself whether to answer: a command with a label
 * is for the profile with that label; a command without one is for all of
 * them. Replies about the group (an unknown label, an offline account, /help)
 * come from one profile only, the leader (see isLeader), so the user gets
 * one answer.
 */
import { buyerNowLine, formatBuyerAt, formatMine, messageSentAt, type BuyerZone } from '../lib/buyerTime';
import { decodeCallback, encodeCallback, isCallbackForMe } from '../lib/callback';
import { INBOX_URL, inboxUrlFor } from '../lib/constants';
import { cutMessage, formatTime, truncate } from '../lib/format';
import { lookupZone, myZone, zoneNote, zoneOffsetText, type MyZone } from '../lib/myZone';
import type { ConversationMessage, InboxSnapshot, ListStatus } from '../lib/messages';
import { getLocal, getSession, knownLabel, labelOf, patchSettings, setLocal, type LocalState, type PresenceAccount } from '../lib/storage';
import { splitTelegramHtml } from '../lib/split';
import { escapeHtml, setMyCommands, type BotCommand, type InlineKeyboard } from '../lib/telegram';
import { saveBuyerZone, zoneFor } from './buyerZones';
import { answerCallback, notify, notifyLong, sendTo } from './notify';
import { isRelayOpen, sendForget } from './relay';
import { reloadAndCompare } from './listSync';
import { holdersOf, onReplyButton, startReply } from './replies';
import { buyerFromKeyboard, rememberReplyTarget, replyTargetOf } from './replyTargets';
import { askTabOnce, readConversation } from './watchTab';

type Json = Record<string, any>;

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Shown in Telegram's "/" menu. Set at setup and after each extension update. */
export const BOT_COMMANDS: BotCommand[] = [
  { command: 'check', description: 'Check all accounts now. /check label: one account' },
  { command: 'full', description: 'Last messages from a buyer: /full username [label]' },
  { command: 'reply', description: 'Answer a buyer: /reply username [label] text (asks before sending)' },
  { command: 'status', description: 'Label, online state, unread conversations, last alert' },
  { command: 'pause', description: 'Pause alerts. /pause label: one account' },
  { command: 'resume', description: 'Resume alerts. /resume label: one account' },
  { command: 'timezone', description: 'My time zone on all accounts: /timezone Africa/Lagos' },
  { command: 'accounts', description: 'Every profile on this bot, online or offline' },
  { command: 'remove', description: 'Remove a profile from this bot: /remove label' },
  { command: 'help', description: 'Commands and examples' },
];

/** Registers BOT_COMMANDS with Telegram. Errors are ignored: the commands work without the menu. */
export async function registerCommands(): Promise<void> {
  const { token } = await getLocal();
  if (token) await setMyCommands(token, BOT_COMMANDS).catch((e) => console.warn('[commands] setMyCommands failed', e));
}

/** "/check@MyBot arg" → "check" */
export function commandOf(text: unknown): string | null {
  return parseCommand(text)?.command ?? null;
}

/** "/full@MyBot  @Buyer_1  Main account" → { command: "full", args: "@Buyer_1  Main account" } */
export function parseCommand(text: unknown): { command: string; args: string } | null {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const m = /^\/([^\s@]*)(?:@\S*)?\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { command: m[1]!.toLowerCase(), args: m[2]!.trim() };
}

/** Labels match without case and with spaces collapsed. */
export const sameLabel = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b) && a!.replace(/\s+/g, ' ').trim().toLowerCase() === b!.replace(/\s+/g, ' ').trim().toLowerCase();

/** The placeholder label of an account that has no name yet; never matched. */
const PLACEHOLDER = 'Fiverr account';

/**
 * Who a command with `label` is for, as this profile sees it.
 * - all: no label. Every profile answers for itself.
 * - me: my label.
 * - other: another account's label (from the relay's presence list).
 * - unknown: no account has that label.
 */
export type Target = { kind: 'all' } | { kind: 'me' } | { kind: 'other'; account: PresenceAccount } | { kind: 'unknown' };

export function resolveTarget(myLabel: string | null, myId: string, presence: PresenceAccount[], label: string): Target {
  if (!label) return { kind: 'all' };
  if (sameLabel(myLabel, label)) return { kind: 'me' };
  const other = presence.find((a) => a.accountId !== myId && a.label !== PLACEHOLDER && sameLabel(a.label, label));
  return other ? { kind: 'other', account: other } : { kind: 'unknown' };
}

/** Every label that a command can use: mine and the other accounts' (from presence). */
export function validLabels(myLabel: string | null, myId: string, presence: PresenceAccount[]): string[] {
  const out: string[] = [];
  for (const l of [myLabel, ...presence.filter((a) => a.accountId !== myId).map((a) => a.label)]) {
    if (l && l !== PLACEHOLDER && !out.some((x) => sameLabel(x, l))) out.push(l);
  }
  return out;
}

export function unknownLabelText(label: string, labels: string[]): string {
  const list = labels.length ? labels.map((l) => `<code>${escapeHtml(l)}</code>`).join(', ') : 'none yet (name each account in its setup page)';
  return `No account is named <b>${escapeHtml(label)}</b>. Valid labels: ${list}. Labels match without case.`;
}

/**
 * One profile speaks for the group: the online account with the smallest
 * accountId, from the relay's presence frames.
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
  const parsed = parseCommand(message.text);
  const command = parsed?.command ?? null;

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
  if (chat.id !== s.chatId || !s.accountId) return;

  if (command === 'start') {
    if (s.linkWaitUntil && s.linkWaitUntil > Date.now()) {
      await setLocal({ linkWaitUntil: undefined });
      await notify(linkedText(s));
    }
    return;
  }
  if (command === null) {
    // A reply in Telegram to an alert or a "Full message" reply.
    if (message.reply_to_message) return replyFromTelegram(s, message, routed);
    return;
  }
  return runCommand(s, command, parsed!.args, message.message_id);
}

async function runCommand(s: LocalState, command: string, args: string, replyTo?: number) {
  const myId = s.accountId!;
  const { presence } = await getSession();
  const myLabel = knownLabel(s);

  // /full takes the buyer first, then the label. /timezone takes a zone, never a label.
  let label = command === 'timezone' ? '' : args;
  let buyer = '';
  if (command === 'full') {
    const [first = '', ...rest] = args.split(/\s+/);
    buyer = first.replace(/^@/, '');
    label = rest.join(' ');
  }
  if (command === 'reply') return replyCommand(s, args, presence, replyTo);
  // /accounts and /remove are about the group, and their argument is not a
  // "for this account" label: the leader alone answers them.
  if (command === 'accounts' || command === 'remove') {
    if (!(await isLeader(myId))) return;
    const accounts = knownAccounts(s, presence);
    if (command === 'accounts') return void (await notifyLong(accountsText(accounts, myId, myZone(s.settings)), { replyTo }));
    return removeCommand(accounts, myId, args, replyTo);
  }

  const target = resolveTarget(myLabel, myId, presence, label);

  // Group answers: from the leader only.
  if (target.kind === 'unknown' || target.kind === 'other' || command === 'help' || !KNOWN.has(command)) {
    if (!(await isLeader(myId))) return;
    if (command === 'help' || !KNOWN.has(command)) return void (await notify(helpText(validLabels(myLabel, myId, presence))));
    if (target.kind === 'unknown') return void (await notify(unknownLabelText(label, validLabels(myLabel, myId, presence)), { replyTo }));
    if (target.kind === 'other' && !target.account.online) {
      const z = myZone(s.settings);
      await notify(`<b>${escapeHtml(target.account.label)}</b> is offline (last seen ${escapeHtml(seenText(target.account.lastSeen, z))}). Open Chrome on that profile.`, { replyTo });
    }
    return;
  }

  // From here the command is for me (target "me" or "all").
  switch (command) {
    case 'check':
      return replyCheck(s, replyTo);
    case 'status':
      return replyStatus(s, target.kind === 'all');
    case 'timezone':
      return replyTimezone(s, args, replyTo);
    case 'pause':
    case 'resume': {
      const on = command === 'resume';
      await setAlertsOn(on);
      return void (await notify(pauseText(labelOf(s), on, 'command'), { replyTo }));
    }
    case 'full': {
      if (!USERNAME.test(buyer)) {
        // A bad username: one usage reply, from the leader (or from the named account).
        if (target.kind === 'me' || (await isLeader(myId))) await notify(FULL_USAGE, { replyTo });
        return;
      }
      if (hasBuyer(s, buyer)) return replyFull(s, buyer, replyTo);
      // Not in my inbox list: silent, unless the command named this account.
      if (target.kind === 'me') {
        await notify(`<b>${escapeHtml(labelOf(s))}</b>: <b>@${escapeHtml(buyer)}</b> is not in this account's inbox list.`, { replyTo });
      }
      return;
    }
  }
}

const KNOWN = new Set(['check', 'status', 'pause', 'resume', 'full', 'reply', 'timezone', 'accounts', 'remove', 'help']);
const FULL_USAGE = 'Usage: <code>/full username</code> or <code>/full username label</code>, for example <code>/full @some_buyer</code>.';

/** The buyer has a row in this account's saved inbox list. */
export function hasBuyer(s: Pick<LocalState, 'listState'>, username: string): boolean {
  return Boolean(s.listState?.rows?.[`u:${username.toLowerCase()}`]);
}

export function helpText(labels: string[]): string {
  const ex = labels[0] ?? 'Main';
  return [
    '<b>Fiverr Telegram Alerts</b>',
    '/check: check all accounts now',
    `/check ${escapeHtml(ex)}: only the account named ${escapeHtml(ex)}`,
    '/full some_buyer: the last messages from that buyer (each account that has the buyer answers)',
    `/full @some_buyer ${escapeHtml(ex)}: from that buyer on ${escapeHtml(ex)} only`,
    '/reply some_buyer Thanks, I will send it today: answer a buyer. I show a preview first, and send it only when you press Send (needs "Send replies from Telegram" on in Settings)',
    `/reply some_buyer ${escapeHtml(ex)} Thanks: from ${escapeHtml(ex)}, when more than one account has that buyer`,
    'Or reply in Telegram to an alert or a "Full message" reply, with text: the same preview, for that buyer and account. Text only, no files.',
    '/status: label, online state, unread conversations, last alert and sending from Telegram on or off, for each account',
    `/pause, /resume: stop or start alerts on all accounts; /pause ${escapeHtml(ex)}: one account`,
    '/timezone Africa/Lagos: show all times in that zone, on every account at once ("/timezone Lagos" works too)',
    '/timezone: the time zone each account uses now',
    '/accounts: every profile on this bot, online or offline, with its account id',
    '/remove label: remove that profile from this bot (or /remove account_id when two profiles have the same label)',
    '/help: this list',
    labels.length ? `Accounts: ${labels.map((l) => `<code>${escapeHtml(l)}</code>`).join(', ')}. Labels match without case.` : 'Labels match without case.',
    'Buttons under an alert work only while the relay is online.',
  ].join('\n');
}

/** Turns alerts on or off. Returns true when the setting changed. */
export async function setAlertsOn(on: boolean): Promise<boolean> {
  const { settings } = await getLocal();
  if (settings.sendAlerts === on) return false;
  await patchSettings({ sendAlerts: on });
  return true;
}

/** The reply to /pause and /resume, and the notice for the popup switch. */
export function pauseText(label: string, on: boolean, source: 'command' | 'chrome'): string {
  const name = `<b>${escapeHtml(label)}</b>`;
  if (on) return `${name}: alerts on${source === 'chrome' ? ' (turned on in Chrome)' : ''}.`;
  return `${name}: alerts paused${source === 'chrome' ? ' in Chrome' : ''}. Messages that arrive while paused are not sent later. Send /resume to turn alerts back on.`;
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
    case 'rs':
    case 'rc':
      return onReplyButton(cq as { id: string; message?: { message_id?: number } }, data!.action as 'rs' | 'rc', data!.arg);
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

/** "Check now" for this account, next to an open link. */
export function checkKeyboard(accountId: string, open: { text: string; url: string }): InlineKeyboard {
  const check = encodeCallback(accountId, 'check', '');
  return [[open, ...(check ? [{ text: 'Check now', callback_data: check }] : [])]];
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
  await notify(html, { replyTo, keyboard: checkKeyboard(s.accountId!, { text: 'Open inbox', url: INBOX_URL }) });
}

/**
 * One line per message, oldest first:
 * "<i>Nov 16, 10:53 AM (buyer 9:53 AM)</i>: text [file: name]".
 *
 * My time comes from the message id (a time-based UUID), shown in
 * `timeZone` (My time zone, never the browser's default). The buyer's time
 * is the same moment at the buyer's offset, with their day when it differs
 * from mine, and "?" when the offset
 * is over 30 days old. If the id gives no time, the page's text is shown and
 * marked as the Fiverr account's zone. Files are named, never sent.
 */
export function formatConversation(messages: ConversationMessage[], zone: BuyerZone | null, timeZone: string, now = Date.now()): string {
  return conversationEntries(messages, zone, timeZone, now).join('\n');
}

/** formatConversation, one entry per buyer message (an entry keeps the message's own line breaks). */
export function conversationEntries(messages: ConversationMessage[], zone: BuyerZone | null, timeZone: string, now = Date.now()): string[] {
  if (!messages.length) return ['No messages from the buyer found.'];
  return messages
    .map((m) => {
      const parts = [m.text ? escapeHtml(cutMessage(m.text, FULL_TEXT_CHARS)) : '', ...m.files.map((f) => `[file: ${escapeHtml(truncate(f, 120))}]`)].filter(Boolean);
      const sentAt = messageSentAt(m.id);
      let when = '';
      if (sentAt !== null) when = formatMine(sentAt, timeZone) + (zone ? ` (buyer ${formatBuyerAt(sentAt, zone, now, timeZone)})` : '');
      else if (m.time) when = `${m.time} (Fiverr account time)`;
      return `${when ? `<i>${escapeHtml(when)}</i>: ` : ''}${parts.join(' ') || '(no text)'}`;
    });
}

/**
 * "Times: Africa/Lagos. Buyer local time now: 6:07 PM (UTC+0, United Kingdom)".
 * Without the setting: "Times: America/Bogota (browser zone, not set: send /timezone Your/Zone)."
 */
export function timesLine(mine: MyZone, zone: BuyerZone | null, now: number): string {
  const times = mine.set ? `Times: ${mine.zone}.` : `Times: ${mine.zone} (browser zone, not set: send /timezone Your/Zone).`;
  return zone ? `${times} ${buyerNowLine(zone, now, mine.zone)}` : times;
}

/** One buyer message in "Full message" is shown up to this length, then cut with CUT_NOTE. */
export const FULL_TEXT_CHARS = 8000;
/** "Full message" sends at most this many Telegram messages; the oldest buyer messages go first. */
export const MAX_FULL_PARTS = 5;

/**
 * The whole "Full message" reply as one or more Telegram messages, each
 * under the 4,096 limit (see splitTelegramHtml). Over MAX_FULL_PARTS, the
 * oldest buyer messages are left out, and a line says how many.
 */
export function fullReplyParts(label: string, username: string, body: string | string[], zone: BuyerZone | null, mine: MyZone, now = Date.now()): string[] {
  const top = [`<b>${escapeHtml(label)}</b>: last messages from <b>@${escapeHtml(username)}</b>`, escapeHtml(timesLine(mine, zone, now))];
  const footer = ['', '<i>Opening the conversation marked it as read on Fiverr.</i>'];
  // Whole buyer messages are dropped, never part of one.
  const lines = typeof body === 'string' ? [body] : [...body];
  let dropped = 0;
  for (;;) {
    const note = dropped ? [`<i>${dropped} older ${dropped === 1 ? 'message' : 'messages'} left out. Open Fiverr for the rest.</i>`] : [];
    const parts = splitTelegramHtml([...top, ...note, ...lines, ...footer].join('\n'));
    if (parts.length <= MAX_FULL_PARTS || lines.length <= 1) return parts;
    lines.shift();
    dropped++;
  }
}

async function replyFull(s: LocalState, username: string, replyTo?: number) {
  let body: string | string[];
  let zone: BuyerZone | null = null;
  const mine = myZone(s.settings);
  try {
    const res = await readConversation(username, 10);
    if (res.ok) {
      // The header was just read: save the buyer's offset, then use the saved
      // entry (it keeps a country seen earlier).
      await saveBuyerZone(res.value.header);
      zone = zoneFor(await getLocal(), username);
      body = conversationEntries(res.value.messages, zone, mine.zone);
    } else {
      body = missingNote('The conversation', 'is', res.missing, res.error);
    }
  } catch (err) {
    body = `Could not read the conversation. ${escapeHtml(String((err as Error).message ?? err))}`;
  }
  const parts = fullReplyParts(labelOf(s), username, body, zone, mine);
  const keyboard = checkKeyboard(s.accountId!, { text: 'Open conversation', url: inboxUrlFor(username) });
  // Several parts: the first replies to the command, the buttons go on the last.
  // Claimed, and each part remembered as this buyer's: a reply to any part goes to them.
  for (const [i, part] of parts.entries()) {
    const sent = await notify(part, { replyTo: i === 0 ? replyTo : undefined, keyboard: i === parts.length - 1 ? keyboard : undefined, claim: true });
    if (sent) await rememberReplyTarget(sent.message_id, username).catch(() => undefined);
  }
}

/** The Unread chip count now (asks the watch tab), or the one from the last reload. */
async function unreadNow(s: LocalState): Promise<{ n: number | null; live: boolean }> {
  const { watchTabId } = await getSession();
  if (watchTabId != null) {
    const status = await askTabOnce<ListStatus>(watchTabId, { type: 'listStatus' }, 2000);
    if (typeof status?.unread === 'number') return { n: status.unread, live: true };
  }
  return { n: s.lastUnread ?? null, live: false };
}

/** "6:52 PM (Africa/Lagos)", "never". The zone is named, so each line says which zone it is in. */
export function seenText(ts: number | undefined, mine: MyZone, now = Date.now()): string {
  return ts ? `${formatTime(ts, now, mine.zone)} (${zoneNote(mine)})` : 'never';
}

/**
 * "<b>Main</b>: online, alerts on, 2 unread conversations, last alert 6:52 PM (Africa/Lagos)".
 * The number is Fiverr's "Unread" chip, which counts conversations, not messages.
 */
export function statusLine(label: string, alertsOn: boolean, unread: { n: number | null; live: boolean }, lastAlertAt: number | undefined, mine: MyZone, now = Date.now(), sendingOn?: boolean): string {
  const u =
    unread.n === null
      ? 'unread count unknown'
      : `${unread.n} unread ${unread.n === 1 ? 'conversation' : 'conversations'}${unread.live ? '' : ' (at the last reload)'}`;
  const sending = sendingOn === undefined ? '' : `, sending from Telegram ${sendingOn ? 'on' : 'off'}`;
  return `<b>${escapeHtml(label)}</b>: online, alerts ${alertsOn ? 'on' : 'paused'}, ${u}, last alert ${escapeHtml(seenText(lastAlertAt, mine, now))}${sending}`;
}

async function replyStatus(s: LocalState, includeOthers: boolean) {
  const mine = myZone(s.settings);
  const lines = [statusLine(labelOf(s), s.settings.sendAlerts, await unreadNow(s), s.lastAlertAt, mine, Date.now(), s.settings.sendReplies)];
  // Offline accounts cannot answer: the leader lists them.
  if (includeOthers && (await isLeader(s.accountId!))) {
    const { presence } = await getSession();
    for (const a of presence.filter((a) => !a.online && a.accountId !== s.accountId)) {
      lines.push(`<b>${escapeHtml(a.label || a.accountId)}</b>: offline since ${escapeHtml(seenText(a.lastSeen, mine))}, sending from Telegram unknown (offline)`);
    }
  }
  if (!isRelayOpen()) lines.push('<i>Relay connection is down.</i>');
  await notify(lines.join('\n'));
}

/** "<b>Main</b>: Africa/Lagos (now 6:52 PM, UTC+1)" or the not-set form, for /timezone. */
export function zoneStatusText(label: string, mine: MyZone, now = Date.now()): string {
  const clock = `now ${formatTime(now, now, mine.zone)}, ${zoneOffsetText(now, mine.zone)}`;
  return mine.set
    ? `<b>${escapeHtml(label)}</b>: ${escapeHtml(mine.zone)} (${escapeHtml(clock)})`
    : `<b>${escapeHtml(label)}</b>: not set. Using the browser zone ${escapeHtml(mine.zone)} (${escapeHtml(clock)}), which an anti-detect profile may fake. Send <code>/timezone Africa/Lagos</code> with your zone.`;
}

export function zoneUnknownText(input: string, matches: string[]): string {
  if (matches.length) {
    return `<b>${escapeHtml(input)}</b> matches several zones: ${matches.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')}. Send the full name, for example <code>/timezone ${escapeHtml(matches[0]!)}</code>.`;
  }
  return `<b>${escapeHtml(input)}</b> is not a time zone. Use an IANA name such as <code>/timezone Africa/Lagos</code> or <code>/timezone Europe/London</code>.`;
}

/**
 * "/timezone": every online profile reports its zone. "/timezone Africa/Lagos":
 * every online profile saves it and confirms. Each profile resolves the name
 * itself; a name it cannot use gets one error reply, from the leader. The
 * leader also names offline profiles, which miss the change.
 */
async function replyTimezone(s: LocalState, input: string, replyTo?: number) {
  const label = labelOf(s);
  const leader = await isLeader(s.accountId!);
  const lines: string[] = [];
  if (!input) {
    lines.push(zoneStatusText(label, myZone(s.settings)));
  } else {
    const found = lookupZone(input);
    if (!found.ok) {
      if (leader) await notify(zoneUnknownText(input, found.matches), { replyTo });
      return;
    }
    await patchSettings({ myTimeZone: found.zone });
    lines.push(`<b>${escapeHtml(label)}</b>: times now shown in ${escapeHtml(found.zone)} (now ${escapeHtml(formatTime(Date.now(), Date.now(), found.zone))}, ${escapeHtml(zoneOffsetText(Date.now(), found.zone))}).`);
  }
  if (leader) {
    const { presence } = await getSession();
    for (const a of presence.filter((a) => !a.online && a.accountId !== s.accountId)) {
      lines.push(`<b>${escapeHtml(a.label || a.accountId)}</b>: offline, ${input ? 'did not get the change. Send /timezone again when it is online.' : 'cannot answer.'}`);
    }
  }
  await notify(lines.join('\n'), { replyTo });
}

/** The relay says another account has updates waiting and no open socket. */
export async function handleOffline(accountId: string, label: string): Promise<void> {
  const s = await getLocal();
  if (!s.chatId || accountId === s.accountId) return;
  await notify(`<b>${escapeHtml(label || accountId)}</b> is offline. Open Chrome on that profile.`).catch(() => undefined);
}

/** Every account the relay knows (presence lists offline ones too), with this profile always in it. */
export function knownAccounts(s: LocalState, presence: PresenceAccount[]): PresenceAccount[] {
  const me: PresenceAccount = { accountId: s.accountId!, label: labelOf(s), online: true, lastSeen: Date.now() };
  // My label from this profile's storage: the relay's copy may be older.
  const others = presence.filter((a) => a.accountId !== me.accountId);
  return [me, ...others].sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/** /accounts: one line per profile, with its accountId for /remove. */
export function accountsText(accounts: PresenceAccount[], myId: string, mine: MyZone, now = Date.now()): string {
  const lines = [`<b>Accounts on this bot</b> (${accounts.length})`];
  for (const a of accounts) {
    const state = a.online ? 'online' : `offline, last seen ${escapeHtml(seenText(a.lastSeen, mine, now))}`;
    const leader = a.accountId === myId ? ', answers commands' : '';
    lines.push(`• <b>${escapeHtml(a.label || a.accountId)}</b>: ${state} (<code>${escapeHtml(a.accountId)}</code>${leader})`);
  }
  lines.push('Remove one with <code>/remove label</code>, or <code>/remove account_id</code> when two have the same label.');
  return lines.join('\n');
}

export type Removal =
  | { kind: 'usage' }
  | { kind: 'unknown' }
  | { kind: 'duplicate'; matches: PresenceAccount[] }
  | { kind: 'self'; account: PresenceAccount }
  | { kind: 'ok'; account: PresenceAccount };

/** Which account "/remove {arg}" means. An exact accountId wins over a label. */
export function resolveRemoval(accounts: PresenceAccount[], myId: string, arg: string): Removal {
  const wanted = arg.trim();
  if (!wanted) return { kind: 'usage' };
  const byId = accounts.find((a) => a.accountId.toLowerCase() === wanted.toLowerCase());
  const matches = byId ? [byId] : accounts.filter((a) => sameLabel(a.label, wanted));
  if (matches.length === 0) return { kind: 'unknown' };
  if (matches.length > 1) return { kind: 'duplicate', matches };
  const account = matches[0]!;
  return account.accountId === myId ? { kind: 'self', account } : { kind: 'ok', account };
}

/** Labels /remove accepts: every account but the leader. */
function removableLabels(accounts: PresenceAccount[], myId: string): string {
  const list = accounts.filter((a) => a.accountId !== myId).map((a) => `<code>${escapeHtml(a.label || a.accountId)}</code>`);
  return list.length ? list.join(', ') : 'none (no other profile is on this bot)';
}

export function removeReplyText(r: Removal, arg: string, accounts: PresenceAccount[], myId: string): string | null {
  switch (r.kind) {
    case 'usage':
      return `Usage: <code>/remove label</code>. Profiles you can remove: ${removableLabels(accounts, myId)}.`;
    case 'unknown':
      return `No account is named <b>${escapeHtml(arg)}</b>. Profiles you can remove: ${removableLabels(accounts, myId)}. Labels match without case.`;
    case 'duplicate':
      return `${r.matches.length} profiles are named <b>${escapeHtml(arg)}</b>: ${r.matches.map((a) => `<code>${escapeHtml(a.accountId)}</code>`).join(', ')}. Send /accounts to see which is which, then <code>/remove ${escapeHtml(r.matches[0]!.accountId)}</code> with the right account id.`;
    case 'self':
      return `<b>${escapeHtml(r.account.label || r.account.accountId)}</b> is the profile that answers commands, so it cannot remove itself from Telegram. On that profile, open the extension Settings and press <b>Disconnect this profile</b>.`;
    case 'ok':
      return null;
  }
}

/**
 * /remove: the leader asks the relay to forget the account. The relay then
 * closes that profile (it clears itself) and sends "account_removed" to one
 * online profile, whose notice is the confirmation in Telegram. An offline
 * profile is refused by the relay when it next connects, and clears itself then.
 */
async function removeCommand(accounts: PresenceAccount[], myId: string, arg: string, replyTo?: number) {
  const r = resolveRemoval(accounts, myId, arg);
  const reply = removeReplyText(r, arg, accounts, myId);
  if (reply) return void (await notify(reply, { replyTo }));
  const account = (r as { account: PresenceAccount }).account;
  if (!sendForget(account.accountId)) {
    await notify(`The relay connection is down, so <b>${escapeHtml(account.label || account.accountId)}</b> was not removed. Try again in a minute.`, { replyTo });
  }
}

export function accountRemovedText(label: string): string {
  return `<b>${escapeHtml(label)}</b> was removed from this bot.`;
}

/** The relay removed another account (/remove, or that profile's uninstall URL): tell the user once. */
export async function handleAccountRemoved(accountId: string, label: string): Promise<void> {
  const s = await getLocal();
  if (!s.chatId || !s.token || !accountId || accountId === s.accountId) return;
  await notify(accountRemovedText(label || accountId)).catch(() => undefined);
}

// ---------------------------------------------------------------- replies

/** Telegram message kinds that are not text. Files are never sent to Fiverr. */
const FILE_FIELDS = ['photo', 'document', 'sticker', 'voice', 'video', 'video_note', 'audio', 'animation', 'contact', 'location', 'venue', 'poll', 'dice', 'story', 'paid_media'];
export const hasFile = (message: Json) => FILE_FIELDS.some((f) => message[f] !== undefined);

/**
 * A reply in Telegram to one of this bot's messages. The buyer is the one
 * that message is about (recorded when it was sent, or read from its
 * buttons). A reply the relay sent to every profile (routed:false) is
 * handled only by the profile that the message belongs to.
 */
async function replyFromTelegram(s: LocalState, message: Json, routed: boolean) {
  const replied: Json = message.reply_to_message;
  if (replied.from && replied.from.is_bot !== true) return;
  if (s.bot?.id && replied.from?.id !== undefined && replied.from.id !== s.bot.id) return;
  const buyer = (await replyTargetOf(replied.message_id)) ?? buyerFromKeyboard(replied.reply_markup, s.accountId!);
  if (!buyer) {
    if (routed) {
      await notify('I cannot tell which buyer this reply is for. Reply to an alert or to a "Full message" reply, or send <code>/reply username text</code>.', {
        replyTo: message.message_id,
      });
    }
    return;
  }
  await startReply({
    buyer,
    text: typeof message.text === 'string' ? message.text : undefined,
    hasFile: hasFile(message),
    sourceKey: `${message.chat?.id}:${message.message_id}`,
    replyTo: message.message_id,
  });
}

export const REPLY_USAGE =
  'Usage: <code>/reply username text</code>, or <code>/reply username label text</code> when more than one account has that buyer. For example <code>/reply some_buyer Thanks, I will send it today.</code>';

/**
 * Splits "/reply" arguments: "buyer [label] text". The label is taken only
 * when the text starts with a known account label followed by a space or
 * line break (longest label first); the preview shows which account and text
 * were understood before anything is sent.
 */
export function parseReplyArgs(args: string, labels: string[]): { buyer: string; label: string; text: string } | null {
  const m = /^@?([A-Za-z0-9_.-]{1,64})(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!m) return null;
  const rest = (m[2] ?? '').trim();
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  for (const l of sorted) {
    const head = rest.slice(0, l.length);
    if (sameLabel(head, l) && /^\s/.test(rest.slice(l.length))) return { buyer: m[1]!, label: l, text: rest.slice(l.length).trim() };
  }
  return { buyer: m[1]!, label: '', text: rest };
}

async function replyCommand(s: LocalState, args: string, presence: PresenceAccount[], replyTo?: number) {
  const myId = s.accountId!;
  const myLabel = knownLabel(s);
  const parsed = parseReplyArgs(args, validLabels(myLabel, myId, presence));
  const sourceKey = `${s.chatId}:${replyTo}`;
  if (!parsed || !parsed.text) {
    if (await isLeader(myId)) await notify(REPLY_USAGE, { replyTo });
    return;
  }
  const { buyer, label, text } = parsed;
  const request = { buyer, text, hasFile: false, sourceKey, replyTo };

  if (label) {
    const target = resolveTarget(myLabel, myId, presence, label);
    if (target.kind === 'me') return startReply(request);
    if (target.kind === 'other' && !target.account.online && (await isLeader(myId))) {
      await notify(`<b>${escapeHtml(target.account.label)}</b> is offline (last seen ${escapeHtml(seenText(target.account.lastSeen, myZone(s.settings)))}). Nothing was sent. Open Chrome on that profile.`, { replyTo });
    }
    return;
  }

  // No label: the account that has this buyer. Every online profile tells
  // the others whether it has the buyer, so all of them see the same answer.
  const others = presence.filter((a) => a.online && a.accountId !== myId).map((a) => a.accountId);
  const holders = typeof replyTo === 'number' ? await holdersOf(replyTo, hasBuyer(s, buyer), myId, others) : hasBuyer(s, buyer) ? [myId] : [];
  if (holders.length === 1) {
    if (holders[0] === myId) return startReply(request);
    return;
  }
  if (holders.length > 1) {
    if (holders[0] !== myId) return; // the first holder answers for all
    const accounts = knownAccounts(s, presence);
    const names = holders.map((id) => accounts.find((a) => a.accountId === id)?.label || id);
    await notify(
      `<b>@${escapeHtml(buyer)}</b> is in ${holders.length} accounts: ${names.map((n) => `<b>${escapeHtml(n)}</b>`).join(', ')}. Nothing was sent. Name the account: <code>/reply ${escapeHtml(buyer)} ${escapeHtml(names[0]!)} your text</code>.`,
      { replyTo },
    );
    return;
  }
  if (await isLeader(myId)) {
    await notify(`<b>@${escapeHtml(buyer)}</b> is not in the inbox list of any online account. Nothing was sent. If the buyer is further down the list, name the account: <code>/reply ${escapeHtml(buyer)} label your text</code>.`, { replyTo });
  }
}
