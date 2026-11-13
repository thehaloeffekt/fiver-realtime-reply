/**
 * WebSocket connection to fta-relay (see the root README for the protocol).
 *
 * The relay only carries Telegram updates *to* the extension (button presses
 * and commands). Alerts never go through it, so everything here may fail
 * without stopping alerts.
 */
import { RecentIds } from '../lib/dedupe';
import { relayWsBase } from '../lib/keys';
import { getLocal, getSession, labelOf, setLocal, setSession, updateLocal, updateSession, type PresenceAccount, type RelayStatus } from '../lib/storage';

export const PING_INTERVAL_MS = 20_000;
/** No frame (not even "pong") for this long means the socket is dead. */
const DEAD_AFTER_MS = 65_000;
const READY_TIMEOUT_MS = 10_000;
/** Delay before reconnect attempt n (1-based). The minute alarm picks these up. */
const BACKOFF_MS = [3_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
/** Close codes from the relay (README "Close codes"). */
const CLOSE_AUTH_FAILED = 4003;
const CLOSE_REPLACED = 4009;

export interface RelayHandlers {
  onUpdate(update: Record<string, unknown>, routed: boolean): void;
  onOffline(accountId: string, label: string): void;
}

let handlers: RelayHandlers | null = null;
let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let quickRetry: ReturnType<typeof setTimeout> | undefined;
let lastFrameAt = 0;
/** True between the relay's "ready" frame and the socket closing. */
let isReadyNow = false;
let readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

let recentIds: RecentIds | null = null;
async function ids(): Promise<RecentIds> {
  if (!recentIds) recentIds = new RecentIds((await getLocal()).seenUpdateIds, 200);
  return recentIds;
}

export function setRelayHandlers(h: RelayHandlers) {
  handlers = h;
}

export function isRelayOpen(): boolean {
  return ws?.readyState === WebSocket.OPEN && lastFrameAt > 0;
}

function setStatus(patch: Partial<RelayStatus>) {
  return updateSession('relay', (relay) => ({ ...relay, ...patch }));
}

function backoffFor(attempts: number, code?: number): number {
  if (code === CLOSE_AUTH_FAILED) return 30 * 60_000;
  if (code === CLOSE_REPLACED) return 5 * 60_000;
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

/**
 * Opens the socket if it is not open. Resolves after the relay's "ready"
 * frame, rejects on close or after 10 s. With `force`, an open socket is
 * replaced (used after the token, relay URL or label changed).
 */
export async function connectRelay(force = false): Promise<void> {
  const s = await getLocal();
  if (!s.botKey || !s.secret || !s.accountId) {
    await setStatus({ phase: 'idle', lastError: undefined });
    return;
  }
  if (ws && !force) {
    if (ws.readyState === WebSocket.OPEN && isReadyNow) return;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) return waitReady();
  }
  if (ws) closeSocket(1000, 'reconnect');

  clearTimeout(quickRetry);
  const url = `${relayWsBase(s.relayUrl)}/ws/${s.botKey}?accountId=${encodeURIComponent(s.accountId)}`;
  await setStatus({ phase: 'connecting', since: Date.now(), nextAttemptAt: undefined });

  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    await onClosed(undefined, String(e));
    throw e;
  }
  ws = socket;
  isReadyNow = false;
  lastFrameAt = 0;
  const auth = JSON.stringify({ type: 'auth', secret: s.secret, accountId: s.accountId, label: labelOf(s).slice(0, 64) });

  socket.onopen = () => {
    // The auth frame must be first, within 5 s. accountId equals the one in the URL.
    socket.send(auth);
    clearInterval(pingTimer);
    // Plain-text "ping": the relay runtime answers "pong" without waking the
    // Durable Object. The traffic also keeps this service worker alive.
    pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (lastFrameAt && Date.now() - lastFrameAt > DEAD_AFTER_MS) {
        socket.close(4000, 'no pong');
        return;
      }
      socket.send('ping');
    }, PING_INTERVAL_MS);
  };
  socket.onmessage = (ev) => {
    if (socket !== ws) return;
    lastFrameAt = Date.now();
    if (typeof ev.data !== 'string' || ev.data === 'pong') return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    void onFrame(socket, frame);
  };
  socket.onclose = (ev) => {
    if (socket !== ws) return;
    void onClosed(ev.code, ev.reason);
  };

  return waitReady();
}

function waitReady(): Promise<void> {
  if (isReadyNow) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    readyWaiters.push(entry);
    setTimeout(() => {
      if (!readyWaiters.includes(entry)) return;
      readyWaiters = readyWaiters.filter((w) => w !== entry);
      reject(new Error('The relay did not answer in 10 seconds.'));
    }, READY_TIMEOUT_MS);
  });
}

