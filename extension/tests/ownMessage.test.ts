/**
 * A reply this profile sent from Telegram must not come back as an alert:
 * expectOwnMessage (called right before the click on Send) keeps the thread,
 * list and toast detectors quiet for that buyer and text. Storage, sending
 * and the tab check are fakes, as in threadAlerts.test.ts. All names are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalState } from '../src/lib/storage';

const state: { local: LocalState } = {} as never;
const sent: Array<{ html: string }> = [];

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
vi.mock('../src/background/view', () => ({ conversationInView: async () => false }));

const { OWN_MESSAGE_WINDOW_MS, expectOwnMessage, handleListMessage, handleThreadMessage, handleToast } = await import('../src/background/alerts');
const { DEFAULT_SETTINGS } = await import('../src/lib/storage');

const MINE = 'Hello, the files are ready.';
let n = 0;
/** A fresh buyer per test: the dedupe table and the own-message list are shared by the module. */
let buyer = '';
let other = '';
beforeEach(() => {
  n++;
  buyer = `test_buyer_${n}a`;
  other = `test_buyer_${n}b`;
  sent.length = 0;
  state.local = {
    relayUrl: '', token: 't', chatId: 1, accountId: 'acc-a', botKey: 'k', secret: 's', label: 'Main',
    settings: { ...DEFAULT_SETTINGS }, recentAlerts: [], seenUpdateIds: [], pendingClaims: [], captures: {}, knownUsers: {}, buyerZones: {}, diagnostics: [],
  };
});

let ids = 0;
const thread = (username: string, text: string) =>
  handleThreadMessage({ username, displayName: 'Test Buyer', id: `00000000-0000-4000-8000-000000000000_${String(++ids).padStart(8, '0')}-0000-1000-8000-000000000000`, sentAt: 0, text, files: [] });
const list = (username: string, body: string) => handleListMessage({ username, displayName: 'Test Buyer', body, count: 1 });
const toast = (username: string, body: string) => handleToast({ id: 'x', username, displayName: 'Test Buyer', body } as never);

describe('own messages sent from Telegram do not alert', () => {
  it('thread: the same buyer and text is quiet; another text alerts', async () => {
    await expectOwnMessage(buyer, MINE);
    await thread(buyer, MINE);
    expect(sent).toEqual([]);
    await thread(buyer, 'Can you also send the source files?');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('Can you also send the source files?');
  });

  it('list row: the same buyer and text is quiet; another text alerts', async () => {
    await expectOwnMessage(buyer, MINE);
    await list(buyer, MINE);
    expect(sent).toEqual([]);
    await list(buyer, 'Thanks, I will check them tonight.');
    expect(sent).toHaveLength(1);
  });

  it('toast: the same buyer and text is quiet; another text alerts', async () => {
    await expectOwnMessage(buyer, MINE);
    await toast(buyer, MINE);
    expect(sent).toEqual([]);
    await toast(buyer, 'One more question about the colors.');
    expect(sent).toHaveLength(1);
  });

  it('another buyer with the same text alerts (thread, list and toast)', async () => {
    await expectOwnMessage(buyer, MINE);
    await thread(other, MINE);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain(`(@${other})`);

    const third = `${other}_c`;
    await list(third, MINE);
    expect(sent).toHaveLength(2);

    const fourth = `${other}_d`;
    await toast(fourth, MINE);
    expect(sent).toHaveLength(3);
  });

  it('the username matches without case', async () => {
    await expectOwnMessage(buyer.toUpperCase(), MINE);
    await thread(buyer, MINE);
    expect(sent).toEqual([]);
  });

  it('after the window, the same text from the buyer alerts again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-11-20T09:00:00Z');
      vi.setSystemTime(t0);
      await expectOwnMessage(buyer, MINE);
      vi.setSystemTime(t0 + OWN_MESSAGE_WINDOW_MS + 1);
      await thread(buyer, MINE);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
