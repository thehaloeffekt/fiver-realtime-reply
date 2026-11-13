import { describe, expect, it } from 'vitest';
import { DEDUPE_WINDOW_MS, Deduper, RecentIds, dedupeKey } from '../src/lib/dedupe';

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
