/**
 * Telegram refuses a message over 4096 characters (counted after HTML
 * parsing), and text that is not valid UTF-8 (a half emoji). A very long
 * buyer message must never make an alert or a "Full message" reply fail.
 * Names and texts are made up.
 */
import { describe, expect, it } from 'vitest';
import { conversationEntries, fullReplyParts } from '../src/background/commands';
import { FULL_MESSAGE_CHARS, MAX_FULL_PARTS, TELEGRAM_MAX_CHARS } from '../src/lib/constants';
import { CUT_NOTE, cutText, formatAlert, telegramLength, truncate } from '../src/lib/format';

/** What Telegram checks, as far as we can: length after parsing, and valid UTF-8. */
function acceptedByTelegram(html: string): boolean {
  try {
    encodeURIComponent(html); // throws on a lone surrogate, which has no UTF-8 form
  } catch {
    return false;
  }
  return telegramLength(html) <= TELEGRAM_MAX_CHARS;
}

const LAGOS = { zone: 'Africa/Lagos', set: true };
const words = (n: number) => 'please check the draft & the <logo> '.repeat(Math.ceil(n / 36)).slice(0, n);
const emojis = (n: number) => '😀'.repeat(n);
const msgId = (i: number) => `00000000-0000-4000-8000-000000000000_${String(i).padStart(8, '0')}-0000-1${'abc'}-8000-000000000000`;

describe('cutting a long text', () => {
  it('leaves a short text alone', () => {
    expect(cutText('hello', 100)).toBe('hello');
  });

  it('cuts to the limit, at a space, and ends with the note', () => {
    const out = cutText(words(10_000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith(CUT_NOTE)).toBe(true);
    expect(CUT_NOTE).toBe('… (message cut, open Fiverr for the rest)');
    expect(out.slice(0, -CUT_NOTE.length).endsWith(' ')).toBe(false); // trailing space trimmed
  });

  it('never cuts inside an emoji (a half emoji is not valid UTF-8)', () => {
    for (const max of [100, 101, 102, 103]) {
      const out = cutText(emojis(5000), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(acceptedByTelegram(out)).toBe(true);
    }
    expect(acceptedByTelegram(truncate(emojis(100), 51))).toBe(true);
  });

  it('counts the length the way Telegram does: tags removed, &amp; as one character', () => {
    expect(telegramLength('<b>A&amp;B</b> &lt;x&gt;')).toBe(7);
  });
});

describe('alert', () => {
  const alert = (body: string, name = 'Some Buyer') => formatAlert('Main', { username: 'some_buyer', displayName: name }, body, 'acc1', 3, 'Nov 15, 7:30 PM').html;

  it('a 50,000-character message is cut with the note and fits in one Telegram message', () => {
    const html = alert(words(50_000));
    expect(acceptedByTelegram(html)).toBe(true);
    expect(html).toContain(CUT_NOTE);
    // The other lines are all still there.
    expect(html.split('\n')[0]).toBe('<b>Main</b>');
    expect(html).toContain('+3 earlier messages');
    expect(html.split('\n').at(-1)).toBe('Buyer time: Nov 15, 7:30 PM');
  });

  it('also with emoji, HTML characters and a very long display name', () => {
    expect(acceptedByTelegram(alert(emojis(40_000)))).toBe(true);
    expect(acceptedByTelegram(alert('<&>'.repeat(20_000)))).toBe(true);
    expect(acceptedByTelegram(alert(words(50_000), 'N'.repeat(5000)))).toBe(true);
  });

  it('a normal message is not cut', () => {
    expect(alert('are you there?')).not.toContain(CUT_NOTE);
  });
});

describe('Full message', () => {
  const big = (i: number) => ({ id: msgId(i), time: '', text: words(20_000), files: Array.from({ length: 30 }, (_, k) => `file-${i}-${k}-${'x'.repeat(150)}.pdf`) });
  const UK = { offset: 0, at: Date.now(), country: 'United Kingdom' };

  it('each long message is cut with the note; long file lists are counted', () => {
    const [entry] = conversationEntries([big(1)], UK, LAGOS.zone);
    expect(entry).toContain(CUT_NOTE);
    expect(entry).toContain('[+20 more files]');
    expect(entry!.match(/\[file: /g)).toHaveLength(10);
    expect(telegramLength(entry!)).toBeLessThan(FULL_MESSAGE_CHARS + 11 * 140 + 80);
  });

  it('a long reply is split into several messages, each one accepted by Telegram', () => {
    const msgs = [0, 1].map((i) => ({ id: msgId(i), time: '', text: words(1200), files: [] }));
    const parts = fullReplyParts('Main', 'some_buyer', [...conversationEntries(msgs, UK, LAGOS.zone), ...conversationEntries(msgs, UK, LAGOS.zone), ...conversationEntries(msgs, UK, LAGOS.zone)], UK, LAGOS);
    expect(parts.length).toBe(2);
    for (const p of parts) expect(acceptedByTelegram(p)).toBe(true);
    expect(parts[0]!.split('\n')[0]).toBe('<b>Main</b>: last messages from <b>@some_buyer</b> (part 1 of 2)');
    expect(parts[0]!.split('\n')[1]).toMatch(/^Times: Africa\/Lagos\. Buyer local time now: /);
    expect(parts[1]!.split('\n')[0]).toBe('<b>Main</b>: @some_buyer (part 2 of 2)');
    // The "marked as read" note is at the end of the last part only.
    expect(parts[0]).not.toContain('marked it as read');
    expect(parts[1]!.endsWith('<i>Opening the conversation marked it as read on Fiverr.</i>')).toBe(true);
  });

  it('a message is never split across two parts', () => {
    const entries = conversationEntries([0, 1, 2, 3, 4, 5].map((i) => ({ id: msgId(i), time: '', text: `start-${i} ${words(1400)} end-${i}`, files: [] })), null, LAGOS.zone);
    const parts = fullReplyParts('Main', 'some_buyer', entries, null, LAGOS);
    expect(parts.length).toBeGreaterThan(1);
    for (const e of entries) expect(parts.filter((p) => p.includes(e))).toHaveLength(1);
  });

  it('the worst case (10 huge messages with 30 files each): at most 5 messages, newest kept, older ones counted', () => {
    const entries = conversationEntries(Array.from({ length: 10 }, (_, i) => big(i)), UK, LAGOS.zone);
    const parts = fullReplyParts('M'.repeat(200), 'some_buyer', entries, UK, LAGOS);
    expect(parts.length).toBeLessThanOrEqual(MAX_FULL_PARTS);
    for (const p of parts) expect(acceptedByTelegram(p)).toBe(true);
    expect(parts.at(-1)).toContain(entries.at(-1)!); // the newest message is there
    expect(parts[0]).toMatch(/\d+ older messages were left out to keep this short\. Open Fiverr for them\./);
  });

  it('a short reply stays one message, without part numbers', () => {
    const parts = fullReplyParts('Main', 'some_buyer', ['<i>Nov 16, 6:52 PM</i>: hello'], null, LAGOS);
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toContain('part 1');
  });

  it('safety net: an entry too long for one message is cut as plain text', () => {
    const parts = fullReplyParts('Main', 'some_buyer', [`<i>Nov 16</i>: ${'a&b '.repeat(3000)}`], null, LAGOS);
    expect(parts).toHaveLength(1);
    expect(acceptedByTelegram(parts[0]!)).toBe(true);
    expect(parts[0]).toContain(CUT_NOTE);
  });
});
