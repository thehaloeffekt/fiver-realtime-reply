/**
 * Telegram refuses a message over 4,096 characters (counted after the HTML
 * is parsed) and text that is not valid UTF-8. A very long buyer message
 * must never make an alert or a "Full message" reply fail. Made-up text only.
 */
import { describe, expect, it, vi } from 'vitest';
import { CUT_NOTE, cutMessage, formatAlert, truncate } from '../src/lib/format';
import { SAFE_CHARS, TELEGRAM_MAX_CHARS, sliceSafe, splitTelegramHtml, visibleLength, wellFormed } from '../src/lib/split';
import { sendMessage } from '../src/lib/telegram';
import { FULL_TEXT_CHARS, MAX_FULL_PARTS, conversationEntries, fullReplyParts } from '../src/background/commands';

const EMOJI = '\u{1F600}'; // two UTF-16 units
/** Long text with every character that HTML escaping makes longer. */
const nasty = (n: number) => `a&b<c>d ${EMOJI} `.repeat(Math.ceil(n / 12)).slice(0, n);
const hasLoneSurrogate = (s: string) => wellFormed(s) !== s;
/** Tags in a part are balanced: every opened tag is closed in the same part. */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!m[1]) stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}
const parsedText = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('alerts', () => {
  it('a 20,000-character message: the alert stays under 4,096, says it was cut, and is valid UTF-8', () => {
    const label = 'L'.repeat(64);
    const buyer = { username: 'u'.repeat(64), displayName: 'D'.repeat(100) };
    const { html } = formatAlert(label, buyer, nasty(20_000), 'acc0me01', 99, 'Nov 16, 10:53 AM (UTC+14)');
    expect(visibleLength(html)).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(html).toContain('… (message cut, open Fiverr for the rest)');
    expect(hasLoneSurrogate(html)).toBe(false);
  });

  it('a short message is not touched', () => {
    expect(cutMessage('hello')).toBe('hello');
    expect(formatAlert('Main', { username: 'some_buyer', displayName: 'Some Buyer' }, 'hello', 'acc1').html).not.toContain(CUT_NOTE);
  });

  it('never cuts an emoji in half', () => {
    // Put a surrogate pair exactly across every possible cut point.
    for (let pad = 0; pad < 2; pad++) {
      const text = 'x'.repeat(pad) + EMOJI.repeat(4000);
      expect(hasLoneSurrogate(cutMessage(text))).toBe(false);
      expect(hasLoneSurrogate(truncate(text, 601))).toBe(false);
      expect(hasLoneSurrogate(sliceSafe(text, 101))).toBe(false);
    }
  });

  it('sendMessage replaces a lone surrogate that slipped through', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } })));
    vi.stubGlobal('fetch', fetchMock);
    await sendMessage('t', 1, `bad \uD83D end`);
    vi.unstubAllGlobals();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.text).toBe('bad � end');
  });
});

describe('splitTelegramHtml', () => {
  it('splits at line breaks, each part under the limit', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `<i>line ${i}</i>: ${'word '.repeat(10)}&amp; more`);
    const parts = splitTelegramHtml(lines.join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(visibleLength(p)).toBeLessThanOrEqual(SAFE_CHARS);
      expect(balanced(p)).toBe(true);
    }
    expect(parts.join('\n')).toBe(lines.join('\n'));
  });

  it('cuts one very long line without breaking a tag, an entity or an emoji', () => {
    const line = `<b>Main</b>: <i>${'&amp;&lt;'.repeat(3000)}${EMOJI.repeat(3000)}</i>`;
    const parts = splitTelegramHtml(line);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(visibleLength(p)).toBeLessThanOrEqual(SAFE_CHARS);
      expect(balanced(p)).toBe(true);
      expect(p).not.toMatch(/&[a-z]*$/); // no entity cut at the end
      expect(hasLoneSurrogate(p)).toBe(false);
    }
    expect(parts.map(parsedText).join('')).toBe(parsedText(line));
  });

  it('a short message stays one part, unchanged', () => {
    expect(splitTelegramHtml('<b>Main</b>: hello\nsecond line')).toEqual(['<b>Main</b>: hello\nsecond line']);
  });
});

describe('Full message', () => {
  const mine = { zone: 'Europe/London', set: true };
  const msg = (i: number, n: number) => ({ id: `m${i}`, time: '', text: `${i}:${nasty(n)}`, files: ['plan.pdf'] });

  it('a short conversation is one message with the header and the footer', () => {
    const parts = fullReplyParts('Main', 'some_buyer', conversationEntries([msg(1, 20)], null, mine.zone), null, mine);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('last messages from <b>@some_buyer</b>');
    expect(parts[0]).toContain('Opening the conversation marked it as read on Fiverr.');
  });

  it('one long message is split into several messages, all of it shown up to the cut', () => {
    const parts = fullReplyParts('Main', 'some_buyer', conversationEntries([msg(1, 7000)], null, mine.zone), null, mine);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) {
      expect(visibleLength(p)).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
      expect(balanced(p)).toBe(true);
      expect(hasLoneSurrogate(p)).toBe(false);
    }
    expect(parts.join('')).not.toContain(CUT_NOTE);
  });

  it('ten huge messages: at most 5 parts, the newest kept, a note for the older ones', () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(i, 20_000));
    const parts = fullReplyParts('Main', 'some_buyer', conversationEntries(messages, null, mine.zone), null, mine);
    expect(parts.length).toBeLessThanOrEqual(MAX_FULL_PARTS);
    for (const p of parts) expect(visibleLength(p)).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    const all = parts.join('\n');
    expect(all).toContain('9:a&amp;b'); // the newest message
    expect(all).toMatch(/\d+ older messages left out\. Open Fiverr for the rest\./);
    expect(all).toContain(CUT_NOTE); // each was over FULL_TEXT_CHARS
    expect(FULL_TEXT_CHARS).toBeLessThan(20_000);
  });
});
