/**
 * "Send replies from Telegram", end to end on the Telegram side: a reply to
 * an alert (or /reply) → preview with Send / Cancel → the state machine in
 * src/background/replies.ts. Chrome storage is an in-memory fake (the real
 * src/lib/storage.ts runs, so the serialized writes are real), Telegram, the
 * relay, the watch tab and the driver are fakes. Each test loads fresh
 * modules (replies.ts keeps state in memory). All names and texts are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalState, PendingReply, PresenceAccount } from '../src/lib/storage';
import type { SendOutcome } from '../src/background/replyDriver';

type Keyboard = Array<Array<{ text: string; url?: string; callback_data?: string }>>;
type Hooks = { aborted?: () => boolean; beforeClick?: () => void | Promise<void> };

const fake = vi.hoisted(() => {
  const areas: Record<string, Record<string, unknown>> = { local: {}, session: {} };
  const area = (name: string) => ({
    get: async (keys: null | string | string[]) => {
      const all = structuredClone(areas[name]!);
      if (keys === null) return all;
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in all).map((k) => [k, all[k]]));
    },
    set: async (items: Record<string, unknown>) => void Object.assign(areas[name]!, structuredClone(items)),
    remove: async (keys: string | string[]) => {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete areas[name]![k];
    },
  });
  return {
    areas,
    area,
    nextMessageId: 1000,
    notices: [] as Array<{ html: string; opts?: { keyboard?: Keyboard; replyTo?: number; claim?: boolean; retries?: number } }>,
    edits: [] as Array<{ messageId: number; html: string; keyboard?: Keyboard }>,
    answers: [] as Array<{ id: string; text?: string }>,
    peers: [] as Array<Record<string, unknown>>,
    onPeerSent: null as null | ((body: Record<string, unknown>) => void),
    conversations: [] as string[],
    alarms: [] as Array<{ op: 'create' | 'clear'; name: string; when?: number }>,
  };
});

const fns = vi.hoisted(() => ({
  driveReply: vi.fn(),
  expectOwnMessage: vi.fn(async () => undefined),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: fake.area('local'), session: fake.area('session') },
    alarms: {
      create: async (name: string, info: { when?: number }) => void fake.alarms.push({ op: 'create', name, when: info.when }),
      clear: async (name: string) => (fake.alarms.push({ op: 'clear', name }), true),
      get: async () => undefined,
    },
  },
}));
vi.mock('../src/background/notify', () => {
  const send = async (html: string, opts?: object) => {
    fake.notices.push({ html, opts: opts as never });
    return { message_id: fake.nextMessageId++, chat: { id: 77 } };
  };
  return {
    notify: send,
    notifyLong: send,
    sendTo: async () => undefined,
    answerCallback: async (id: string, text?: string) => void fake.answers.push({ id, text }),
    editNotice: async (messageId: number, html: string, keyboard?: Keyboard) => (fake.edits.push({ messageId, html, keyboard }), true),
  };
});
vi.mock('../src/background/relay', () => ({
  isRelayOpen: () => true,
  sendForget: () => true,
  claim: async () => undefined,
  sendPeer: (body: Record<string, unknown>) => {
    fake.peers.push(structuredClone(body));
    fake.onPeerSent?.(body);
    return true;
  },
}));
vi.mock('../src/background/watchTab', () => ({
  withConversation: async (username: string, fn: (tabId: number) => Promise<unknown>) => {
    fake.conversations.push(username);
    return fn(1);
  },
  askTab: async () => ({ ok: true }),
  askTabOnce: async () => null,
  readConversation: async () => null,
}));
vi.mock('../src/background/replyDriver', () => ({ driveReply: fns.driveReply }));
vi.mock('../src/background/listSync', () => ({ reloadAndCompare: async () => null }));
vi.mock('../src/background/alerts', () => ({ expectOwnMessage: fns.expectOwnMessage }));

const CHAT = 77;
const BOT_ID = 4242;
const ME = 'acc-a';
const BUYER = 'test_buyer_one';
const TEXT = 'Hello, the files are ready.';

let commands: typeof import('../src/background/commands');
let replies: typeof import('../src/background/replies');
let DEFAULT_SETTINGS: typeof import('../src/lib/storage').DEFAULT_SETTINGS;
let rememberReplyTarget: typeof import('../src/background/replyTargets').rememberReplyTarget;
let warn: ReturnType<typeof vi.spyOn>;

/** Fresh modules, so the in-memory state of replies.ts starts empty (a new worker). */
async function load() {
  vi.resetModules();
  commands = await import('../src/background/commands');
  replies = await import('../src/background/replies');
  ({ DEFAULT_SETTINGS } = await import('../src/lib/storage'));
  ({ rememberReplyTarget } = await import('../src/background/replyTargets'));
}

