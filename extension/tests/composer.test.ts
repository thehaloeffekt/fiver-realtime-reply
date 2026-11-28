// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * The one module that writes to Fiverr (src/content/composer.ts), run
 * together with the background driver on the captured conversation page
 * (tests/fixtures/conversation.html: made-up names and texts; its composer
 * has the real textarea#send-message-text-area and button[aria-label="Send"]).
 * "Fiverr" is simulated by listeners on the Send button.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkResult, handleCompose, headerBuyer, type ComposeRequest } from '../src/content/composer';
import { driveReply, type DriverPage } from '../src/background/replyDriver';
import { COMPOSER, COMPOSER_FORBIDDEN } from '../src/lib/selectors';
import { watchThread } from '../src/content/threadWatcher';
import { watchInboxList } from '../src/content/inboxWatcher';
import type { ListMessage } from '../src/lib/inboxRow';
import type { ThreadMessage } from '../src/lib/messages';
import type { TypingStep } from '../src/lib/typing';

const FIXTURES: Record<string, string> = import.meta.glob('./fixtures/*.html', { query: '?raw', import: 'default', eager: true });
const fixture = (name: string) => FIXTURES[`./fixtures/${name}`]!;

const BUYER = 'buyer_one'; // the made-up buyer of the fixture
const ME = 'my_seller';
const TEXT = 'Hello, the files are ready.\nI will send the rest tomorrow.';

/** A version-1 UUID for a time, as in Fiverr's message ids. */
function v1(ms: number): string {
  const ticks = (BigInt(ms) + 12_219_292_800_000n) * 10_000n;
  const hex = (n: bigint, len: number) => n.toString(16).padStart(len, '0');
  return `${hex(ticks & 0xffffffffn, 8)}-${hex((ticks >> 32n) & 0xffffn, 4)}-1${hex((ticks >> 48n) & 0xfffn, 3)}-8000-000000000000`;
}

const box = () => document.querySelector<HTMLTextAreaElement>(COMPOSER.textbox)!;
const sendButton = () => document.querySelector<HTMLButtonElement>(COMPOSER.send)!;
const messages = () => Array.from(document.querySelectorAll<HTMLElement>('div.message[id]'));

/** Appends a copy of my first message ("Me") or of the buyer's last one, with a new id and text. */
function addMessage(kind: 'mine' | 'buyer', text: string, id = `${messages()[0]!.id.split('_')[0]}_${v1(Date.now())}`): string {
  const src = kind === 'mine' ? messages()[0]! : messages().filter((m) => m.querySelector(`[data-track-value="${BUYER}"]`)).at(-1)!;
  const el = src.cloneNode(true) as HTMLElement;
  el.id = id;
  const ps = Array.from(el.querySelectorAll('.message-content p[data-track-tag="typography"]'));
  ps.at(-1)!.textContent = text;
  messages().at(-1)!.after(el);
  return el.id;
}

let path = `/inbox/${BUYER}`;
const ask = (m: ComposeRequest) => handleCompose(m, { doc: document, path: () => path });

/** The driver, talking to the composer directly (no tabs, no waiting). */
const page: DriverPage = { prepare: ask, ask: (m) => ask(m) };
const fewSteps = (text: string): TypingStep[] => {
  const out: TypingStep[] = [];
  for (const part of text.split(/(\n)/)) for (let i = 0; i < part.length; i += 5) out.push({ delayMs: 0, text: part.slice(i, i + 5) });
  return out.filter((s) => s.text);
};
let clock = 0;
const hooks = (extra: Parameters<typeof driveReply>[4] = {}) => ({
  plan: fewSteps,
  sleep: async (ms: number) => void (clock += ms),
  now: () => clock,
  ...extra,
});

/** Every click and every key event on the page, by target. */
let clicks: Element[] = [];
let keys: string[] = [];
const onClick = (e: Event) => clicks.push(e.target as Element);
const onKey = (e: Event) => keys.push((e as KeyboardEvent).key);

beforeEach(() => {
  document.body.innerHTML = fixture('conversation.html');
  path = `/inbox/${BUYER}`;
  clock = 0;
  clicks = [];
  keys = [];
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keypress', onKey, true);
  // Fiverr enables Send once the box has text.
  box().addEventListener('input', () => (sendButton().disabled = box().value === ''));
});
afterEach(() => {
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('keypress', onKey, true);
  document.body.innerHTML = '';
});

/** Simulated Fiverr: a click on Send shows my message in the thread and empties the box. */
function fiverrSends(text = TEXT) {
  sendButton().addEventListener('click', () => {
    addMessage('mine', text);
    box().value = '';
  });
}

