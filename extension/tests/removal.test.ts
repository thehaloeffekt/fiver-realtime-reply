/**
 * Removing a profile: Settings "Disconnect this profile", the relay's
 * "removed" (from /remove or an uninstall elsewhere), and the uninstall URL.
 * Chrome APIs, the relay socket, the watch tab and Telegram are fakes that
 * write each step into `calls`. All names and ids are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const fake = vi.hoisted(() => {
  const areas: Record<string, Record<string, unknown>> = { local: {}, session: {} };
  const area = (name: string, log: (s: string) => void) => ({
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
    clear: async () => {
      log(`storage.${name}.clear`);
      areas[name] = {};
    },
  });
  return { areas, area, log: [] as string[], presence: [] as unknown[], noticeFails: false, forgetResult: true };
});

vi.mock('wxt/browser', () => {
  const log = (s: string) => calls.push(s);
  return {
    browser: {
      storage: { local: fake.area('local', log), session: fake.area('session', log) },
      alarms: {
        clearAll: async () => void calls.push('alarms.clearAll'),
        get: async () => undefined,
        create: async () => undefined,
        clear: async () => true,
      },
      runtime: { setUninstallURL: async (url: string) => void calls.push(`setUninstallURL ${url}`) },
    },
  };
});
vi.mock('../src/background/relay', () => ({
  connectRelay: vi.fn(async () => {
    calls.push(`connect (removalCode ${fake.areas.local!.removalCode ? 'set' : 'missing'})`);
  }),
  forgetSelf: vi.fn(async () => {
    calls.push('forget');
    // The relay's ready frame before the forget leaves the account list in session storage.
    fake.areas.session!.presence = fake.presence;
    return fake.forgetResult;
  }),
  disconnectRelay: vi.fn(async () => void calls.push('socket.close')),
}));
vi.mock('../src/background/watchTab', () => ({
  closeWatchTab: vi.fn(async () => void calls.push('watchTab.close')),
  ensureWatchTab: vi.fn(async () => 1),
}));
vi.mock('../src/background/notify', () => ({
  notify: vi.fn(async (html: string) => {
    calls.push(`notice ${html}`);
    if (fake.noticeFails) throw new Error('telegram down');
  }),
  describeTelegramError: (e: Error) => e.message,
}));
vi.mock('../src/background/commands', () => ({ registerCommands: vi.fn(async () => undefined) }));
vi.mock('../src/lib/telegram', async (orig) => ({
  ...(await orig<typeof import('../src/lib/telegram')>()),
  deleteWebhook: vi.fn(async () => void calls.push('deleteWebhook')),
  setWebhook: vi.fn(async () => void calls.push('setWebhook')),
}));

const { applyUninstallUrl, connectAndRegisterWebhook, disconnectProfile, isLastAccount, onRemovedRemotely } = await import('../src/background/setup');
const { getLocal } = await import('../src/lib/storage');
const { MAX_UNINSTALL_URL_CHARS, uninstallUrl } = await import('../src/lib/keys');
const { REMOVED_NOTICE, removedNotice } = await import('../src/ui/status');
const { DEFAULT_RELAY_URL } = await import('../src/lib/constants');

const TOKEN = '123456789:AAmadeUpTokenForTestsOnly_abcdefghijk';
const BOT_KEY = 'b'.repeat(64);
const SECRET = 'e'.repeat(64);
const CODE = '7'.repeat(64);
const ME = 'acc0me01';

const acct = (accountId: string, online = true) => ({ accountId, label: accountId, online, lastSeen: 0 });

function configured(extra: Record<string, unknown> = {}) {
  fake.areas.local = {
    relayUrl: DEFAULT_RELAY_URL,
    token: TOKEN,
    botKey: BOT_KEY,
    secret: SECRET,
    chatId: 4242,
    accountId: ME,
    removalCode: CODE,
    label: 'Main Shop',
    webhookUrl: `${DEFAULT_RELAY_URL}/hook/${BOT_KEY}`,
    recentAlerts: [{ at: 1, displayName: 'Some Buyer', username: 'some_buyer', text: 'hi', status: 'sent' }],
    ...extra,
  };
  fake.areas.session = { watchTabId: 9 };
}

beforeEach(() => {
  calls.length = 0;
  fake.presence = [acct(ME), acct('acc0two2', false)];
  fake.noticeFails = false;
  fake.forgetResult = true;
  configured();
});

describe('Settings: Disconnect this profile', () => {
  it('runs the steps in order: notice, forget, socket, watch tab, alarms, then storage', async () => {
    const res = await disconnectProfile();
    expect(calls).toEqual([
      'notice <b>Main Shop</b> was disconnected from this bot.',
      'forget',
      'socket.close',
      'watchTab.close',
      'alarms.clearAll',
      'storage.local.clear',
      'storage.session.clear',
      'setUninstallURL ',
    ]);
    expect(res).toEqual({ noticeSent: true, relayForgot: true, webhookDeleted: false });
  });

  it('leaves a clean first-run state: no token, no chat, a new accountId', async () => {
    await disconnectProfile();
    const s = await getLocal();
    expect(Object.keys(fake.areas.local!)).toEqual(['accountId']);
    expect(s.accountId).toMatch(/^[a-z0-9]{8}$/);
    expect(s.accountId).not.toBe(ME);
    expect(s.token).toBeUndefined();
    expect(s.chatId).toBeUndefined();
    expect(s.recentAlerts).toEqual([]);
    expect(s.removedAt).toBeUndefined();
    expect(removedNotice(s)).toBeNull();
    expect(fake.areas.session).toEqual({});
  });

  it('still clears this profile when Telegram or the relay fails', async () => {
    fake.noticeFails = true;
    fake.forgetResult = false;
    const res = await disconnectProfile();
    expect(res).toEqual({ noticeSent: false, relayForgot: false, webhookDeleted: false });
    expect(calls.slice(-3)).toEqual(['storage.local.clear', 'storage.session.clear', 'setUninstallURL ']);
    expect((await getLocal()).token).toBeUndefined();
  });
});

describe('Settings: deleteWebhook only for the last account', () => {
  it('the last account on the bot: deleteWebhook, before storage is cleared (it needs the token)', async () => {
    fake.presence = [acct(ME)];
    const res = await disconnectProfile();
    expect(res.webhookDeleted).toBe(true);
    expect(calls.indexOf('deleteWebhook')).toBeGreaterThan(calls.indexOf('alarms.clearAll'));
    expect(calls.indexOf('deleteWebhook')).toBeLessThan(calls.indexOf('storage.local.clear'));
  });

  it('another account, even offline: the webhook stays', async () => {
    fake.presence = [acct(ME), acct('acc0two2', false)];
    await disconnectProfile();
    expect(calls).not.toContain('deleteWebhook');
  });

  it('no account list (relay never reached): the webhook stays', async () => {
    fake.presence = [];
    await disconnectProfile();
    expect(calls).not.toContain('deleteWebhook');
  });

  it('isLastAccount', () => {
    expect(isLastAccount([acct(ME)], ME)).toBe(true);
    expect(isLastAccount([acct(ME), acct('x', false)], ME)).toBe(false);
    expect(isLastAccount([], ME)).toBe(false);
    expect(isLastAccount([acct(ME)], undefined)).toBe(false);
  });
});

describe('removed from somewhere else (relay "removed")', () => {
  it('stops, clears, never sends a notice itself, and leaves the popup notice', async () => {
    await onRemovedRemotely();
    expect(calls).toEqual(['socket.close', 'watchTab.close', 'alarms.clearAll', 'storage.local.clear', 'storage.session.clear', 'setUninstallURL ']);
    const s = await getLocal();
    expect(s.token).toBeUndefined();
    expect(s.botKey).toBeUndefined();
    expect(s.accountId).not.toBe(ME);
    expect(typeof s.removedAt).toBe('number');
    expect(removedNotice(s)).toBe(REMOVED_NOTICE);
    expect(REMOVED_NOTICE).toBe('This profile was removed from the bot. Set it up again to use it.');
  });

  it('runs once when the "removed" frame and the 4010 close both arrive', async () => {
    await Promise.all([onRemovedRemotely(), onRemovedRemotely()]);
    expect(calls.filter((c) => c === 'storage.local.clear')).toHaveLength(1);
  });

  it('the notice goes away once the profile is set up again', () => {
    expect(removedNotice({ ...fake.areas.local, removedAt: 1 } as never)).toBeNull(); // configured
  });
});

describe('uninstall URL', () => {
  it('holds the relay /bye route, botKey, accountId and removal code, never the token or the secret', async () => {
    const url = await applyUninstallUrl();
    expect(calls).toEqual([`setUninstallURL ${url}`]);
    const u = new URL(url!);
    expect(`${u.origin}${u.pathname}`).toBe(`${DEFAULT_RELAY_URL}/bye/${BOT_KEY}`);
    expect([...u.searchParams.keys()]).toEqual(['accountId', 'code']);
    expect(u.searchParams.get('accountId')).toBe(ME);
    expect(u.searchParams.get('code')).toBe(CODE);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain(TOKEN.split(':')[1]);
    expect(url).not.toContain(SECRET);
  });

  it('is under Chrome\'s limit (1023), and under the old 255 with the default relay', async () => {
    const url = (await applyUninstallUrl())!;
    expect(MAX_UNINSTALL_URL_CHARS).toBe(1023);
    expect(url.length).toBeLessThanOrEqual(255);
    // The longest accountId the relay accepts still fits.
    expect(uninstallUrl(DEFAULT_RELAY_URL, BOT_KEY, 'a'.repeat(64), CODE)!.length).toBeLessThan(MAX_UNINSTALL_URL_CHARS);
    // A relay URL so long that Chrome would refuse the call: none is set.
    expect(uninstallUrl(`https://example.test/${'x'.repeat(900)}`, BOT_KEY, ME, CODE)).toBeNull();
  });

  it('is cleared when there is no removal code or no relay key', async () => {
    configured({ removalCode: undefined });
    delete fake.areas.local!.removalCode;
    expect(await applyUninstallUrl()).toBeNull();
    expect(calls).toEqual(['setUninstallURL ']);
  });

  it('setup makes the removal code before the relay auth, then sets the URL', async () => {
    configured();
    delete fake.areas.local!.removalCode;
    delete fake.areas.local!.webhookUrl;
    await connectAndRegisterWebhook();
    const code = fake.areas.local!.removalCode as string;
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]).toBe('connect (removalCode set)');
    expect(calls).toContain('setWebhook');
    expect(calls.at(-1)).toBe(`setUninstallURL ${DEFAULT_RELAY_URL}/bye/${BOT_KEY}?accountId=${ME}&code=${code}`);
  });
});