function setup(o: { id?: string; label?: string; sendReplies?: boolean; presence?: PresenceAccount[]; hasBuyer?: boolean } = {}) {
  const local: Partial<LocalState> = {
    relayUrl: '',
    token: 't',
    bot: { id: BOT_ID, username: 'test_alerts_bot', firstName: 'Alerts' },
    chatId: CHAT,
    accountId: o.id ?? ME,
    label: o.label ?? 'Main',
    botKey: 'k',
    secret: 's',
    detectedUsername: 'test_seller',
    settings: { ...DEFAULT_SETTINGS, sendReplies: o.sendReplies ?? true },
    listState: { at: Date.now(), page: '1', rows: o.hasBuyer === false ? {} : { [`u:${BUYER}`]: { username: BUYER, name: 'Test Buyer', unread: 0, preview: 'hi', mine: false } as never } },
  };
  fake.areas.local = structuredClone(local) as Record<string, unknown>;
  fake.areas.session = { presence: o.presence ?? [], relay: { phase: 'connected', attempts: 0 } };
}

beforeEach(async () => {
  vi.useRealTimers();
  fake.nextMessageId = 1000;
  fake.notices.length = 0;
  fake.edits.length = 0;
  fake.answers.length = 0;
  fake.peers.length = 0;
  fake.conversations.length = 0;
  fake.alarms.length = 0;
  fake.onPeerSent = null;
  fns.driveReply.mockReset();
  fns.driveReply.mockImplementation(async () => ({ state: 'sent', at: Date.now() }) satisfies SendOutcome);
  fns.expectOwnMessage.mockClear();
  await load();
  setup();
  warn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  // handleUpdate swallows errors with console.warn: a test that passed on a thrown error is not a pass.
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- helpers

const ALERT_ID = 40;
let msgIds = 500;

/** A reply in Telegram to the bot's message `to` (an alert by default). */
function replyMsg(o: { text?: string; to?: number; markup?: unknown; chat?: number; fromBot?: boolean; extra?: Record<string, unknown>; id?: number } = {}) {
  return {
    message_id: o.id ?? ++msgIds,
    chat: { id: o.chat ?? CHAT, type: 'private' },
    from: { id: 1, is_bot: false, first_name: 'Seller' },
    ...('text' in o ? (o.text === undefined ? {} : { text: o.text }) : { text: TEXT }),
    ...o.extra,
    reply_to_message: {
      message_id: o.to ?? ALERT_ID,
      from: { id: BOT_ID, is_bot: o.fromBot ?? true, first_name: 'Alerts' },
      text: 'Main\nMessage from Test Buyer',
      ...(o.markup ? { reply_markup: o.markup } : {}),
    },
  };
}
const sendMessage = (message: Record<string, unknown>, routed = true) => commands.handleUpdate({ message }, routed);
const say = (text: string, id = ++msgIds) => commands.handleUpdate({ message: { message_id: id, chat: { id: CHAT, type: 'private' }, text } }, false);

let cqIds = 0;
function press(data: string, previewId: number | undefined, chat = CHAT) {
  return commands.handleUpdate({ callback_query: { id: `cq${++cqIds}`, data, from: { id: 1 }, message: { message_id: previewId, chat: { id: chat } } } }, true);
}

const stored = () => (fake.areas.local!.replies ?? {}) as Record<string, PendingReply>;
const only = (): PendingReply => {
  const list = Object.values(stored());
  expect(list).toHaveLength(1);
  return list[0]!;
};
const previews = () => fake.notices.filter((n) => n.html.startsWith('Send this to'));
const lastAnswer = () => fake.answers.at(-1)?.text;

/** Reply to a remembered alert, return the stored reply and the Send/Cancel data. */
async function makePreview(text = TEXT, alertId = ALERT_ID) {
  await rememberReplyTarget(alertId, BUYER);
  await sendMessage(replyMsg({ text, to: alertId }));
  const r = Object.values(stored()).find((x) => x.text === text.trim() && x.state === 'preview')!;
  expect(r).toBeDefined();
  return { r, send: `c|${ME}|rs|${r.id}`, cancel: `c|${ME}|rc|${r.id}` };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------- tests

describe('preview', () => {
  it('1. a text reply to an alert shows a preview with Send and Cancel, and sends nothing', async () => {
    await rememberReplyTarget(ALERT_ID, BUYER);
    const msg = replyMsg({ text: TEXT });
    await sendMessage(msg);

    expect(fake.notices).toHaveLength(1);
    const n = fake.notices[0]!;
    expect(n.html).toContain('Send this to <b>@test_buyer_one</b> from <b>Main</b>?');
    expect(n.html).toContain(`<blockquote>${TEXT}</blockquote>`);
    const r = only();
    expect(n.opts?.keyboard).toEqual([[{ text: 'Send', callback_data: `c|${ME}|rs|${r.id}` }, { text: 'Cancel', callback_data: `c|${ME}|rc|${r.id}` }]]);
    expect(n.opts?.claim).toBe(true);
    expect(n.opts?.replyTo).toBe(msg.message_id);

    expect(r).toMatchObject({ state: 'preview', buyer: BUYER, label: 'Main', text: TEXT, sourceKey: `${CHAT}:${msg.message_id}`, previewId: 1000 });
    expect(r.expiresAt - r.createdAt).toBe(5 * 60_000);
    expect(fake.alarms.at(-1)).toEqual({ op: 'create', name: replies.REPLY_ALARM, when: r.expiresAt });
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(fake.conversations).toEqual([]);
  });

  it('1b. the buyer can come from the alert keyboard (no recorded target)', async () => {
    const markup = { inline_keyboard: [[{ text: 'Open inbox', url: `https://www.fiverr.com/inbox/${BUYER}` }], [{ text: 'Full message', callback_data: `c|${ME}|full|${BUYER}` }, { text: 'Check now', callback_data: `c|${ME}|check|` }]] };
    await sendMessage(replyMsg({ text: TEXT, to: 41, markup }));
    expect(previews()).toHaveLength(1);
    expect(previews()[0]!.html).toContain('<b>@test_buyer_one</b>');
    expect(only().state).toBe('preview');
    expect(fns.driveReply).not.toHaveBeenCalled();
  });

  it('15. "sending" is in storage before the driver starts', async () => {
    const { send, r } = await makePreview();
    let seen: PendingReply | undefined;
    let editedFirst = false;
    fns.driveReply.mockImplementation(async () => {
      seen = structuredClone((fake.areas.local!.replies as Record<string, PendingReply>)[r.id]);
      editedFirst = fake.edits.some((e) => e.messageId === r.previewId && e.html.startsWith('Sending…'));
      return { state: 'sent', at: Date.now() };
    });
    await press(send, r.previewId);
    expect(fns.driveReply).toHaveBeenCalledTimes(1);
    expect(seen?.state).toBe('sending');
    expect(typeof seen?.startedAt).toBe('number');
    expect(editedFirst).toBe(true);
  });
});

describe('expiry and cancel', () => {
  it('2. Send after 5 minutes does nothing; the preview says "Expired" without buttons', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-20T09:00:00Z');
    vi.setSystemTime(t0);
    const { send, r } = await makePreview();
    vi.setSystemTime(t0 + 5 * 60_000);
    await press(send, r.previewId);

    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(lastAnswer()).toBe('Expired. Nothing was sent.');
    const e = fake.edits.at(-1)!;
    expect(e.messageId).toBe(r.previewId);
    expect(e.html.startsWith('Expired. Nothing was sent.')).toBe(true);
    expect(e.keyboard).toBeUndefined();
    expect(only().state).toBe('expired');
    expect(only().text).toBeUndefined();
  });

  it('2b. the alarm (sweepReplies) expires an untouched preview, and not before 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-20T09:00:00Z');
    vi.setSystemTime(t0);
    const { r } = await makePreview();

    vi.setSystemTime(t0 + 5 * 60_000 - 1);
    await replies.sweepReplies();
    expect(fake.edits).toEqual([]);
    expect(only().state).toBe('preview');

    vi.setSystemTime(t0 + 5 * 60_000);
    await replies.sweepReplies();
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0]!.messageId).toBe(r.previewId);
    expect(fake.edits[0]!.html.startsWith('Expired. Nothing was sent.')).toBe(true);
    expect(fake.edits[0]!.keyboard).toBeUndefined();
    expect(only().state).toBe('expired');
    expect(only().text).toBeUndefined();
    // Then a press finds it expired.
    await press(`c|${ME}|rs|${r.id}`, r.previewId);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(lastAnswer()).toBe('Expired. Nothing was sent.');
  });

  it('3. Cancel: "Cancelled", then Send does nothing', async () => {
    const { send, cancel, r } = await makePreview();
    await press(cancel, r.previewId);
    expect(fake.edits.at(-1)!.html.startsWith('Cancelled. Nothing was sent.')).toBe(true);
    expect(fake.edits.at(-1)!.keyboard).toBeUndefined();
    expect(lastAnswer()).toBe('Cancelled. Nothing was sent.');
    expect(only().state).toBe('cancelled');
    expect(only().text).toBeUndefined();

    await press(send, r.previewId);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(lastAnswer()).toBe('Cancelled. Nothing was sent.');
  });
});

