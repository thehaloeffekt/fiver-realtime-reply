import { describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback, isCallbackForMe } from '../src/lib/callback';
import { formatAlert } from '../src/lib/format';

describe('callback_data format', () => {
  it('encodes c|{accountId}|{action}|{arg}', () => {
    expect(encodeCallback('ab12cd34', 'full', 'm_rohn')).toBe('c|ab12cd34|full|m_rohn');
    expect(encodeCallback('ab12cd34', 'check')).toBe('c|ab12cd34|check|');
  });

  it('round-trips, with an empty arg and an arg that contains |', () => {
    expect(decodeCallback('c|ab12cd34|check|')).toEqual({ accountId: 'ab12cd34', action: 'check', arg: '' });
    expect(decodeCallback('c|ab12cd34|full|a|b')).toEqual({ accountId: 'ab12cd34', action: 'full', arg: 'a|b' });
  });

  it('has at least four parts, which the relay requires', () => {
    expect(encodeCallback('ab12cd34', 'check')!.split('|')).toHaveLength(4);
  });

  it('rejects other formats', () => {
    for (const bad of ['c|ab12cd34|check', 'x|ab12cd34|check|', 'c||check|', 'c|bad id|check|', '', null, 42]) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });

  it('refuses data over 64 bytes', () => {
    expect(encodeCallback('ab12cd34', 'full', 'u'.repeat(48))).toBe('c|ab12cd34|full|' + 'u'.repeat(48)); // 16 + 48 = 64 bytes
    expect(encodeCallback('ab12cd34', 'full', 'u'.repeat(49))).toBeNull();
  });

  it('rejects an invalid accountId when encoding', () => {
    expect(() => encodeCallback('has space', 'check')).toThrow();
  });
});

describe('who handles a button press', () => {
  const mine = decodeCallback('c|ab12cd34|check|');
  const theirs = decodeCallback('c|zz99yy88|check|');

  it('routed:true is always for this profile', () => {
    expect(isCallbackForMe(mine, true, 'ab12cd34')).toBe(true);
  });

  it('routed:false with another accountId is ignored', () => {
    expect(isCallbackForMe(theirs, false, 'ab12cd34')).toBe(false);
  });

  it('routed:false with our accountId is handled', () => {
    expect(isCallbackForMe(mine, false, 'ab12cd34')).toBe(true);
  });

  it('foreign callback_data is ignored', () => {
    expect(isCallbackForMe(decodeCallback('something'), false, 'ab12cd34')).toBe(false);
  });
});

describe('alert message', () => {
  it('escapes HTML and builds the three buttons', () => {
    const { html, keyboard } = formatAlert('Shop <A&B>', { username: 'm_rohn', displayName: 'Mira <script>' }, 'if a < b && c > d', 'ab12cd34');
    expect(html).toBe(
      '<b>Shop &lt;A&amp;B&gt;</b>\nMessage from <b>Mira &lt;script&gt;</b> (@m_rohn)\nif a &lt; b &amp;&amp; c &gt; d',
    );
    expect(keyboard).toEqual([
      [{ text: 'Open inbox', url: 'https://www.fiverr.com/inbox/m_rohn' }],
      [
        { text: 'Full message', callback_data: 'c|ab12cd34|full|m_rohn' },
        { text: 'Check now', callback_data: 'c|ab12cd34|check|' },
      ],
    ]);
  });
});
