/**
 * Background side of items 1–4: one alert per message across the thread,
 * toast and list detectors; no alert while the conversation is in view;
 * and when the watch tab returns to /inbox. Storage, sending and the
 * tab/window check are fakes. All names are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalState } from '../src/lib/storage';

const state: { local: LocalState } = {} as never;
const sent: Array<{ html: string }> = [];
const view = vi.hoisted(() => ({ inView: new Set<string>() }));

vi.mock('../src/lib/storage', async (orig) => {
  const actual = await orig<typeof import('../src/lib/storage')>();
  return {
    ...actual,
    getLocal: async () => structuredClone(state.local),
    getSession: async () => ({ dedupe: [], presence: [], relay: { phase: 'idle', attempts: 0 }, telegram: {} }),
    setSession: async () => undefined,
    setLocal: async (p: Partial<LocalState>) => void Object.assign(state.local, p),
    updateLocal: async (k: keyof LocalState, fn: (v: unknown) => unknown) => void ((state.local as unknown as Record<string, unknown>)[k] = fn(state.local[k])),
  };
});
vi.mock('../src/background/notify', () => ({ notify: vi.fn(async (html: string) => void sent.push({ html })) }));
vi.mock('../src/background/view', () => ({ conversationInView: async (u: string) => view.inView.has(u.toLowerCase()) }));

const { handleListMessage, handleThreadMessage, handleToast } = await import('../src/background/alerts');
const { DEFAULT_SETTINGS } = await import('../src/lib/storage');
const { OFF_INBOX_MS, restDecision } = await import('../src/background/listSync');

let n = 0;
/** A fresh buyer per test: the dedupe table is shared by the module. */
let buyer = '';
beforeEach(() => {
  buyer = `buyer_${++n}`;
  view.inView.clear();
  sent.length = 0;
  state.local = {
    relayUrl: '', token: 't', chatId: 1, accountId: 'acc1', botKey: 'k', secret: 's', label: 'Main',
    settings: { ...DEFAULT_SETTINGS }, recentAlerts: [], seenUpdateIds: [], pendingClaims: [], captures: {}, knownUsers: {}, buyerZones: {}, diagnostics: [],
  };
});

const thread = (o: { id?: string; text?: string; files?: string[] } = {}) =>
  handleThreadMessage({ username: buyer, displayName: 'Some Buyer', id: o.id ?? `00000000-0000-4000-8000-000000000000_${n}aaaaaaa-0000-1000-8000-000000000000`, sentAt: 0, text: o.text ?? 'are you there?', files: o.files ?? [] });
const toast = (body: string, replay = false) => handleToast({ id: 'x', username: buyer, displayName: 'Some Buyer', body, replay } as never);

describe('thread detector alerts', () => {
  it('a message alerts once; the replayed toast for it (tab brought to the front) does not alert again', async () => {
    await thread({ text: 'are you there?' });
    await toast('are you there?', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain(`(@${buyer})`);
    expect(sent[0]!.html).toContain('are you there?');
  });

  it('a file-only message reads "[file: name]", and the toast "1 File" for it is the same message', async () => {
    await thread({ text: '', files: ['website.zip'] });
    await toast('1 File', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('[file: website.zip]');
  });

  it('text with a file: the alert names the file; the toast (text only) is the same message', async () => {
    await thread({ text: 'see the attached sketch', files: ['logo-draft.png'] });
    await toast('see the attached sketch');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('see the attached sketch [file: logo-draft.png]');
  });

  it('the same message id from two tabs alerts once, even after the 20 s window', async () => {
    const id = '00000000-0000-4000-8000-000000000000_bbbbbbbb-0000-1000-8000-000000000000';
    await thread({ id, text: 'one' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    await thread({ id, text: 'one' });
    vi.useRealTimers();
    expect(sent).toHaveLength(1);
  });

  it('no alert while the conversation is in view in some tab', async () => {
    view.inView.add(buyer);
    await thread({ text: 'hello' });
    expect(sent).toEqual([]);
  });

  it('respects "Attachment alerts" off for a file-only message', async () => {
    state.local.settings.attachmentAlerts = false;
    await thread({ text: '', files: ['plan.pdf'] });
    expect(sent).toEqual([]);
  });
});

describe('thread alert: buyer time follows My time zone', () => {
  // 00:30 UTC on Nov 16: Nov 16, 1:30 AM in Lagos; Nov 15, 7:30 PM for a buyer at UTC-5.
  const NOW = Date.parse('2026-11-16T00:30:00Z');
  const alertAt = async (myTimeZone: string, text: string, id: string) => {
    state.local.settings = { ...DEFAULT_SETTINGS, myTimeZone };
    state.local.buyerZones = { [buyer]: { offset: -300, at: NOW } };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      await thread({ text, id });
    } finally {
      vi.useRealTimers();
    }
    return sent.at(-1)!.html.split('\n').at(-1);
  };

  it('the buyer\'s day is compared with my day in the selected zone, not the browser zone', async () => {
    expect(await alertAt('Africa/Lagos', 'first', '00000000-0000-4000-8000-000000000000_c1aaaaaa-0000-1000-8000-000000000000')).toBe('Buyer time: Nov 15, 7:30 PM');
    expect(await alertAt('America/Bogota', 'second', '00000000-0000-4000-8000-000000000000_c2aaaaaa-0000-1000-8000-000000000000')).toBe('Buyer time: 7:30 PM');
  });
});

describe('list rows read at once (item 4)', () => {
  const read = (body: string) => handleListMessage({ username: buyer, displayName: 'Some Buyer', body, count: 1, read: true });

  it('alerts when nobody looks at the conversation', async () => {
    await read('answer read at once');
    expect(sent).toHaveLength(1);
  });

  it('no alert while the conversation is in view', async () => {
    view.inView.add(buyer);
    await read('answer read at once');
    expect(sent).toEqual([]);
  });

  it('after the thread alert for the same message, even minutes later (after a reload): one alert', async () => {
    await thread({ text: 'answer read at once' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    await read('answer read at once');
    vi.useRealTimers();
    expect(sent).toHaveLength(1);
  });
});

describe('item 3: the watch tab rests on /inbox', () => {
  const now = 1_000_000;
  it('waits while a conversation is open and hidden, returns after 60 s', () => {
    expect(restDecision({ path: '/inbox/some_buyer', busy: false, hidden: true, since: undefined, now })).toEqual({ action: 'wait', since: now });
    expect(restDecision({ path: '/inbox/some_buyer', busy: false, hidden: true, since: now - OFF_INBOX_MS + 1, now })).toMatchObject({ action: 'wait' });
    expect(restDecision({ path: '/inbox/some_buyer', busy: false, hidden: true, since: now - OFF_INBOX_MS, now })).toEqual({ action: 'return' });
  });

  it('leaves it alone on /inbox, during "Full message", and while the user can see it', () => {
    expect(restDecision({ path: '/inbox', busy: false, hidden: true, since: now - 10 * OFF_INBOX_MS, now })).toEqual({ action: 'none' });
    expect(restDecision({ path: '/inbox/some_buyer', busy: true, hidden: true, since: now - 10 * OFF_INBOX_MS, now })).toEqual({ action: 'none' });
    expect(restDecision({ path: '/inbox/some_buyer', busy: false, hidden: false, since: now - 10 * OFF_INBOX_MS, now })).toEqual({ action: 'none' });
  });
});