describe('refusals', () => {
  it('4. switch off: a reply gets the "off" notice and no preview', async () => {
    setup({ sendReplies: false });
    await rememberReplyTarget(ALERT_ID, BUYER);
    const msg = replyMsg({ text: TEXT });
    await sendMessage(msg);
    expect(fake.notices).toEqual([{ html: "Sending is off for <b>Main</b>. Turn on 'Send replies from Telegram' in Settings.", opts: { replyTo: msg.message_id } }]);
    expect(stored()).toEqual({});
  });

  it('4b. switch turned off after the preview: Send does not deliver', async () => {
    const { send, r } = await makePreview();
    (fake.areas.local!.settings as { sendReplies: boolean }).sendReplies = false;
    await press(send, r.previewId);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(fake.conversations).toEqual([]);
    expect(lastAnswer()).toBe('Sending is off.');
    expect(fake.notices.at(-1)!.html).toBe(replies.offText('Main'));
    expect(only().state).toBe('preview');
  });

  it('5. photo, document, sticker, voice (and a photo with a caption): refused, no preview', async () => {
    await rememberReplyTarget(ALERT_ID, BUYER);
    const files: Array<Record<string, unknown>> = [
      { photo: [{ file_id: 'p1', width: 10, height: 10 }] },
      { document: { file_id: 'd1', file_name: 'files.zip' } },
      { sticker: { file_id: 's1' } },
      { voice: { file_id: 'v1', duration: 3 } },
      { photo: [{ file_id: 'p2', width: 10, height: 10 }], caption: TEXT },
    ];
    for (const extra of files) await sendMessage(replyMsg({ text: undefined, extra }));
    expect(fake.notices.map((n) => n.html)).toEqual(Array(files.length).fill(replies.FILES_TEXT));
    expect(stored()).toEqual({});
    expect(fns.driveReply).not.toHaveBeenCalled();
  });

  it('6. over 2,500 characters: refused with the length; 2,500 is accepted', async () => {
    await rememberReplyTarget(ALERT_ID, BUYER);
    await sendMessage(replyMsg({ text: 'a'.repeat(2501) }));
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]!.html).toBe(replies.tooLongText(2501));
    expect(fake.notices[0]!.html).toContain('2,501 characters');
    expect(fake.notices[0]!.html).toContain('at most 2,500');
    expect(stored()).toEqual({});

    await sendMessage(replyMsg({ text: 'a'.repeat(2500) }));
    expect(previews()).toHaveLength(1);
    expect(only().text).toHaveLength(2500);
  });

  it('13. a reply from another chat, or a press from another chat: nothing', async () => {
    await rememberReplyTarget(ALERT_ID, BUYER);
    await sendMessage(replyMsg({ text: TEXT, chat: 99 }));
    expect(fake.notices).toEqual([]);
    expect(stored()).toEqual({});

    const { send, r } = await makePreview();
    fake.answers.length = 0;
    await press(send, r.previewId, 99);
    expect(fake.answers).toEqual([]);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(only().state).toBe('preview');
  });

  it('13b. a reply to a message that is not from this bot: nothing', async () => {
    await rememberReplyTarget(ALERT_ID, BUYER);
    await sendMessage(replyMsg({ text: TEXT, fromBot: false }));
    expect(fake.notices).toEqual([]);
    expect(stored()).toEqual({});
  });
});

