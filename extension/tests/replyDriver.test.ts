/**
 * The background driver with a fake page: what it does when the page does
 * not answer, when the profile is removed mid-send, and that it never sends
 * twice. Made-up names and text.
 */
import { describe, expect, it } from 'vitest';
import type { ComposeRequest, ComposeResponse } from '../src/content/composer';
import { CONFIRM_TIMEOUT_MS, driveReply, type DriverPage } from '../src/background/replyDriver';

const BUYER = 'test_buyer_one';
const TEXT = 'Hello, the files are ready.';

function fakePage(answer: (m: ComposeRequest) => ComposeResponse | null) {
  const asked: ComposeRequest[] = [];
  const page: DriverPage = {
    prepare: async (m) => (asked.push(m), answer(m) ?? { ok: true }),
    ask: async (m) => (asked.push(m), answer(m)),
  };
  return { page, asked, types: () => asked.map((m) => m.type) };
}
let clock = 0;
const hooks = (extra = {}) => ({ plan: (t: string) => [{ delayMs: 0, text: t.slice(0, 10) }, { delayMs: 0, text: t.slice(10) }], sleep: async (ms: number) => void (clock += ms), now: () => clock, ...extra });

describe('driveReply', () => {
  it('sent: prepare, type, one send, results until the message shows and stays', async () => {
    let polls = 0;
    const f = fakePage((m) => (m.type === 'compose:result' ? (++polls >= 2 ? { ok: true, result: 'sent', messageId: 'x' } : { ok: true, result: 'pending' }) : m.type === 'compose:send' ? { ok: true, baseline: [], warningsBefore: [] } : { ok: true }));
    const out = await driveReply(f.page, BUYER, TEXT, 'me', hooks());
    expect(out.state).toBe('sent');
    expect(f.types().filter((t) => t === 'compose:send')).toHaveLength(1);
    expect(f.types().slice(0, 4)).toEqual(['compose:prepare', 'compose:type', 'compose:type', 'compose:send']);
  });

  it('no answer to the send step: unknown, and no second send', async () => {
    const f = fakePage((m) => (m.type === 'compose:send' ? null : { ok: true }));
    const out = await driveReply(f.page, BUYER, TEXT, 'me', hooks());
    expect(out).toEqual({ state: 'unknown', reason: 'the Fiverr page did not answer when Send was pressed.' });
    expect(f.types().filter((t) => t === 'compose:send')).toHaveLength(1);
  });

  it('the page stops answering while typing: Not sent (no click happened)', async () => {
    const f = fakePage((m) => (m.type === 'compose:type' ? null : { ok: true }));
    const out = await driveReply(f.page, BUYER, TEXT, 'me', hooks());
    expect(out.state).toBe('failed');
    expect(f.types()).not.toContain('compose:send');
  });

  it('the conversation did not load: Not sent', async () => {
    const page: DriverPage = { prepare: async () => { throw new Error('timeout'); }, ask: async () => ({ ok: true }) };
    expect(await driveReply(page, BUYER, TEXT, 'me', hooks())).toEqual({ state: 'failed', reason: 'the conversation did not load (timeout).' });
  });

  it('text over the box maxlength: Not sent before typing', async () => {
    const f = fakePage((m) => (m.type === 'compose:prepare' ? { ok: true, maxLength: 10 } : { ok: true }));
    expect(await driveReply(f.page, BUYER, TEXT, 'me', hooks())).toMatchObject({ state: 'failed' });
    expect(f.types()).toEqual(['compose:prepare']);
  });

  it('profile removed during typing: stops, clears its own text, no click', async () => {
    let removed = false;
    const f = fakePage((m) => {
      if (m.type === 'compose:type') removed = true;
      return { ok: true };
    });
    const out = await driveReply(f.page, BUYER, TEXT, 'me', hooks({ aborted: () => removed }));
    expect(out).toEqual({ state: 'failed', reason: 'this profile was disconnected during the send.' });
    expect(f.types()).toEqual(['compose:prepare', 'compose:type', 'compose:clear']);
  });

  it('no result within the limit: unknown after about 20 s, one send', async () => {
    clock = 0;
    const f = fakePage((m) => (m.type === 'compose:result' ? { ok: true, result: 'pending' } : m.type === 'compose:send' ? { ok: true, baseline: [], warningsBefore: [] } : { ok: true }));
    const out = await driveReply(f.page, BUYER, TEXT, 'me', hooks());
    expect(out.state).toBe('unknown');
    expect(clock).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
    expect(f.types().filter((t) => t === 'compose:send')).toHaveLength(1);
  });
});