describe('checks before typing', () => {
  it('reads the buyer from the conversation header, not from the site header', () => {
    expect(headerBuyer(document, ME)).toBe(BUYER);
  });

  it('prepare: right page, right header, empty box', async () => {
    expect(await ask({ type: 'compose:prepare', buyer: BUYER, myUsername: ME })).toMatchObject({ ok: true });
  });

  it('a wrong buyer in the URL stops before any keystroke', async () => {
    path = '/inbox/someone_else';
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out).toMatchObject({ state: 'failed' });
    expect(box().value).toBe('');
    expect(clicks).toEqual([]);
  });

  it('a wrong buyer in the conversation header stops before any keystroke', async () => {
    document.querySelector('header [data-track-tag="avatar"]')!.setAttribute('data-track-value', 'someone_else');
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out).toEqual({ state: 'failed', reason: `the conversation header shows a different buyer, not @${BUYER}.` });
    expect(box().value).toBe('');
  });

  it('an existing draft is never overwritten', async () => {
    box().value = 'my own unfinished draft';
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out).toEqual({ state: 'failed', reason: 'the message box on Fiverr already has a draft.' });
    expect(box().value).toBe('my own unfinished draft');
    expect(clicks).toEqual([]);
  });
});

describe('typing', () => {
  it('uses the native value setter and fires the input events React needs; keeps line breaks', async () => {
    // React wraps the element's own `value` property; a plain assignment would go through it.
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    const direct: string[] = [];
    Object.defineProperty(box(), 'value', {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v: string) {
        direct.push(v);
        proto.set!.call(this, v);
      },
    });
    const events: Array<{ type: string; inputType: string; data: string | null; bubbles: boolean }> = [];
    for (const type of ['beforeinput', 'input']) {
      box().addEventListener(type, (e) => events.push({ type, inputType: (e as InputEvent).inputType, data: (e as InputEvent).data, bubbles: e.bubbles }));
    }
    let before = '';
    for (const chunk of ['Hello', '\n', 'there']) {
      expect(await ask({ type: 'compose:type', buyer: BUYER, myUsername: ME, before, chunk })).toEqual({ ok: true });
      before += chunk;
    }
    expect(proto.get!.call(box())).toBe('Hello\nthere');
    expect(direct).toEqual([]); // never `box.value = …`
    expect(events.filter((e) => e.type === 'input')).toEqual([
      { type: 'input', inputType: 'insertText', data: 'Hello', bubbles: true },
      { type: 'input', inputType: 'insertLineBreak', data: null, bubbles: true },
      { type: 'input', inputType: 'insertText', data: 'there', bubbles: true },
    ]);
    expect(events.filter((e) => e.type === 'beforeinput')).toHaveLength(3);
    expect(document.activeElement).toBe(box());
    expect(keys).toEqual([]); // no key events at all, so never Enter
  });

  it('stops when someone else changed the box while typing, and leaves their text', async () => {
    let n = 0;
    const out = await driveReply(page, BUYER, TEXT, ME, hooks({
      sleep: async () => {
        if (++n === 3) box().value += ' (typed by the user)';
      },
    }));
    expect(out).toEqual({ state: 'failed', reason: 'the text in the message box changed while typing.' });
    expect(box().value).toContain('(typed by the user)');
    expect(clicks).toEqual([]);
  });
});

describe('the click', () => {
  it('sends: types the whole text, clicks Send once, never a forbidden control, never Enter', async () => {
    fiverrSends();
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out.state).toBe('sent');
    expect(clicks).toEqual([sendButton()]);
    for (const sel of COMPOSER_FORBIDDEN) {
      for (const el of Array.from(document.querySelectorAll(sel))) expect(clicks.some((c) => el === c || el.contains(c))).toBe(false);
    }
    expect(keys).toEqual([]);
  });

  it('a navigation between typing and the click: no click (URL)', async () => {
    let typedAll = false;
    const out = await driveReply(page, BUYER, TEXT, ME, hooks({ beforeClick: () => void ((typedAll = true), (path = '/inbox/someone_else')) }));
    expect(typedAll).toBe(true);
    expect(out).toMatchObject({ state: 'failed' });
    expect(clicks).toEqual([]);
  });

  it('a different buyer in the header right before the click: no click', async () => {
    const out = await driveReply(page, BUYER, TEXT, ME, hooks({
      beforeClick: () => document.querySelector('header [data-track-tag="avatar"]')!.setAttribute('data-track-value', 'someone_else'),
    }));
    expect(out).toMatchObject({ state: 'failed' });
    expect(clicks).toEqual([]);
    // The text the extension typed is cleared again.
    expect(box().value).toBe('');
  });

  it('refuses a disabled Send button, and a second Send button on the page', async () => {
    box().value = TEXT;
    sendButton().disabled = true;
    expect(await ask({ type: 'compose:send', buyer: BUYER, myUsername: ME, text: TEXT })).toMatchObject({ ok: false, stop: 'button-disabled' });
    sendButton().disabled = false;
    sendButton().after(sendButton().cloneNode(true));
    expect(await ask({ type: 'compose:send', buyer: BUYER, myUsername: ME, text: TEXT })).toMatchObject({ ok: false, stop: 'no-button' });
    expect(clicks).toEqual([]);
  });
});

