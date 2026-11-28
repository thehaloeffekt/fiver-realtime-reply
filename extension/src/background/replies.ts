/**
 * "Send replies from Telegram": the Telegram side and the state of each reply.
 *
 * Flow: a reply to an alert (or /reply) → a preview "Send this to @buyer
 * from Account?" with the full text and two buttons → "Send" → the watch
 * tab types and sends it (replyDriver.ts → content/composer.ts) → the same
 * Telegram message is edited to "Sending…", then "Sent …", "Not sent: …" or
 * "Unknown. …". Nothing is ever sent without the "Send" press, because a
 * wrong buyer or a typing error on Fiverr cannot be undone.
 *
 * At most one send per confirmed reply. Each reply is kept in storage with
 * its state: preview → sending → sent | failed | unknown, or preview →
 * cancelled | expired. The "Send" press moves preview → sending inside one
 * serialized storage update, and that write has finished before the first
 * keystroke. So:
 *  - the same "Send" update delivered twice (relay replay after a
 *    reconnect) finds "sending" or a final state and does nothing;
 *  - a worker that restarts in the middle of a send finds "sending" at
 *    start-up and turns it into "unknown", never back into "preview", so it
 *    can never be sent again;
 *  - a crash before that write leaves "preview", and nothing was typed.
 * Only one reply per profile may be "sending" (a second press gets "Busy").
 */
import { formatBuyerAt, formatMine } from '../lib/buyerTime';
import { encodeCallback } from '../lib/callback';
import { replyProbe } from '../lib/diagnostics';
import { myZone } from '../lib/myZone';
import { getLocal, labelOf, setLocal, type LocalState, type PendingReply } from '../lib/storage';
import { escapeHtml, type InlineKeyboard } from '../lib/telegram';
import { browser } from 'wxt/browser';
import { expectOwnMessage } from './alerts';
import { zoneFor } from './buyerZones';
import { answerCallback, editNotice, notify } from './notify';
import { sendPeer } from './relay';
import { driveReply, type SendOutcome } from './replyDriver';
import { askTab, askTabOnce, withConversation } from './watchTab';

/** "Send" works this long after the preview was made. */
export const PREVIEW_TTL_MS = 5 * 60_000;
/**
 * Finished replies stay this long, without their text, then are deleted.
 * Long enough to answer a late or replayed button press with the real
 * state: the relay keeps an update at most 5 minutes, so a duplicate can
 * only come within that time. Short, because there is no reason to keep more.
 */
export const KEEP_FINISHED_MS = 10 * 60_000;
/**
 * Longest reply accepted, in UTF-16 units (what a textarea's maxlength
 * counts). Not a confirmed Fiverr limit: the captured message box has no
 * maxlength attribute and Fiverr documents none. A conservative cap; the
 * driver also refuses text over the box's own maxlength, if it has one, and
 * checks after each step that the box took the text.
 */
export const MAX_REPLY_CHARS = 2500;
export const REPLY_ALARM = 'reply-expire';

const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;

// ------------------------------------------------------------------ texts

export const offText = (label: string) => `Sending is off for <b>${escapeHtml(label)}</b>. Turn on 'Send replies from Telegram' in Settings.`;
export const FILES_TEXT = 'Files cannot be sent. Only text can go to a Fiverr buyer from Telegram, so nothing was sent.';
export const EMPTY_TEXT = 'There is no text to send.';
export const tooLongText = (n: number) =>
  `Not sent: the text has ${n.toLocaleString('en-US')} characters, and a reply from Telegram can have at most ${MAX_REPLY_CHARS.toLocaleString('en-US')}. Shorten it and send it again.`;
export const BUSY_TEXT = 'Busy. Try again in a moment.';
export const EXPIRED_LINE = 'Expired. Nothing was sent.';
export const CANCELLED_LINE = 'Cancelled. Nothing was sent.';
export const UNKNOWN_LINE = 'Unknown. Check Fiverr before you send again.';
const READ_NOTE = 'Opening the conversation marked it as read on Fiverr.';

