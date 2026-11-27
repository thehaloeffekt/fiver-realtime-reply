/**
 * Telegram refuses a message whose text is over 4,096 characters after the
 * HTML is parsed (tags removed, "&amp;" counted as one character). Lengths
 * are UTF-16 code units, the same as JavaScript's `length`.
 *
 * These helpers measure and split our parse_mode HTML without cutting a tag,
 * an entity or an emoji (a surrogate pair) in half.
 */

export const TELEGRAM_MAX_CHARS = 4096;
/** What we aim for: room for a few characters of slack. */
export const SAFE_CHARS = 4000;

/** A tag, an entity, a surrogate pair, or one UTF-16 unit. */
const TOKEN = /<\/?([a-z]+)(?:\s[^>]*)?>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/gi;

function widthOf(token: string, isTag: boolean): number {
  if (isTag) return 0;
  if (token.length > 1 && token[0] === '&') return 1;
  return token.length;
}

/** Length as Telegram counts it: tags are 0, an entity is 1. */
export function visibleLength(html: string): number {
  let n = 0;
  for (const m of html.matchAll(TOKEN)) n += widthOf(m[0], Boolean(m[1]));
  return n;
}

/** `text.slice(0, n)`, one shorter when that would cut an emoji in half. */
export function sliceSafe(text: string, n: number): string {
  if (n <= 0) return '';
  if (text.length <= n) return text;
  const c = text.charCodeAt(n - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** Replaces lone surrogates (invalid UTF-8 for Telegram) with U+FFFD. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/**
 * Splits one line that is too long at `limit` visible characters. Tags open
 * at the cut are closed at the end of a piece and opened again in the next.
 */
function hardSplit(line: string, limit: number): string[] {
  const pieces: string[] = [];
  const open: Array<{ name: string; tag: string }> = [];
  let cur = '';
  let n = 0;
  for (const m of line.matchAll(TOKEN)) {
    const token = m[0];
    if (m[1]) {
      if (token[1] === '/') open.pop();
      else open.push({ name: m[1].toLowerCase(), tag: token });
      cur += token;
      continue;
    }
    const w = widthOf(token, false);
    if (n + w > limit && n > 0) {
      pieces.push(cur + [...open].reverse().map((t) => `</${t.name}>`).join(''));
      cur = open.map((t) => t.tag).join('');
      n = 0;
    }
    cur += token;
    n += w;
  }
  if (n > 0) pieces.push(cur);
  return pieces;
}

/**
 * Splits HTML into messages of at most `limit` visible characters, at line
 * breaks when it can. Each line must be balanced HTML (every tag closed on
 * its line), which is how this extension writes its messages.
 */
export function splitTelegramHtml(html: string, limit = SAFE_CHARS): string[] {
  const parts: string[] = [];
  let cur = '';
  let curLen = 0;
  const flush = () => {
    const text = cur.replace(/\n+$/, '');
    if (visibleLength(text.trim()) > 0) parts.push(text);
    cur = '';
    curLen = 0;
  };
  for (const line of html.split('\n')) {
    const len = visibleLength(line);
    if (len > limit) {
      flush();
      parts.push(...hardSplit(line, limit));
      continue;
    }
    if (cur && curLen + 1 + len > limit) flush();
    if (cur) {
      cur += `\n${line}`;
      curLen += 1 + len;
    } else if (line.trim()) {
      cur = line;
      curLen = len;
    }
  }
  flush();
  return parts.length ? parts : [html];
}
