/**
 * Telegram commands: who answers, what they answer, and the buttons.
 * Storage, sending and the watch tab are replaced by fakes. All names are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuyerZone } from '../src/lib/buyerTime';
import type { LocalState, PresenceAccount, SessionState } from '../src/lib/storage';

const state: { local: LocalState; session: SessionState } = {} as never;
const sent: Array<{ html: string; opts?: { keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>; replyTo?: number } }> = [];

vi.mock('../src/lib/storage', async (orig) => {
  const actual = await orig<typeof import('../src/lib/storage')>();
  return {
    ...actual,
    getLocal: async () => structuredClone(state.local),
    getSession: async () => structuredClone(state.session),
    setLocal: async (p: Partial<LocalState>) => void Object.assign(state.local, p),
    patchSettings: async (p: object) => (state.local.settings = { ...state.local.settings, ...p }),
    updateLocal: async (k: keyof LocalState, fn: (v: unknown) => unknown) => void ((state.local as unknown as Record<string, unknown>)[k] = fn(state.local[k])),
  };
});
vi.mock('../src/background/notify', () => ({
  notify: vi.fn(async (html: string, opts?: object) => void sent.push({ html, opts: opts as never })),
  notifyLong: vi.fn(async (html: string, opts?: object) => void sent.push({ html, opts: opts as never })),
  sendTo: vi.fn(async () => undefined),
  answerCallback: vi.fn(async () => undefined),
}));
const relay = vi.hoisted(() => ({ forgets: [] as string[], open: true }));
vi.mock('../src/background/relay', () => ({
  isRelayOpen: () => relay.open,
  sendForget: (accountId: string) => (relay.open ? (relay.forgets.push(accountId), true) : false),
}));
vi.mock('../src/background/listSync', () => ({
  reloadAndCompare: vi.fn(async () => ({ page: '1', unread: { ok: true, value: 1 }, rows: { ok: true, value: [{ username: 'some_buyer', name: 'Some Buyer', unread: 1, time: '', mine: false, typing: false, preview: 'hi' }] } })),
}));
const watch = vi.hoisted(() => ({
  conversation: null as unknown,
  unread: 3 as number | null,
}));
vi.mock('../src/background/watchTab', () => ({
  askTabOnce: vi.fn(async () => ({ unread: watch.unread })),
  readConversation: vi.fn(async () => watch.conversation),
}));

const { BOT_COMMANDS, handleAccountRemoved, handleUpdate, helpText, parseCommand, pauseText, registerCommands, resolveTarget, unknownLabelText, validLabels } = await import('../src/background/commands');
const { DEFAULT_SETTINGS } = await import('../src/lib/storage');
const { readConversation } = await import('../src/background/watchTab');

const CHAT = 77;
const presence = (...a: Array<[string, string, boolean]>): PresenceAccount[] => a.map(([accountId, label, online]) => ({ accountId, label, online, lastSeen: 0 }));

function setup(me: { id: string; label: string }, accounts: PresenceAccount[], extra: Partial<LocalState> = {}) {
  state.local = {
    relayUrl: '',
    token: 't',
    chatId: CHAT,
    accountId: me.id,
    label: me.label,
    botKey: 'k',
    secret: 's',
    settings: { ...DEFAULT_SETTINGS },
    recentAlerts: [],
    seenUpdateIds: [],
    pendingClaims: [],
    captures: {},
    knownUsers: {},
    buyerZones: {},
    diagnostics: [],
    listState: { at: Date.now(), page: '1', rows: { 'u:some_buyer': { username: 'some_buyer', name: 'Some Buyer', unread: 1, preview: 'hi', mine: false } } },
    ...extra,
  };
  state.session = { watchTabId: 5, relay: { phase: 'connected', attempts: 0 }, presence: accounts, telegram: {}, dedupe: [] };
  sent.length = 0;
}
const say = (text: string) => handleUpdate({ message: { message_id: 9, chat: { id: CHAT, type: 'private' }, text } }, false);
const press = (data: string) => handleUpdate({ callback_query: { id: 'q', data, message: { message_id: 11, chat: { id: CHAT } } } }, true);

// Two accounts: "Main" (acc-a, leader: smallest id) and "Second" (acc-b).
const BOTH = presence(['acc-a', 'Main', true], ['acc-b', 'Second', true]);
const asMain = (accounts = BOTH, extra?: Partial<LocalState>) => setup({ id: 'acc-a', label: 'Main' }, accounts, extra);
const asSecond = (accounts = BOTH, extra?: Partial<LocalState>) => setup({ id: 'acc-b', label: 'Second' }, accounts, extra);

beforeEach(() => {
  relay.forgets.length = 0;
  relay.open = true;
  watch.conversation = null;
  watch.unread = 3;
  vi.mocked(readConversation).mockClear();
});

describe('parsing and labels', () => {
  it('splits the command from its arguments, with or without @bot', () => {
    expect(parseCommand('/full@MyBot  @Some_Buyer  Main account')).toEqual({ command: 'full', args: '@Some_Buyer  Main account' });
    expect(parseCommand('/CHECK')).toEqual({ command: 'check', args: '' });
    expect(parseCommand('hello')).toBeNull();
  });

  it('matches labels without case; never the placeholder', () => {
    const p = presence(['acc-a', 'Main', true], ['acc-b', 'Second Shop', false], ['acc-c', 'Fiverr account', true]);
    expect(resolveTarget('Main', 'acc-a', p, '')).toEqual({ kind: 'all' });
    expect(resolveTarget('Main', 'acc-a', p, 'MAIN')).toEqual({ kind: 'me' });
    expect(resolveTarget('Main', 'acc-a', p, 'second  shop')).toMatchObject({ kind: 'other', account: { accountId: 'acc-b' } });
    expect(resolveTarget('Main', 'acc-a', p, 'fiverr account')).toEqual({ kind: 'unknown' });
    expect(validLabels('Main', 'acc-a', p)).toEqual(['Main', 'Second Shop']);
    expect(unknownLabelText('Nope', ['Main', 'Second'])).toBe('No account is named <b>Nope</b>. Valid labels: <code>Main</code>, <code>Second</code>. Labels match without case.');
  });

  it('the "/" menu list is valid for Telegram', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(['check', 'full', 'status', 'pause', 'resume', 'timezone', 'accounts', 'remove', 'help']);
    for (const c of BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(2);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('registers the commands with setMyCommands on api.telegram.org', async () => {
    asMain();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })));
    vi.stubGlobal('fetch', fetchMock);
    await registerCommands();
    vi.unstubAllGlobals();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bott/setMyCommands');
    expect(JSON.parse(String(init.body)).commands).toEqual(BOT_COMMANDS);
  });
});

describe('/check', () => {
  it('without a label: every profile answers, with Open inbox and Check now for that account', async () => {
    for (const run of [asMain, asSecond]) {
      run();
      await say('/check');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.html).toContain('1 unread conversation');
      const id = state.local.accountId;
      expect(sent[0]!.opts?.keyboard).toEqual([[{ text: 'Open inbox', url: 'https://www.fiverr.com/inbox' }, { text: 'Check now', callback_data: `c|${id}|check|` }]]);
    }
  });

  it('with a label: only that account answers (any case)', async () => {
    asMain();
    await say('/check second');
    expect(sent).toHaveLength(0);
    asSecond();
    await say('/check second');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('<b>Second</b>');
  });

  it('an unknown label: the leader alone lists the valid labels', async () => {
    asMain();
    await say('/check nope');
    expect(sent.map((m) => m.html)).toEqual([unknownLabelText('nope', ['Main', 'Second'])]);
    asSecond();
    await say('/check nope');
    expect(sent).toHaveLength(0);
  });

  it('the label of an offline account: the leader says it is offline', async () => {
    asMain(presence(['acc-a', 'Main', true], ['acc-b', 'Second', false]));
    await say('/check Second');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('<b>Second</b> is offline');
  });
});

describe('/full', () => {
  it('a very long conversation goes out as several messages: reply on the first, buttons on the last', async () => {
    asMain();
    const long = 'some long made-up text & more '.repeat(260); // ~7,800 characters
    watch.conversation = { ok: true, value: { messages: [{ id: 'x', time: '', text: long, files: [] }], header: null } };
    await say('/full some_buyer');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.opts?.replyTo).toBe(9);
    expect(sent.slice(1).every((m) => m.opts?.replyTo === undefined)).toBe(true);
    expect(sent.slice(0, -1).every((m) => m.opts?.keyboard === undefined)).toBe(true);
    expect(sent.at(-1)!.opts?.keyboard?.[0]?.[0]).toMatchObject({ text: 'Open conversation' });
    for (const m of sent) expect(m.html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').length).toBeLessThanOrEqual(4096);
  });

  const zone: BuyerZone = { offset: 0, at: Date.now() };
  const read = (offset = 0) => ({
    ok: true,
    value: { messages: [{ id: 'x', time: 'Nov 16, 4:53 AM', text: 'hello', files: ['plan.pdf'] }], header: { username: 'some_buyer', offset, clock: '9:59 AM', country: 'Some Country' } },
  });

  it('accepts the username with "@" and any case; answers with times, the buyer line and both buttons', async () => {
    asMain(BOTH, { settings: { ...DEFAULT_SETTINGS, myTimeZone: 'Europe/London' } });
    watch.conversation = read();
    await say('/full @Some_Buyer');
    expect(readConversation).toHaveBeenCalledWith('Some_Buyer', 10);
    const lines = sent[0]!.html.split('\n');
    expect(lines[0]).toBe('<b>Main</b>: last messages from <b>@Some_Buyer</b>');
    expect(lines[1]).toMatch(/^Times: Europe\/London\. Buyer local time now: \d{1,2}:\d\d [AP]M \(UTC\+0, Some Country\)$/);
    expect(lines[2]).toBe('<i>Nov 16, 4:53 AM (Fiverr account time)</i>: hello [file: plan.pdf]');
    expect(sent[0]!.opts?.keyboard).toEqual([[{ text: 'Open conversation', url: 'https://www.fiverr.com/inbox/Some_Buyer' }, { text: 'Check now', callback_data: 'c|acc-a|check|' }]]);
    // The header reading was saved for later alerts.
    expect(state.local.buyerZones.some_buyer).toMatchObject({ offset: 0, country: 'Some Country' });
  });

  it('a profile without that buyer stays quiet', async () => {
    asSecond(BOTH, { listState: { at: Date.now(), page: '1', rows: {} } });
    await say('/full some_buyer');
    expect(sent).toHaveLength(0);
    expect(readConversation).not.toHaveBeenCalled();
  });

  it('with a label, only that profile answers, also when it does not have the buyer', async () => {
    asMain();
    watch.conversation = read();
    await say('/full some_buyer second');
    expect(sent).toHaveLength(0);
    asSecond(BOTH, { listState: { at: Date.now(), page: '1', rows: {} } });
    await say('/full some_buyer SECOND');
    expect(sent.map((m) => m.html)).toEqual(["<b>Second</b>: <b>@some_buyer</b> is not in this account's inbox list."]);
  });

  it('a bad or missing username: one usage reply', async () => {
    asMain();
    await say('/full');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('Usage');
    asSecond();
    await say('/full');
    expect(sent).toHaveLength(0);
  });

  it('uses a saved offset when the header was not read this time', async () => {
    asMain(BOTH, { buyerZones: { some_buyer: zone } });
    watch.conversation = { ok: true, value: { messages: [], header: null } };
    await say('/full some_buyer');
    expect(sent[0]!.html.split('\n')[1]).toMatch(/^Times: .+\. Buyer local time now: .* \(UTC\+0\)$/);
  });
});

describe('/status', () => {
  it('each account: label, online, alerts state, live unread count, last alert', async () => {
    asSecond();
    await say('/status');
    // The Unread chip counts conversations, so the text says conversations, not messages.
    expect(sent[0]!.html).toBe('<b>Second</b>: online, alerts on, 3 unread conversations, last alert never');
    watch.unread = 1;
    sent.length = 0;
    await say('/status');
    expect(sent[0]!.html).toBe('<b>Second</b>: online, alerts on, 1 unread conversation, last alert never');
  });

  it('falls back to the count from the last reload; the leader lists offline accounts', async () => {
    watch.unread = null;
    asMain(presence(['acc-a', 'Main', true], ['acc-c', 'Third', false]), { lastUnread: 2 });
    await say('/status');
    const lines = sent[0]!.html.split('\n');
    expect(lines[0]).toBe('<b>Main</b>: online, alerts on, 2 unread conversations (at the last reload), last alert never');
    expect(lines[1]).toMatch(/^<b>Third<\/b>: offline since /);
  });
});

describe('/timezone', () => {
  it('sets the zone on every account in one step; a short form is accepted', async () => {
    asSecond();
    await say('/timezone Lagos');
    expect(state.local.settings.myTimeZone).toBe('Africa/Lagos');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toMatch(/^<b>Second<\/b>: times now shown in Africa\/Lagos \(now \d{1,2}:\d\d [AP]M, UTC\+1\)\.$/);
    asMain();
    await say('/timezone@MyBot Africa/Lagos');
    expect(state.local.settings.myTimeZone).toBe('Africa/Lagos');
    expect(sent[0]!.html).toContain('<b>Main</b>: times now shown in Africa/Lagos');
  });

  it('the zone is never read as a label', async () => {
    asMain();
    await say('/timezone Europe/London');
    expect(sent.map((m) => m.html).join('\n')).not.toContain('No account is named');
    expect(state.local.settings.myTimeZone).toBe('Europe/London');
  });

  it('the leader names offline accounts, which miss the change', async () => {
    asMain(presence(['acc-a', 'Main', true], ['acc-c', 'Third', false]));
    await say('/timezone Lagos');
    expect(sent[0]!.html.split('\n')[1]).toBe('<b>Third</b>: offline, did not get the change. Send /timezone again when it is online.');
  });

  it('an unknown or ambiguous zone: one reply from the leader, nothing saved', async () => {
    asMain();
    await say('/timezone Nowhere');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('is not a time zone');
    expect(state.local.settings.myTimeZone).toBe('');
    asSecond();
    await say('/timezone Nowhere');
    expect(sent).toHaveLength(0);
    expect(state.local.settings.myTimeZone).toBe('');
  });

  it('without a zone: each account shows the zone it uses', async () => {
    asSecond();
    await say('/timezone');
    expect(sent[0]!.html).toMatch(/^<b>Second<\/b>: not set\. Using the browser zone /);
    asSecond(BOTH, { settings: { ...DEFAULT_SETTINGS, myTimeZone: 'Africa/Lagos' } });
    await say('/timezone');
    expect(sent[0]!.html).toMatch(/^<b>Second<\/b>: Africa\/Lagos \(now \d{1,2}:\d\d [AP]M, UTC\+1\)$/);
  });

  it('Full message and /status use the saved zone', async () => {
    asMain(BOTH, { settings: { ...DEFAULT_SETTINGS, myTimeZone: 'Africa/Lagos' }, lastAlertAt: Date.now() });
    watch.conversation = { ok: true, value: { messages: [], header: null } };
    await say('/full some_buyer');
    expect(sent[0]!.html.split('\n')[1]).toBe('Times: Africa/Lagos.');
    await say('/status');
    expect(sent[1]!.html.split('\n')[0]).toMatch(/last alert \d{1,2}:\d\d [AP]M \(Africa\/Lagos\)$/);
  });

  it('is in /help', () => {
    expect(helpText(['Main'])).toContain('/timezone Africa/Lagos');
  });
});

describe('/pause and /resume', () => {
  it('without a label: every account pauses and replies with its new state', async () => {
    asSecond();
    await say('/pause');
    expect(state.local.settings.sendAlerts).toBe(false);
    expect(sent[0]!.html).toBe(pauseText('Second', false, 'command'));
    await say('/resume');
    expect(state.local.settings.sendAlerts).toBe(true);
    expect(sent[1]!.html).toBe('<b>Second</b>: alerts on.');
  });

  it('with another account\'s label: nothing changes here', async () => {
    asMain();
    await say('/pause second');
    expect(state.local.settings.sendAlerts).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('the popup notice says where it was paused', () => {
    expect(pauseText('Main', false, 'chrome')).toContain('alerts paused in Chrome');
    expect(pauseText('Main', true, 'chrome')).toBe('<b>Main</b>: alerts on (turned on in Chrome).');
  });
});

describe('/help', () => {
  it('only the leader answers, with every command and an example label', async () => {
    asSecond();
    await say('/help');
    expect(sent).toHaveLength(0);
    asMain();
    await say('/help');
    expect(sent).toHaveLength(1);
    for (const c of ['/check', '/full', '/status', '/pause', '/resume', '/help']) expect(sent[0]!.html).toContain(c);
    expect(sent[0]!.html).toContain('/check Main');
    expect(helpText([])).toContain('Labels match without case.');
  });
});

describe('buttons', () => {
  it('the "Check now" button reply has Open inbox and Check now', async () => {
    asMain();
    await press('c|acc-a|check|');
    expect(sent[0]!.opts?.replyTo).toBe(11);
    expect(sent[0]!.opts?.keyboard?.[0]!.map((b) => b.text)).toEqual(['Open inbox', 'Check now']);
  });

  it('the "Full message" button reply has Open conversation and Check now', async () => {
    asMain();
    watch.conversation = { ok: true, value: { messages: [], header: null } };
    await press('c|acc-a|full|some_buyer');
    expect(sent[0]!.opts?.keyboard?.[0]!.map((b) => b.text)).toEqual(['Open conversation', 'Check now']);
  });
});

describe('/accounts', () => {
  const THREE = presence(['acc-a', 'Main', true], ['acc-b', 'Second', true], ['acc-c', 'Spare Shop', false]);

  it('the leader lists every profile with its label, online or offline, and its account id', async () => {
    asMain(THREE);
    await say('/accounts');
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.html.split('\n');
    expect(lines[0]).toBe('<b>Accounts on this bot</b> (3)');
    expect(lines[1]).toBe('• <b>Main</b>: online (<code>acc-a</code>, answers commands)');
    expect(lines[2]).toBe('• <b>Second</b>: online (<code>acc-b</code>)');
    expect(lines[3]).toMatch(/^• <b>Spare Shop<\/b>: offline, last seen .+ \(<code>acc-c<\/code>\)$/);
  });

  it('only the leader answers, so the user gets one reply', async () => {
    asSecond(THREE);
    await say('/accounts');
    expect(sent).toHaveLength(0);
  });
});

describe('/remove', () => {
  const THREE = presence(['acc-a', 'Main', true], ['acc-b', 'Second', true], ['acc-c', 'Spare Shop', false]);

  it('a valid label: the leader sends the forget frame for that account (offline ones too)', async () => {
    asMain(THREE);
    await say('/remove spare  shop');
    expect(relay.forgets).toEqual(['acc-c']);
    // The confirmation comes from the relay's account_removed notice, not here.
    expect(sent).toHaveLength(0);
    await say('/remove Second');
    expect(relay.forgets).toEqual(['acc-c', 'acc-b']);
  });

  it('only the leader acts on it', async () => {
    asSecond(THREE);
    await say('/remove Spare Shop');
    expect(relay.forgets).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('an unknown label is refused and the valid labels are shown', async () => {
    asMain(THREE);
    await say('/remove Nope');
    expect(relay.forgets).toEqual([]);
    expect(sent[0]!.html).toBe('No account is named <b>Nope</b>. Profiles you can remove: <code>Second</code>, <code>Spare Shop</code>. Labels match without case.');
  });

  it('two profiles with the same label: asks for the account id, which then works', async () => {
    asMain(presence(['acc-a', 'Main', true], ['acc-b', 'Shop', true], ['acc-c', 'shop', false]));
    await say('/remove Shop');
    expect(relay.forgets).toEqual([]);
    expect(sent[0]!.html).toContain('2 profiles are named <b>Shop</b>: <code>acc-b</code>, <code>acc-c</code>.');
    expect(sent[0]!.html).toContain('/accounts');
    await say('/remove acc-c');
    expect(relay.forgets).toEqual(['acc-c']);
  });

  it("the leader's own label is refused: use Settings on that profile", async () => {
    asMain(THREE);
    await say('/remove main');
    await say('/remove acc-a');
    expect(relay.forgets).toEqual([]);
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(m.html).toContain('<b>Main</b> is the profile that answers commands, so it cannot remove itself from Telegram.');
      expect(m.html).toContain('Disconnect this profile');
    }
  });

  it('no label: usage; relay down: says it was not removed', async () => {
    asMain(THREE);
    await say('/remove');
    expect(sent[0]!.html).toMatch(/^Usage: <code>\/remove label<\/code>/);
    relay.open = false;
    await say('/remove Second');
    expect(sent[1]!.html).toContain('was not removed');
  });

  it('/help lists /accounts and /remove', async () => {
    asMain(THREE);
    await say('/help');
    expect(sent[0]!.html).toContain('/accounts:');
    expect(sent[0]!.html).toContain('/remove label:');
  });
});

describe('account_removed from the relay', () => {
  it('sends one notice: "{label} was removed from this bot."', async () => {
    asMain();
    await handleAccountRemoved('acc-z', 'Old <Shop>');
    expect(sent.map((m) => m.html)).toEqual(['<b>Old &lt;Shop&gt;</b> was removed from this bot.']);
  });

  it('ignores a notice about itself, and needs a linked chat', async () => {
    asMain();
    await handleAccountRemoved('acc-a', 'Main');
    asMain(BOTH, { chatId: undefined });
    await handleAccountRemoved('acc-z', 'Old');
    expect(sent).toHaveLength(0);
  });
});