const quote = (text: string) => `<blockquote>${escapeHtml(text)}</blockquote>`;

export function previewHtml(buyer: string, label: string, text: string): string {
  return `Send this to <b>@${escapeHtml(buyer)}</b> from <b>${escapeHtml(label)}</b>?\n\n${quote(text)}`;
}

export function previewKeyboard(accountId: string, id: string): InlineKeyboard {
  return [[
    { text: 'Send', callback_data: encodeCallback(accountId, 'rs', id)! },
    { text: 'Cancel', callback_data: encodeCallback(accountId, 'rc', id)! },
  ]];
}

/** The edited preview: the state line, then the text it is about (when still known). */
const stateHtml = (line: string, text?: string) => (text ? `${line}\n\n${quote(text)}` : line);

export function sentLine(buyer: string, at: number, s: LocalState): string {
  const mine = myZone(s.settings);
  const zone = zoneFor(s, buyer);
  const buyerTime = zone ? `buyer ${formatBuyerAt(at, zone, at, mine.zone)}` : 'buyer time unknown';
  return `Sent to <b>@${escapeHtml(buyer)}</b> at ${escapeHtml(formatMine(at, mine.zone))} (${escapeHtml(buyerTime)}). ${READ_NOTE}`;
}

export function outcomeLine(o: SendOutcome, buyer: string, s: LocalState): string {
  if (o.state === 'sent') return sentLine(buyer, o.at, s);
  if (o.state === 'failed') return `Not sent: ${escapeHtml(o.reason)} ${READ_NOTE}`;
  return `${UNKNOWN_LINE} (${escapeHtml(o.reason)}) ${READ_NOTE}`;
}

/** Answer to a press on a reply that is no longer a preview. */
function stateAnswer(r: PendingReply): string {
  switch (r.state) {
    case 'sending':
      return 'Already sending.';
    case 'sent':
      return 'Already sent.';
    case 'failed':
      return 'Not sent. Send the reply again if you still want it.';
    case 'unknown':
      return UNKNOWN_LINE;
    case 'cancelled':
      return CANCELLED_LINE;
    case 'expired':
      return EXPIRED_LINE;
    default:
      return 'Nothing to do.';
  }
}

// ------------------------------------------------------------------ state

let chain: Promise<unknown> = Promise.resolve();

/**
 * Every change to `replies` goes through here, one at a time, so a check and
 * the change it allows are one step (two "Send" presses cannot both pass).
 * The returned promise resolves after the write to storage.
 */