describe('/reply', () => {
  it('7. one account online with the buyer: preview; a label is parsed off the text', async () => {
    await say('/reply test_buyer_one Hello there', 60);
    expect(previews()).toHaveLength(1);
    expect(previews()[0]!.html).toBe('Send this to <b>@test_buyer_one</b> from <b>Main</b>?\n\n<blockquote>Hello there</blockquote>');
    expect(previews()[0]!.opts?.replyTo).toBe(60);
    expect(only()).toMatchObject({ state: 'preview', buyer: BUYER, text: 'Hello there', sourceKey: `${CHAT}:60` });
    expect(fake.peers).toEqual([]);

    await say('/reply test_buyer_one Main Hello there', 61);
    expect(previews()).toHaveLength(2);
    expect(previews()[1]!.html).toContain('<blockquote>Hello there</blockquote>');
    expect(Object.values(stored()).map((r) => r.text)).toEqual(['Hello there', 'Hello there']);
    expect(fns.driveReply).not.toHaveBeenCalled();
  });

  const BOTH: PresenceAccount[] = [
    { accountId: 'acc-a', label: 'Main', online: true, lastSeen: 0 },
    { accountId: 'acc-b', label: 'Second', online: true, lastSeen: 0 },
  ];

  it('8. two accounts have the buyer: no preview; the first holder names both, the other says nothing', async () => {
    // As acc-a (the first holder). acc-b answers "has" when acc-a asks.
    setup({ id: 'acc-a', label: 'Main', presence: BOTH });
    fake.onPeerSent = (body) => replies.onPeer('acc-b', { k: 'reply-has', m: body.m, has: true });
    await say(`/reply ${BUYER} ${TEXT}`, 70);
    expect(previews()).toEqual([]);
    expect(stored()).toEqual({});
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]!.html).toContain('is in 2 accounts: <b>Main</b>, <b>Second</b>. Nothing was sent.');
    expect(fake.peers).toEqual([{ k: 'reply-has', m: 70, has: true }]);
    expect(JSON.stringify(fake.peers)).not.toContain(BUYER);
    expect(JSON.stringify(fake.peers)).not.toContain('Hello');

    // As acc-b (not the first holder): only its own yes/no frame, no message.
    fake.notices.length = 0;
    fake.peers.length = 0;
    await load();
    setup({ id: 'acc-b', label: 'Second', presence: BOTH });
    fake.onPeerSent = (body) => replies.onPeer('acc-a', { k: 'reply-has', m: body.m, has: true });
    await say(`/reply ${BUYER} ${TEXT}`, 70);
    expect(fake.notices).toEqual([]);
    expect(stored()).toEqual({});
    expect(fake.peers).toEqual([{ k: 'reply-has', m: 70, has: true }]);
    expect(fns.driveReply).not.toHaveBeenCalled();
  });

  it('8b. two accounts, only this one has the buyer: preview here', async () => {
    setup({ id: 'acc-b', label: 'Second', presence: BOTH });
    fake.onPeerSent = (body) => replies.onPeer('acc-a', { k: 'reply-has', m: body.m, has: false });
    await say(`/reply ${BUYER} ${TEXT}`, 71);
    expect(previews()).toHaveLength(1);
    expect(previews()[0]!.html).toContain('from <b>Second</b>?');
    expect(fake.peers).toEqual([{ k: 'reply-has', m: 71, has: true }]);
  });

  it('8c. two accounts, a label names one: only that account previews, no peer frame', async () => {
    setup({ id: 'acc-a', label: 'Main', presence: BOTH });
    await say(`/reply ${BUYER} Second ${TEXT}`, 72);
    expect(fake.notices).toEqual([]);
    expect(stored()).toEqual({});

    await load();
    setup({ id: 'acc-b', label: 'Second', presence: BOTH });
    await say(`/reply ${BUYER} Second ${TEXT}`, 72);
    expect(previews()).toHaveLength(1);
    expect(previews()[0]!.html).toBe(`Send this to <b>@${BUYER}</b> from <b>Second</b>?\n\n<blockquote>${TEXT}</blockquote>`);
    expect(fake.peers).toEqual([]);
  });
});

