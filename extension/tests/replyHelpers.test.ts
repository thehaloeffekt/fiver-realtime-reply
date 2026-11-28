/**
 * Helpers of "Send replies from Telegram": the /reply arguments, the buyer of
 * a Telegram message (recorded target or its buttons), and keeping reply
 * texts out of the diagnostics log. Chrome storage is an in-memory fake, so
 * the real src/lib/storage.ts runs. All names and texts are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  return { areas, area };
});

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: fake.area('local'), session: fake.area('session') },
    alarms: { create: async () => undefined, clear: async () => true, get: async () => undefined },
  },
}));

const { parseReplyArgs } = await import('../src/background/commands');
const { buyerFromKeyboard, rememberReplyTarget, replyTargetOf } = await import('../src/background/replyTargets');
const { redactReplies, replyProbe } = await import('../src/lib/diagnostics');
const { formatAlert } = await import('../src/lib/format');
const { INBOX_URL } = await import('../src/lib/constants');
type DiagEntry = import('../src/lib/diagnostics').DiagEntry;

beforeEach(() => {
  fake.areas.local = {};
  fake.areas.session = {};
  vi.useRealTimers();
});

describe('parseReplyArgs', () => {
  const LABELS = ['Main', 'Second'];

  it('buyer only: no label, empty text', () => {
    expect(parseReplyArgs('test_buyer_one', LABELS)).toEqual({ buyer: 'test_buyer_one', label: '', text: '' });
  });

  it('buyer and text', () => {
    expect(parseReplyArgs('test_buyer_one Hello there', LABELS)).toEqual({ buyer: 'test_buyer_one', label: '', text: 'Hello there' });
  });

  it('a leading @ is dropped from the buyer', () => {
    expect(parseReplyArgs('@test_buyer_one Hello there', LABELS)).toEqual({ buyer: 'test_buyer_one', label: '', text: 'Hello there' });
  });

  it('a label in another case matches, and the saved label is returned', () => {
    expect(parseReplyArgs('test_buyer_one mAIN Hello there', LABELS)).toEqual({ buyer: 'test_buyer_one', label: 'Main', text: 'Hello there' });
    expect(parseReplyArgs('test_buyer_one second Hello there', LABELS)).toEqual({ buyer: 'test_buyer_one', label: 'Second', text: 'Hello there' });
  });

  it('a label that is the start of a word is text, not a label', () => {
    expect(parseReplyArgs('test_buyer_one Mainly the files are ready.', LABELS)).toEqual({ buyer: 'test_buyer_one', label: '', text: 'Mainly the files are ready.' });
  });

  it('the label alone, with no text after it, is text', () => {
    expect(parseReplyArgs('test_buyer_one Main', LABELS)).toEqual({ buyer: 'test_buyer_one', label: '', text: 'Main' });
  });

  it('the longest matching label wins', () => {
    expect(parseReplyArgs('test_buyer_one Main Shop Hello there', ['Main', 'Main Shop'])).toEqual({ buyer: 'test_buyer_one', label: 'Main Shop', text: 'Hello there' });
    expect(parseReplyArgs('test_buyer_one Main Shopping is done', ['Main', 'Main Shop'])).toEqual({ buyer: 'test_buyer_one', label: 'Main', text: 'Shopping is done' });
  });

  it('line breaks in the text are kept, with or without a label', () => {
    expect(parseReplyArgs('test_buyer_one Line one\nLine two\n\nLine four', LABELS)).toEqual({ buyer: 'test_buyer_one', label: '', text: 'Line one\nLine two\n\nLine four' });
    expect(parseReplyArgs('test_buyer_one Main\nLine one\nLine two', LABELS)).toEqual({ buyer: 'test_buyer_one', label: 'Main', text: 'Line one\nLine two' });
  });

  it('no buyer: null', () => {
    expect(parseReplyArgs('', LABELS)).toBeNull();
    expect(parseReplyArgs('#not_a_name hello', LABELS)).toBeNull();
  });
});

describe('buyerFromKeyboard', () => {
  it('an alert keyboard of this account gives the buyer', () => {
    const { keyboard } = formatAlert('Main', { username: 'test_buyer_one', displayName: 'Test Buyer' }, 'Hello, the files are ready.', 'acc-a');
    expect(buyerFromKeyboard({ inline_keyboard: keyboard }, 'acc-a')).toBe('test_buyer_one');
  });

  it('the keyboard of another account: null', () => {
    const { keyboard } = formatAlert('Second', { username: 'test_buyer_one', displayName: 'Test Buyer' }, 'Hello, the files are ready.', 'acc-b');
    expect(buyerFromKeyboard({ inline_keyboard: keyboard }, 'acc-a')).toBeNull();
  });

  it('without a "Full message" button: the conversation link, when one button is mine', () => {
    const markup = { inline_keyboard: [[{ text: 'Open inbox', url: `${INBOX_URL}/test_buyer_one` }], [{ text: 'Check now', callback_data: 'c|acc-a|check|' }]] };
    expect(buyerFromKeyboard(markup, 'acc-a')).toBe('test_buyer_one');
    // The same link with only another account's button: not mine.
    const other = { inline_keyboard: [[{ text: 'Open inbox', url: `${INBOX_URL}/test_buyer_one` }], [{ text: 'Check now', callback_data: 'c|acc-b|check|' }]] };
    expect(buyerFromKeyboard(other, 'acc-a')).toBeNull();
  });

  it('no keyboard, or only the inbox link: null', () => {
    expect(buyerFromKeyboard(undefined, 'acc-a')).toBeNull();
    expect(buyerFromKeyboard({ inline_keyboard: [[{ text: 'Open inbox', url: INBOX_URL }], [{ text: 'Check now', callback_data: 'c|acc-a|check|' }]] }, 'acc-a')).toBeNull();
  });
});

describe('rememberReplyTarget / replyTargetOf', () => {
  it('remembers the buyer of a message id, and keeps no text', async () => {
    await rememberReplyTarget(101, 'test_buyer_one');
    await rememberReplyTarget(102, 'test_buyer_two');
    expect(await replyTargetOf(101)).toBe('test_buyer_one');
    expect(await replyTargetOf(102)).toBe('test_buyer_two');
    expect(await replyTargetOf(103)).toBeNull();
    expect(await replyTargetOf('101')).toBeNull();
    const stored = fake.areas.local!.replyTargets as Record<string, object>;
    expect(Object.keys(stored).sort()).toEqual(['101', '102']);
    expect(Object.keys(stored['101']!).sort()).toEqual(['at', 'buyer']);
  });

  it('an invalid username is not saved', async () => {
    await rememberReplyTarget(104, 'not a name');
    expect(await replyTargetOf(104)).toBeNull();
  });

  it('is forgotten after 14 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    vi.setSystemTime(t0);
    await rememberReplyTarget(105, 'test_buyer_one');
    vi.setSystemTime(t0 + 14 * 24 * 60 * 60_000 - 1);
    expect(await replyTargetOf(105)).toBe('test_buyer_one');
    vi.setSystemTime(t0 + 14 * 24 * 60 * 60_000);
    expect(await replyTargetOf(105)).toBeNull();
  });
});

describe('replyProbe / redactReplies', () => {
  const entry = (data?: Record<string, unknown>, kind: DiagEntry['kind'] = 'list'): DiagEntry => ({ t: 1, vis: 'hidden', focus: false, path: '/inbox', kind, ...(data ? { data } : {}) });
  const STUB = { redacted: 'left out: holds a reply sent from Telegram' };

  it('the probe is the normalized start of the text', () => {
    expect(replyProbe('  Hello,   the files\nare ready. More text here')).toBe('hello, the files are rea');
    expect(replyProbe('Short')).toBe('short');
  });

  it('an entry that holds the reply text becomes a stub; the others are kept', () => {
    const probe = replyProbe('Hello, the files are ready.');
    const hit = entry({ rows: [{ preview: 'Me: Hello, the files are ready.' }] });
    const spaced = entry({ text: 'Hello,\nthe   files are ready.' }, 'toast');
    const other = entry({ rows: [{ preview: 'Can you send the logo?' }] });
    const empty = entry();
    const out = redactReplies([hit, spaced, other, empty], [probe]);
    expect(out[0]).toEqual({ ...hit, data: STUB });
    expect(out[1]).toEqual({ ...spaced, data: STUB });
    expect(out[2]).toBe(other);
    expect(out[3]).toBe(empty);
  });

  it('HTML-escaped text is caught too', () => {
    const probe = replyProbe('Fish & chips <3 are ready');
    const html = entry({ html: '<p class="msg">Me: Fish &amp; chips &lt;3 are ready</p>' });
    expect(redactReplies([html], [probe])[0]).toEqual({ ...html, data: STUB });
  });

  it('no probes: the list is returned as it is', () => {
    const list = [entry({ text: 'Hello, the files are ready.' })];
    expect(redactReplies(list, [])).toBe(list);
    expect(redactReplies(list, [''])).toBe(list);
  });
});