describe('the result', () => {
  const baseline = () => messages().map((m) => m.id);

  it('"sent" only after my own new message with the same text shows', () => {
    const b = baseline();
    expect(checkResult(document, TEXT, b, [], ME)).toEqual({ ok: true, result: 'pending' });
    addMessage('buyer', TEXT); // the buyer's message with the same text does not count
    expect(checkResult(document, TEXT, b, [], ME)).toEqual({ ok: true, result: 'pending' });
    addMessage('mine', 'some other text');
    expect(checkResult(document, TEXT, b, [], ME)).toEqual({ ok: true, result: 'pending' });
    addMessage('mine', TEXT, `${messages()[0]!.id.split('_')[0]}_temp-id`); // no Fiverr id yet
    expect(checkResult(document, TEXT, b, [], ME)).toEqual({ ok: true, result: 'pending' });
    const id = addMessage('mine', TEXT);
    expect(checkResult(document, TEXT, b, [], ME)).toEqual({ ok: true, result: 'sent', messageId: id });
  });

  it('a message that is already in the thread (the same text sent earlier) does not count', () => {
    addMessage('mine', TEXT);
    expect(checkResult(document, TEXT, baseline(), [], ME)).toEqual({ ok: true, result: 'pending' });
  });

  it('blocked: Fiverr shows a warning and no message → "Not sent", the typed text is cleared', async () => {
    sendButton().addEventListener('click', () => {
      const note = document.createElement('div');
      note.setAttribute('role', 'alert');
      note.textContent = 'This message was not sent. (made-up warning)';
      document.body.append(note);
    });
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out).toEqual({ state: 'failed', reason: 'Fiverr showed: "This message was not sent. (made-up warning)"' });
    expect(clicks).toHaveLength(1);
    expect(box().value).toBe('');
  });

  it('unknown: nothing shows within the time limit; never a second click', async () => {
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out.state).toBe('unknown');
    expect(clicks).toHaveLength(1);
  });

  it('unknown: the message shows and a warning too', async () => {
    sendButton().addEventListener('click', () => {
      addMessage('mine', TEXT);
      const note = document.createElement('div');
      note.setAttribute('role', 'alert');
      note.textContent = 'Made-up caution notice';
      document.body.append(note);
    });
    const out = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(out).toEqual({ state: 'unknown', reason: 'Fiverr showed: "Made-up caution notice"' });
  });

  it('clear empties the box only when it holds exactly the extension\'s text', async () => {
    box().value = 'the user typed this';
    await ask({ type: 'compose:clear', text: TEXT });
    expect(box().value).toBe('the user typed this');
    box().value = TEXT;
    await ask({ type: 'compose:clear', text: TEXT });
    expect(box().value).toBe('');
  });
});

describe('no alert for the message the extension sent', () => {
  it('thread detector: the sent message (mine) does not alert, a buyer message right after does', async () => {
    const out: ThreadMessage[] = [];
    let t = Date.now() - 60_000;
    const stop = watchThread((m) => out.push(m), { now: () => t, path: () => path, mayAlert: () => true, myUsername: () => ME });
    t += 5_000; // past the settle time of opening the conversation
    fiverrSends();
    const res = await driveReply(page, BUYER, TEXT, ME, hooks());
    expect(res.state).toBe('sent');
    await new Promise((r) => setTimeout(r, 0));
    expect(out).toEqual([]);
    addMessage('buyer', 'Great, thank you!');
    await new Promise((r) => setTimeout(r, 0));
    expect(out.map((m) => m.text)).toEqual(['Great, thank you!']);
    stop();
  });

  it('list detector: the row turning into "Me: {text}" does not alert', async () => {
    const piece = (texts: string[]) => texts.map((p, i) => `<span class="x${i}">${p}</span>`).join('');
    document.body.innerHTML = '<main><div class="list"></div></main>';
    const list = document.querySelector('.list')!;
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'contact');
    row.setAttribute('role', 'button');
    row.innerHTML = piece(['B', 'Buyer One', '3 minutes', 'Could you check the draft?']);
    list.append(row);
    const got: ListMessage[] = [];
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000; // past the list's settle time
    try {
      const stop = watchInboxList((m) => got.push(m), { mayAlertRead: () => true });
      row.innerHTML = piece(['B', 'Buyer One', 'Just now', 'Me:', 'Hello, the files are ready. I will send the rest tomorrow.']);
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([]);
      stop();
    } finally {
      Date.now = realNow;
    }
  });
});