describe('at most one send', () => {
  it('9. the same reply update twice (in turn and at once): one preview', async () => {
    await rememberReplyTarget(ALERT_ID, BUYER);
    const msg = replyMsg({ text: TEXT });
    await sendMessage(msg);
    await sendMessage(msg);
    expect(previews()).toHaveLength(1);

    const msg2 = replyMsg({ text: 'Second text for the same buyer.' });
    await Promise.all([sendMessage(msg2), sendMessage(msg2)]);
    expect(previews()).toHaveLength(2);
    expect(Object.keys(stored())).toHaveLength(2);
  });

  it('9b. the same Send twice in turn: one send, then "Already sent."', async () => {
    const { send, r } = await makePreview();
    await press(send, r.previewId);
    await press(send, r.previewId);
    expect(fns.driveReply).toHaveBeenCalledTimes(1);
    expect(lastAnswer()).toBe('Already sent.');
  });

  it('9c. the same Send twice at once: one send, the other "Already sending." or "Already sent."', async () => {
    const { send, r } = await makePreview();
    await Promise.all([press(send, r.previewId), press(send, r.previewId)]);
    expect(fns.driveReply).toHaveBeenCalledTimes(1);
    const texts = fake.answers.map((a) => a.text);
    expect(texts).toContain('Sending…');
    expect(texts.filter((t) => t === 'Already sending.' || t === 'Already sent.')).toHaveLength(1);
    expect(only().state).toBe('sent');
  });

  it('10. a worker restart during "sending": unknown, edited, never sent again', async () => {
    const now = Date.now();
    fake.areas.local!.replies = {
      r1: { id: 'r1', state: 'sending', buyer: BUYER, label: 'Main', text: TEXT, sourceKey: `${CHAT}:5`, previewId: 70, createdAt: now - 60_000, expiresAt: now + 240_000, startedAt: now - 30_000 },
    } satisfies Record<string, PendingReply>;
    await load(); // the new worker
    await replies.recoverReplies();
    await replies.recoverReplies(); // once per worker
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0]!.messageId).toBe(70);
    expect(fake.edits[0]!.html.startsWith('Unknown. Check Fiverr before you send again.')).toBe(true);
    expect(only()).toMatchObject({ id: 'r1', state: 'unknown' });
    expect(only().text).toBeUndefined();

    await press(`c|${ME}|rs|r1`, 70);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(lastAnswer()).toBe(replies.UNKNOWN_LINE);
  });

  it('11. busy: Send on a second preview while one is sending; it works after the first ends', async () => {
    const a = await makePreview(TEXT, 40);
    const b = await makePreview('Second text for the same buyer.', 41);
    const first = deferred<SendOutcome>();
    fns.driveReply.mockImplementationOnce(() => first.promise);

    const p1 = press(a.send, a.r.previewId);
    await vi.waitFor(() => expect(fns.driveReply).toHaveBeenCalledTimes(1));
    await press(b.send, b.r.previewId);
    expect(lastAnswer()).toBe('Busy. Try again in a moment.');
    expect(fns.driveReply).toHaveBeenCalledTimes(1);
    expect(stored()[b.r.id]!.state).toBe('preview');

    first.resolve({ state: 'sent', at: Date.now() });
    await p1;
    await press(b.send, b.r.previewId);
    expect(fns.driveReply).toHaveBeenCalledTimes(2);
    expect(stored()[a.r.id]!.state).toBe('sent');
    expect(stored()[b.r.id]!.state).toBe('sent');
  });
});