function settleWaiters(err?: Error) {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const w of waiters) err ? w.reject(err) : w.resolve();
}

async function onFrame(socket: WebSocket, frame: Record<string, unknown>) {
  switch (frame.type) {
    case 'ready': {
      isReadyNow = true;
      await setStatus({ phase: 'connected', since: Date.now(), attempts: 0, lastError: undefined, closeCode: undefined, nextAttemptAt: undefined });
      if (Array.isArray(frame.accounts)) await setSession({ presence: frame.accounts as PresenceAccount[] });
      settleWaiters();
      await flushClaims();
      return;
    }
    case 'update': {
      const id = frame.id;
      if (typeof id !== 'number') return;
      // Ack first: the relay buffers at most 50 updates per bot, and slow work
      // (a tab reload) must not hold one of those slots.
      socket.send(JSON.stringify({ type: 'ack', ids: [id] }));
      const recent = await ids();
      if (!recent.add(id)) return; // replayed update we already handled
      void setLocal({ seenUpdateIds: recent.toArray() });
      const update = frame.update;
      if (update && typeof update === 'object') handlers?.onUpdate(update as Record<string, unknown>, frame.routed === true);
      return;
    }
    case 'presence':
      if (Array.isArray(frame.accounts)) await setSession({ presence: frame.accounts as PresenceAccount[] });
      return;
    case 'offline':
      handlers?.onOffline(String(frame.accountId ?? ''), String(frame.label ?? ''));
      return;
    case 'error':
      console.warn('[relay] error frame', frame);
      return;
  }
}

async function onClosed(code: number | undefined, reason: string) {
  clearInterval(pingTimer);
  ws = null;
  isReadyNow = false;

  let lastError: string | undefined = reason || undefined;
  if (code === CLOSE_AUTH_FAILED) lastError = 'The relay rejected this bot (wrong secret). Check the bot token.';
  if (code === CLOSE_REPLACED) lastError = 'Another browser profile uses the same account id.';
  settleWaiters(new Error(lastError ?? `Relay connection closed (${code ?? 'error'}).`));

  let delay = 0;
  await updateSession('relay', (relay) => {
    const attempts = relay.attempts + 1;
    delay = backoffFor(attempts, code);
    return { ...relay, phase: 'offline', since: Date.now(), closeCode: code, lastError, attempts, nextAttemptAt: Date.now() + delay };
  });
  // Short delays run on a timer while the worker is alive; the minute alarm
  // (relayHeartbeat) covers the longer ones and a worker that was stopped.
  if (delay < 60_000) quickRetry = setTimeout(() => void connectRelay().catch(() => {}), delay);
}

/** Closes the socket on purpose: its handlers are removed first, so no retry is scheduled. */
function closeSocket(code: number, reason: string) {
  clearInterval(pingTimer);
  const old = ws;
  ws = null;
  isReadyNow = false;
  if (!old) return;
  old.onopen = old.onmessage = old.onclose = null;
  try {
    old.close(code, reason);
  } catch {
    // already closed
  }
}

/** Closes the socket and does not reconnect (Disconnect this profile). */
export async function disconnectRelay() {
  clearTimeout(quickRetry);
  closeSocket(1000, 'disconnect');
  settleWaiters(new Error('Disconnected.'));
  await setSession({ relay: { phase: 'idle', attempts: 0 }, presence: [] });
}

/** Runs from the one-minute alarm: reconnects when the backoff time has passed. */
export async function relayHeartbeat(): Promise<void> {
  if (ws) return;
  const { relay } = await getSession();
  if (relay.nextAttemptAt && Date.now() < relay.nextAttemptAt) return;
  await connectRelay().catch(() => {});
}

/** Retry button: skip the backoff. */
export async function retryRelayNow(): Promise<void> {
  await setStatus({ attempts: 0, nextAttemptAt: undefined });
  await connectRelay(true);
}

/** "I sent this message": replies and button presses on it come to this profile. */
export async function claim(chatId: number, messageId: number): Promise<void> {
  if (ws && isReadyNow) {
    ws.send(JSON.stringify({ type: 'claim', chatId, messageId }));
    return;
  }
  await updateLocal('pendingClaims', (list) => [...list, { chatId, messageId }].slice(-100));
}

async function flushClaims() {
  const socket = ws;
  if (!socket) return;
  await updateLocal('pendingClaims', (list) => {
    if (list.length) socket.send(JSON.stringify({ type: 'claim', items: list.slice(-100) }));
    return [];
  });
}