function mutate<T>(fn: (replies: Record<string, PendingReply>, s: LocalState, now: number) => T): Promise<T> {
  const run = chain.then(async () => {
    const s = await getLocal();
    const replies = { ...(s.replies ?? {}) };
    const out = fn(replies, s, Date.now());
    await setLocal({ replies });
    return out;
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Marks a reply finished: keeps a copy with the text for the edit, drops the text from storage. */
function finish(r: PendingReply, state: PendingReply['state'], now: number, result: string): PendingReply {
  r.state = state;
  r.finishedAt = now;
  r.result = result;
  const copy = { ...r };
  delete r.text;
  return copy;
}

const isOpen = (r: PendingReply) => r.state === 'preview' || r.state === 'sending';

/** The reply this worker is sending now (in memory: gone when the worker stops). */
let activeSendId: string | null = null;
/** Set when the profile is being removed: the driver stops before its next step. */
let aborting = false;
/** Start-up recovery runs once per worker. */
let recovered = false;

/** Reply texts sent or being sent lately, to keep them out of the diagnostics log. */
const recentProbes: Array<{ probe: string; until: number }> = [];
export function replyProbes(now = Date.now()): string[] {
  while (recentProbes.length && recentProbes[0]!.until < now) recentProbes.shift();
  return recentProbes.map((p) => p.probe);
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- preview

export interface ReplyRequest {
  buyer: string;
  /** The message text; undefined when the Telegram message has no text. */
  text?: string;
  /** The message has a photo, file, sticker, voice note, … */
  hasFile: boolean;
  /** "{chat id}:{message id}" of the asking message. */
  sourceKey: string;
  replyTo?: number;
}

/**
 * Answers a reply request for this profile: a refusal, or the preview. Never
 * sends anything to Fiverr.
 */
export async function startReply(req: ReplyRequest): Promise<void> {
  const s = await getLocal();
  if (!s.accountId) return;
  const label = labelOf(s);
  const opts = { replyTo: req.replyTo };
  if (!s.settings.sendReplies) return void (await notify(offText(label), opts));
  if (req.hasFile) return void (await notify(FILES_TEXT, opts));
  const text = (req.text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return void (await notify(EMPTY_TEXT, opts));
  if (text.length > MAX_REPLY_CHARS) return void (await notify(tooLongText(text.length), opts));
  if (!USERNAME.test(req.buyer)) return void (await notify('Not sent: that is not a Fiverr username.', opts));

  const id = newId();
  const created = await mutate((replies, _s, now) => {
    // The same Telegram message again (a replayed update): one preview only.
    if (Object.values(replies).some((r) => r.sourceKey === req.sourceKey)) return false;
    replies[id] = { id, state: 'preview', buyer: req.buyer, label, text, sourceKey: req.sourceKey, createdAt: now, expiresAt: now + PREVIEW_TTL_MS };
    return true;
  });
  if (!created) return;
  try {
    const sent = await notify(previewHtml(req.buyer, label, text), { ...opts, keyboard: previewKeyboard(s.accountId, id), claim: true, retries: 2 });
    await mutate((replies) => {
      if (replies[id]) replies[id].previewId = sent.message_id;
    });
  } catch (e) {
    // No preview in Telegram: nobody can press "Send". Forget it.
    await mutate((replies) => void delete replies[id]);
    throw e;
  }
  await scheduleReplyAlarm();
}

// ---------------------------------------------------------------- buttons

/** "Send" (rs) or "Cancel" (rc) under a preview. */
export async function onReplyButton(cq: { id: string; message?: { message_id?: number } }, action: 'rs' | 'rc', id: string): Promise<void> {
  const messageId = cq.message?.message_id;
  if (action === 'rc') {
    const res = await mutate((replies, _s, now) => {
      const r = replies[id];
      if (!r) return { kind: 'gone' as const };
      if (r.state !== 'preview') return { kind: 'state' as const, r: { ...r } };
      if (now >= r.expiresAt) return { kind: 'final' as const, r: finish(r, 'expired', now, EXPIRED_LINE) };
      return { kind: 'final' as const, r: finish(r, 'cancelled', now, CANCELLED_LINE) };
    });
    return afterPress(cq.id, messageId, res);
  }

  const res = await mutate((replies, s, now) => {
    const r = replies[id];
    if (!r) return { kind: 'gone' as const };
    if (r.state !== 'preview') return { kind: 'state' as const, r: { ...r } };
    if (now >= r.expiresAt) return { kind: 'final' as const, r: finish(r, 'expired', now, EXPIRED_LINE) };
    if (!s.settings.sendReplies) return { kind: 'off' as const, label: labelOf(s) };
    if (aborting || activeSendId || Object.values(replies).some((o) => o.state === 'sending')) return { kind: 'busy' as const };
    // The one transition that allows typing. It is in storage before the first keystroke.
    r.state = 'sending';
    r.startedAt = now;
    return { kind: 'go' as const, r: { ...r } };
  });
  if (res.kind !== 'go') return afterPress(cq.id, messageId, res);

  const r = res.r;
  activeSendId = r.id;
  recentProbes.push({ probe: replyProbe(r.text ?? ''), until: Date.now() + 30 * 60_000 });
  try {
    await answerCallback(cq.id, 'Sending…');
    const previewId = messageId ?? r.previewId;
    if (previewId) await editNotice(previewId, stateHtml('Sending…', r.text));
    const outcome = await deliver(r);
    const done = await mutate((replies, s, now) => {
      const cur = replies[r.id];
      // Gone (profile removed) or no longer "sending": that path already told the user.
      if (!cur || cur.state !== 'sending') return null;
      return { r: finish(cur, outcome.state, now, outcomeLine(outcome, r.buyer, s)) };
    });
    if (done && previewId) await editNotice(previewId, stateHtml(done.r.result!, done.r.text));
  } finally {
    activeSendId = null;
    // A removal during this send is now over: the next send may run.
    aborting = false;
    await scheduleReplyAlarm();
  }
}

type PressResult =
  | { kind: 'gone' }
  | { kind: 'busy' }
  | { kind: 'off'; label: string }
  | { kind: 'state'; r: PendingReply }
  | { kind: 'final'; r: PendingReply };

async function afterPress(callbackId: string, messageId: number | undefined, res: PressResult) {
  switch (res.kind) {
    case 'gone':
      return answerCallback(callbackId, 'This reply is no longer available. Nothing was sent.');
    case 'busy':
      return answerCallback(callbackId, BUSY_TEXT);
    case 'off':
      await answerCallback(callbackId, 'Sending is off.');
      await notify(offText(res.label), { replyTo: messageId }).catch(() => undefined);
      return;
    case 'state':
      return answerCallback(callbackId, stateAnswer(res.r));
    case 'final': {
      await answerCallback(callbackId, res.r.result!);
      const id = messageId ?? res.r.previewId;
      if (id) await editNotice(id, stateHtml(res.r.result!, res.r.text));
      await scheduleReplyAlarm();
    }
  }
}

/** Sends one reply on the watch tab. Never throws. */
async function deliver(r: PendingReply): Promise<SendOutcome> {
  const { detectedUsername } = await getLocal();
  const text = r.text ?? '';
  try {
    return await withConversation(r.buyer, (tabId) =>
      driveReply(
        {
          prepare: (msg) => askTab(tabId, msg),
          ask: (msg, timeoutMs) => askTabOnce(tabId, msg, timeoutMs),
        },
        r.buyer,
        text,
        detectedUsername,
        { aborted: () => aborting, beforeClick: () => expectOwnMessage(r.buyer, text) },
      ),
    );
  } catch (e) {
    // withConversation failed before the driver ran (no window, page did not load).
    return { state: 'failed', reason: String((e as Error).message ?? e) };
  }
}

// ------------------------------------------------------- expiry, restart

/** The next time a preview expires or a finished reply is deleted. */
export function nextReplyWake(replies: Record<string, PendingReply>): number | null {
  let next = Infinity;
  for (const r of Object.values(replies)) {
    if (r.state === 'preview') next = Math.min(next, r.expiresAt);
    else if (r.finishedAt) next = Math.min(next, r.finishedAt + KEEP_FINISHED_MS);
  }
  return next === Infinity ? null : next;
}

export async function scheduleReplyAlarm(): Promise<void> {
  const next = nextReplyWake((await getLocal()).replies ?? {});
  if (next === null) await browser.alarms.clear(REPLY_ALARM).catch(() => undefined);
  else await browser.alarms.create(REPLY_ALARM, { when: Math.max(next, Date.now() + 1000) });
}

/**
 * Expires previews whose 5 minutes are up (and edits them to "Expired"),
 * deletes finished replies after KEEP_FINISHED_MS. Runs from the alarm and
 * at start-up. With `restart`, a reply still "sending" from a worker that
 * stopped becomes "unknown": it may or may not have been sent, and it is
 * never sent again.
 */
export async function sweepReplies(restart = false): Promise<void> {
  const edits = await mutate((replies, _s, now) => {
    const out: PendingReply[] = [];
    for (const r of Object.values(replies)) {
      if (restart && r.state === 'sending' && r.id !== activeSendId) out.push(finish(r, 'unknown', now, `${UNKNOWN_LINE} (The extension restarted during the send.)`));
      else if (r.state === 'preview' && now >= r.expiresAt) out.push(finish(r, 'expired', now, EXPIRED_LINE));
      else if (!isOpen(r) && r.finishedAt && now - r.finishedAt >= KEEP_FINISHED_MS) delete replies[r.id];
    }
    return out;
  });
  for (const r of edits) if (r.previewId) await editNotice(r.previewId, stateHtml(r.result!, r.text));
  await scheduleReplyAlarm();
}

/** At every worker start, before the relay connects (so no press is handled first). */
export async function recoverReplies(): Promise<void> {
  if (recovered) return;
  recovered = true;
  await sweepReplies(true);
}

/**
 * The profile is being removed or disconnected: stop a send in progress,
 * tell Telegram about open previews, and drop every pending reply.
 */
export async function dropAllReplies(): Promise<void> {
  aborting = true;
  try {
    const open = await mutate((replies) => {
      const list = Object.values(replies).filter(isOpen).map((r) => ({ ...r }));
      for (const k of Object.keys(replies)) delete replies[k];
      return list;
    });
    for (const r of open) {
      if (!r.previewId) continue;
      const line = r.state === 'sending' ? `${UNKNOWN_LINE} (This profile was disconnected during the send.)` : 'Cancelled. Nothing was sent. This profile was disconnected.';
      await Promise.race([editNotice(r.previewId, stateHtml(line, r.text)), new Promise((res) => setTimeout(res, 3000))]);
    }
    await browser.alarms.clear(REPLY_ALARM).catch(() => undefined);
  } finally {
    // A send still running keeps the flag until it stops (see onReplyButton),
    // so it cannot type or click after the profile was dropped.
    if (!activeSendId) aborting = false;
  }
}

// ------------------------------------------------- /reply: who has the buyer

/** Answers from other profiles: /reply message id → accountId → has the buyer. */
const peerAnswers = new Map<number, { at: number; has: Map<string, boolean> }>();

/** A relay "peer" frame from another profile. */
export function onPeer(from: string, body: Record<string, unknown>): void {
  if (body.k !== 'reply-has' || typeof body.m !== 'number' || typeof body.has !== 'boolean') return;
  const now = Date.now();
  for (const [k, v] of peerAnswers) if (now - v.at > 60_000) peerAnswers.delete(k);
  const entry = peerAnswers.get(body.m) ?? { at: now, has: new Map() };
  entry.has.set(from, body.has);
  peerAnswers.set(body.m, entry);
}

/**
 * "/reply buyer text" names no account: every online profile says whether
 * its inbox list has the buyer (a peer frame with only the command's message
 * id and yes/no, no username), then each one sees the same set of holders.
 * Waits until every online profile answered, at most `waitMs`. A profile
 * whose answer is late is left out (then two previews can appear, each
 * naming its account; nothing is sent without "Send").
 */
export async function holdersOf(commandId: number, iHave: boolean, myId: string, others: string[], waitMs = 2500, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string[]> {
  if (others.length) sendPeer({ k: 'reply-has', m: commandId, has: iHave });
  const deadline = Date.now() + waitMs;
  while (others.length && Date.now() < deadline) {
    const has = peerAnswers.get(commandId)?.has;
    if (has && others.every((o) => has.has(o))) break;
    await sleep(100);
  }
  const has = peerAnswers.get(commandId)?.has ?? new Map<string, boolean>();
  const out = others.filter((o) => has.get(o) === true);
  if (iHave) out.push(myId);
  return out.sort();
}

