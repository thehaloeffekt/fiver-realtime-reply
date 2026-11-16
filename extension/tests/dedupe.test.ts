import { describe, expect, it } from 'vitest';
import { DEDUPE_WINDOW_MS, Deduper, REPLAY_WINDOW_MS, RecentIds, SenderGate, dedupeKey } from '../src/lib/dedupe';

const key = dedupeKey('acc12345', 'inbox_1_2', 'Hello');

describe('Deduper (20 s window)', () => {
  it('drops the same key inside 20 seconds', () => {
    const d = new Deduper();
    expect(d.take(key, 0)).toBe(true);
    expect(d.take(key, 1)).toBe(false); // second tab, same tick
    expect(d.take(key, 19_999)).toBe(false);
  });

  it('lets the same text through again after 20 seconds', () => {
    const d = new Deduper();
    expect(d.take(key, 0)).toBe(true);
    expect(d.take(key, DEDUPE_WINDOW_MS)).toBe(true);
  });

  it('measures the window from the alert that was sent, not from dropped copies', () => {
    const d = new Deduper();
    d.take(key, 0);
    d.take(key, 15_000); // dropped, does not extend
    expect(d.take(key, 20_000)).toBe(true);
  });

  it('treats a different body, conversation or account as a new alert', () => {
    const d = new Deduper();
    d.take(key, 0);
    expect(d.take(dedupeKey('acc12345', 'inbox_1_2', 'Hello again'), 1)).toBe(true);
    expect(d.take(dedupeKey('acc12345', 'inbox_9_9', 'Hello'), 1)).toBe(true);
    expect(d.take(dedupeKey('other123', 'inbox_1_2', 'Hello'), 1)).toBe(true);
  });

  it('a reused <li> with new text is a new key', () => {
    const d = new Deduper();
    d.take(dedupeKey('a', 'inbox_1_2', 'first'), 0);
    expect(d.take(dedupeKey('a', 'inbox_1_2', 'second'), 500)).toBe(true);
  });

  it('keys cannot collide by moving text between fields', () => {
    expect(dedupeKey('a', 'b c', 'd')).not.toBe(dedupeKey('a', 'b', 'c d'));
  });

  it('release lets a retry through after a failed send', () => {
    const d = new Deduper();
    d.take(key, 0);
    d.release(key, 0);
    expect(d.take(key, 1)).toBe(true);
  });

  it('release does not remove a newer entry', () => {
    const d = new Deduper();
    d.take(key, 0);
    d.take(key, 25_000);
    d.release(key, 0);
    expect(d.take(key, 26_000)).toBe(false);
  });

  it('survives a worker restart through entries/load', () => {
    const a = new Deduper();
    a.take(key, 1_000);
    const b = new Deduper();
    b.load(a.entries(), 5_000);
    expect(b.take(key, 5_000)).toBe(false);
    const c = new Deduper();
    c.load(a.entries(), 30_000); // expired entries are not loaded
    expect(c.take(key, 30_000)).toBe(true);
  });
});

describe('RecentIds (update_id replay guard)', () => {
  it('reports repeats', () => {
    const r = new RecentIds();
    expect(r.add(10)).toBe(true);
    expect(r.add(10)).toBe(false);
  });

  it('keeps only the last 200 ids', () => {
    const r = new RecentIds();
    for (let i = 0; i < 201; i++) r.add(i);
    expect(r.toArray()).toHaveLength(200);
    expect(r.add(0)).toBe(true); // forgotten
    expect(r.add(200)).toBe(false);
  });

  it('restores from storage', () => {
    const r = new RecentIds([1, 2, 3]);
    expect(r.add(2)).toBe(false);
  });
});

describe('key: account + sender + body (toast and inbox list must agree)', () => {
  it('ignores case and spacing in the sender, and spacing in the body', () => {
    // Toast: direct text nodes joined without separators. List: pieces joined with spaces.
    expect(dedupeKey('acc', 'Buyer One', "Good, any news")).toBe(dedupeKey('acc', ' buyer  one ', 'good,  any  news'));
  });

  it('matches a long message to a cut list preview', () => {
    const long = 'Hi Mike, Milestone 4A is now completed! I have implemented the three redemption experiences';
    expect(dedupeKey('acc', 'Mike', long)).toBe(dedupeKey('acc', 'Mike', `${long.slice(0, 70)}…`));
  });

  it('keeps different senders, bodies and accounts apart', () => {
    const k = dedupeKey('acc', 'Bob', 'Hello');
    expect(dedupeKey('acc', 'Rob', 'Hello')).not.toBe(k);
    expect(dedupeKey('acc', 'Bob', 'Hello there')).not.toBe(k);
    expect(dedupeKey('acc2', 'Bob', 'Hello')).not.toBe(k);
  });
});

describe('replayed toasts (longer window)', () => {
  const k = dedupeKey('acc', 'Buyer One', 'Did you receive it?');

  it('drops a replay of a message the list already alerted 8 minutes ago', () => {
    const d = new Deduper(DEDUPE_WINDOW_MS, REPLAY_WINDOW_MS);
    expect(d.take(k, 0)).toBe(true); // list, 16:36:38
    expect(d.take(k, 8 * 60_000, REPLAY_WINDOW_MS)).toBe(false); // replayed toast, 16:44:38
  });

  it('still sends a replay nobody alerted (better late than never)', () => {
    const d = new Deduper(DEDUPE_WINDOW_MS, REPLAY_WINDOW_MS);
    expect(d.take(k, 8 * 60_000, REPLAY_WINDOW_MS)).toBe(true);
  });

  it('keeps the 20 s rule for normal toasts: the same text 10 minutes later alerts again', () => {
    const d = new Deduper(DEDUPE_WINDOW_MS, REPLAY_WINDOW_MS);
    expect(d.take(k, 0)).toBe(true);
    expect(d.take(k, 10 * 60_000)).toBe(true);
  });

  it('survives a worker restart with the long window', () => {
    const a = new Deduper(DEDUPE_WINDOW_MS, REPLAY_WINDOW_MS);
    a.take(k, 0);
    const b = new Deduper(DEDUPE_WINDOW_MS, REPLAY_WINDOW_MS);
    b.load(a.entries(), 60 * 60_000);
    expect(b.take(k, 60 * 60_000, REPLAY_WINDOW_MS)).toBe(false);
  });
});

describe('SenderGate (files look different in toast and list)', () => {
  it('drops the other source for the same sender when one of them is not plain text', () => {
    const g = new SenderGate();
    expect(g.take('bob', 'toast', false, 0)).toBe(true); // "1 File"
    expect(g.take('bob', 'list', true, 1000)).toBe(false); // list preview of the file
  });

  it('keeps two different text messages from the two sources', () => {
    const g = new SenderGate();
    expect(g.take('bob', 'toast', true, 0)).toBe(true);
    expect(g.take('bob', 'list', true, 1000)).toBe(true);
  });

  it('keeps several messages from the same source, and other senders', () => {
    const g = new SenderGate();
    expect(g.take('bob', 'list', true, 0)).toBe(true);
    expect(g.take('bob', 'list', false, 1000)).toBe(true);
    expect(g.take('ann', 'toast', false, 1000)).toBe(true);
  });

  it('forgets after the window', () => {
    const g = new SenderGate();
    g.take('bob', 'toast', false, 0);
    expect(g.take('bob', 'list', false, DEDUPE_WINDOW_MS)).toBe(true);
  });
});