describe('results', () => {
  it('12. sent: "Sent to @buyer at …", the read note, no text kept; deleted 10 minutes later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-20T09:00:00Z');
    vi.setSystemTime(t0);
    const { send, r } = await makePreview();
    fns.driveReply.mockImplementation(async (_page: unknown, buyer: string, text: string, me: string, hooks: Hooks) => {
      expect([buyer, text, me]).toEqual([BUYER, TEXT, 'test_seller']);
      await hooks.beforeClick?.();
      return { state: 'sent', at: Date.now() };
    });
    await press(send, r.previewId);

    expect(fake.conversations).toEqual([BUYER]);
    expect(fns.expectOwnMessage).toHaveBeenCalledWith(BUYER, TEXT);
    const e = fake.edits.at(-1)!;
    expect(e.messageId).toBe(r.previewId);
    expect(e.html.startsWith('Sent to <b>@test_buyer_one</b> at ')).toBe(true);
    expect(e.html).toContain('Opening the conversation marked it as read on Fiverr.');
    expect(e.html).toContain(`<blockquote>${TEXT}</blockquote>`);
    expect(e.keyboard).toBeUndefined();
    const done = only();
    expect(done).toMatchObject({ state: 'sent', finishedAt: t0 });
    expect(done.text).toBeUndefined();
    expect(JSON.stringify(fake.areas.local!.replies)).not.toContain(TEXT);

    vi.setSystemTime(t0 + 10 * 60_000 - 1);
    await replies.sweepReplies();
    expect(Object.keys(stored())).toHaveLength(1);
    vi.setSystemTime(t0 + 10 * 60_000);
    await replies.sweepReplies();
    expect(stored()).toEqual({});
    expect(fake.alarms.at(-1)).toEqual({ op: 'clear', name: replies.REPLY_ALARM });
  });

  it('12b. failed: "Not sent: <reason>"', async () => {
    const { send, r } = await makePreview();
    fns.driveReply.mockImplementation(async () => ({ state: 'failed', reason: 'the message box was not found.' }));
    await press(send, r.previewId);
    const e = fake.edits.at(-1)!;
    expect(e.html.startsWith('Not sent: the message box was not found.')).toBe(true);
    expect(only()).toMatchObject({ state: 'failed' });
    expect(only().text).toBeUndefined();
    await press(send, r.previewId);
    expect(fns.driveReply).toHaveBeenCalledTimes(1);
  });

  it('12c. unknown: starts with "Unknown. Check Fiverr before you send again."', async () => {
    const { send, r } = await makePreview();
    fns.driveReply.mockImplementation(async () => ({ state: 'unknown', reason: 'the Fiverr page did not answer when Send was pressed.' }));
    await press(send, r.previewId);
    const e = fake.edits.at(-1)!;
    expect(e.html.startsWith('Unknown. Check Fiverr before you send again.')).toBe(true);
    expect(e.html).toContain('the Fiverr page did not answer when Send was pressed.');
    expect(only()).toMatchObject({ state: 'unknown' });
    expect(only().text).toBeUndefined();
  });

  it('12d. the conversation does not open: failed with that reason', async () => {
    const watch = await import('../src/background/watchTab');
    const spy = vi.spyOn(watch, 'withConversation').mockRejectedValueOnce(new Error('the watch tab is not open.'));
    const { send, r } = await makePreview();
    await press(send, r.previewId);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(fake.edits.at(-1)!.html.startsWith('Not sent: the watch tab is not open.')).toBe(true);
    expect(only().state).toBe('failed');
    spy.mockRestore();
  });
});

