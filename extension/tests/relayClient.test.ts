/**
 * The relay socket on the extension side: what auth sends, and how the
 * removal frames are handled. WebSocket and storage are fakes; ids are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalState, SessionState } from '../src/lib/storage';

const store = vi.hoisted(() => ({ local: {} as Record<string, unknown>, session: {} as Record<string, unknown> }));
vi.mock('../src/lib/storage', async (orig) => {
  const actual = await orig<typeof import('../src/lib/storage')>();
  return {
    ...actual,
    getLocal: async () => ({ settings: actual.DEFAULT_SETTINGS, seenUpdateIds: [], pendingClaims: [], ...structuredClone(store.local) }) as unknown as LocalState,
    getSession: async () => ({ relay: { phase: 'idle', attempts: 0 }, presence: [], ...structuredClone(store.session) }) as unknown as SessionState,
    setLocal: async (p: object) => void Object.assign(store.local, p),
    setSession: async (p: object) => void Object.assign(store.session, p),
    updateLocal: async (k: string, fn: (v: unknown) => unknown) => void (store.local[k] = fn(store.local[k] ?? [])),
    updateSession: async (k: string, fn: (v: unknown) => unknown) => void (store.session[k] = fn(store.session[k] ?? { phase: 'idle', attempts: 0 })),
  };
});

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  framesOfType(type: string) {
    return this.sent.filter((d) => d.startsWith('{')).map((d) => JSON.parse(d)).filter((f) => f.type === type);
  }
}
vi.stubGlobal('WebSocket', FakeSocket);

const relay = await import('../src/background/relay');
const { sha256Hex } = await import('../src/lib/keys');

const CODE = '5'.repeat(64);
const handlers = { onUpdate: vi.fn(), onOffline: vi.fn(), onAccountRemoved: vi.fn(), onRemoved: vi.fn() };
relay.setRelayHandlers(handlers);

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Opens a socket and answers with "ready". Returns the fake socket. */
async function connected(): Promise<FakeSocket> {
  const p = relay.connectRelay(true);
  await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.frame({ type: 'ready', accountId: 'acc0me01', accounts: [], updateTtlMs: 1 });
  await p;
  return ws;
}

beforeEach(async () => {
  await relay.disconnectRelay();
  FakeSocket.all.length = 0;
  for (const h of Object.values(handlers)) h.mockClear();
  store.local = { relayUrl: 'https://relay.example', botKey: 'b'.repeat(64), secret: 'e'.repeat(64), accountId: 'acc0me01', removalCode: CODE, label: 'Main' };
  store.session = {};
});

describe('auth', () => {
  it('sends the hash of the removal code, never the code', async () => {
    const ws = await connected();
    const auth = ws.framesOfType('auth')[0];
    expect(auth.removalCodeHash).toBe(await sha256Hex(CODE));
    expect(ws.sent.join('\n')).not.toContain(CODE);
  });
});

describe('removal frames', () => {
  it('"account_removed" goes to the handler that posts the Telegram notice', async () => {
    const ws = await connected();
    ws.frame({ type: 'account_removed', accountId: 'acc0two2', label: 'Spare' });
    await tick();
    expect(handlers.onAccountRemoved).toHaveBeenCalledWith('acc0two2', 'Spare');
  });

  it('"removed": this profile was removed elsewhere; clear, and never reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const ws = await connected();
      ws.frame({ type: 'removed' });
      await vi.advanceTimersByTimeAsync(0);
      // The 4010 close that follows changes nothing.
      ws.serverClose(relay.CLOSE_REMOVED);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(handlers.onRemoved).toHaveBeenCalledTimes(1);
      expect(FakeSocket.all).toHaveLength(1);
      expect(relay.isRelayOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close 4010 without the frame means the same, and schedules no retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const ws = await connected();
      ws.serverClose(relay.CLOSE_REMOVED);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(handlers.onRemoved).toHaveBeenCalledTimes(1);
      expect(FakeSocket.all).toHaveLength(1);
      expect((store.session.relay as { nextAttemptAt?: number } | undefined)?.nextAttemptAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgetSelf (Settings): sends forget for this account; the answer is not treated as news', async () => {
    const ws = await connected();
    const done = relay.forgetSelf();
    await vi.waitFor(() => expect(ws.framesOfType('forget')).toEqual([{ type: 'forget', accountId: 'acc0me01' }]));
    ws.frame({ type: 'removed' });
    expect(await done).toBe(true);
    expect(handlers.onRemoved).not.toHaveBeenCalled();
  });

  it('sendForget (/remove): sends forget for another account; false without a socket', async () => {
    const ws = await connected();
    expect(relay.sendForget('acc0two2')).toBe(true);
    expect(ws.framesOfType('forget')).toEqual([{ type: 'forget', accountId: 'acc0two2' }]);
    await relay.disconnectRelay();
    expect(relay.sendForget('acc0two2')).toBe(false);
  });
});