describe('disconnect', () => {
  it('14. dropAllReplies: open previews say cancelled/disconnected, storage is emptied', async () => {
    const a = await makePreview(TEXT, 40);
    const b = await makePreview('Second text for the same buyer.', 41);
    await press(b.cancel, b.r.previewId);
    fake.edits.length = 0;

    await replies.dropAllReplies();
    expect(fake.edits).toHaveLength(1);
    expect(fake.edits[0]!.messageId).toBe(a.r.previewId);
    expect(fake.edits[0]!.html.startsWith('Cancelled. Nothing was sent. This profile was disconnected.')).toBe(true);
    expect(fake.edits[0]!.keyboard).toBeUndefined();
    expect(stored()).toEqual({});
    expect(fake.alarms.at(-1)).toEqual({ op: 'clear', name: replies.REPLY_ALARM });

    await press(a.send, a.r.previewId);
    expect(fns.driveReply).not.toHaveBeenCalled();
    expect(lastAnswer()).toBe('This reply is no longer available. Nothing was sent.');
  });

  it('14b. dropAllReplies during a send: the preview says unknown, and the result is not written back', async () => {
    const { send, r } = await makePreview();
    const pending = deferred<SendOutcome>();
    fns.driveReply.mockImplementationOnce(() => pending.promise);
    const p = press(send, r.previewId);
    await vi.waitFor(() => expect(fns.driveReply).toHaveBeenCalledTimes(1));

    await replies.dropAllReplies();
    expect(fake.edits.at(-1)!.html.startsWith('Unknown. Check Fiverr before you send again. (This profile was disconnected during the send.)')).toBe(true);
    expect(stored()).toEqual({});

    const editsBefore = fake.edits.length;
    pending.resolve({ state: 'failed', reason: 'this profile was disconnected during the send.' });
    await p;
    expect(stored()).toEqual({});
    expect(fake.edits).toHaveLength(editsBefore);
  });

  // The abort flag must stay set while the send in progress is still running
  // (the driver may be sleeping between typing steps or before the click),
  // and clear only when that send ends, so the next send can run.
  it('14c. dropAllReplies during a send: the driver still sees "aborted" after it returns', async () => {
    const { send, r } = await makePreview();
    const pending = deferred<SendOutcome>();
    let hooks: Hooks = {};
    fns.driveReply.mockImplementationOnce((_p: unknown, _b: string, _t: string, _m: string, h: Hooks) => ((hooks = h), pending.promise));
    const p = press(send, r.previewId);
    await vi.waitFor(() => expect(fns.driveReply).toHaveBeenCalledTimes(1));
    expect(hooks.aborted?.()).toBe(false);

    await replies.dropAllReplies();
    try {
      // The driver wakes from its sleep now and checks before the next step / the click.
      expect(hooks.aborted?.()).toBe(true);
    } finally {
      pending.resolve({ state: 'failed', reason: 'stopped' });
      await p;
    }
    expect(hooks.aborted?.()).toBe(false);
  });
});
