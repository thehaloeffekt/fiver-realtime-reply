/**
 * THE ONLY CODE THAT WRITES TO A FIVERR PAGE.
 *
 * "Send replies from Telegram" is the single exception to the read-only rule.
 * Everything that focuses, types, clicks or clears is in this file, so the
 * exception can be audited in one place (tests/composerAudit.test.ts fails
 * if any other file under src/ does such things).
 *
 * The background (src/background/replyDriver.ts) asks for one small step at
 * a time, and only after all of these hold: the "Send replies from Telegram"
 * switch is on, the user pressed "Send" under this exact text in Telegram,
 * and the reply moved from "preview" to "sending" in storage. This file
 * checks the page itself before each step:
 *
 *   prepare  the page is the target buyer's conversation (URL path AND the
 *            username in the conversation header), the message box is there
 *            and empty (a draft is the user's own work: never overwritten).
 *   type     the same page checks, and the box still holds exactly what the
 *            extension typed so far; then it adds one chunk.
 *   send     the same page checks, the box holds exactly the full text, the
 *            Send button is the only one, enabled, and not one of the
 *            forbidden controls; then one click. Never the Enter key: the
 *            user can change what Enter does on Fiverr.
 *   result   looks for a new own message with the same text, or a warning.
 *   clear    empties the box, but only if it still holds exactly the text the
 *            extension typed.
 *
 * It never touches attachments, emoji, quick responses, custom offers or the
 * Enter-key settings, never uploads a file, and never spoofs
 * document.visibilityState. Every step answers at once (no timers here: the
 * watch tab is usually hidden, where Chrome slows timers to about one per
 * second); the background paces the steps.
 */
import { messageSentAt } from '../lib/buyerTime';
import { avatarUsername } from '../lib/inboxRow';
import { COMPOSER, COMPOSER_FORBIDDEN, CONVERSATION, CONVERSATION_HEADER, HEADER } from '../lib/selectors';
import { conversationUsername, parseConversation, waitFor, waitForQuiet } from './reader';

export type ComposeRequest =
  | { type: 'compose:prepare'; buyer: string; myUsername?: string }
  | { type: 'compose:type'; buyer: string; myUsername?: string; before: string; chunk: string }
  | { type: 'compose:send'; buyer: string; myUsername?: string; text: string }
  | { type: 'compose:result'; buyer: string; myUsername?: string; text: string; baseline: string[]; warningsBefore: string[] }
  | { type: 'compose:clear'; text: string };

/** Why a step stopped. `draft` and `changed` mean the box holds the user's text: never cleared. */
export type ComposeStop = 'wrong-page' | 'wrong-buyer' | 'no-box' | 'draft' | 'changed' | 'too-long' | 'no-button' | 'button-disabled' | 'unsafe-button';

export type ComposeResponse =
  | { ok: true; maxLength?: number; baseline?: string[]; warningsBefore?: string[] }
  | { ok: true; result: 'sent'; messageId: string }
  | { ok: true; result: 'blocked'; warning: string }
  | { ok: true; result: 'unclear'; warning?: string }
  | { ok: true; result: 'pending' }
  | { ok: false; stop: ComposeStop; reason: string };

export interface ComposerEnv {
  doc: Document;
  path: () => string;
}

const defaultEnv = (): ComposerEnv => ({ doc: document, path: () => location.pathname });

const fail = (stop: ComposeStop, reason: string): ComposeResponse => ({ ok: false, stop, reason });

/** The message box: the id, else the one textarea with the same role and placeholder. */
export function findTextbox(doc: ParentNode): HTMLTextAreaElement | null {
  const byId = doc.querySelector(COMPOSER.textbox);
  if (byId instanceof HTMLTextAreaElement) return byId;
  const all = Array.from(doc.querySelectorAll(COMPOSER.textboxFallback)).filter((e): e is HTMLTextAreaElement => e instanceof HTMLTextAreaElement);
  return all.length === 1 ? all[0]! : null;
}

/**
 * The buyer named in the conversation header: the avatar in a <header> that
 * is not the site's own header (which holds my avatar). Null when there is
 * none, or when two headers name different people.
 */
export function headerBuyer(doc: ParentNode, myUsername?: string): string | null {
  const me = myUsername?.toLowerCase();
  const names = new Set<string>();
  for (const header of Array.from(doc.querySelectorAll(CONVERSATION_HEADER.header))) {
    if (header.closest(HEADER.mainHeader) || header.querySelector(HEADER.mainHeader)) continue;
    const who = avatarUsername(header.querySelector(CONVERSATION_HEADER.avatar));
    if (!who || who.toLowerCase() === me) continue;
    names.add(who.toLowerCase());
  }
  return names.size === 1 ? [...names][0]! : null;
}

/** The page is the target buyer's conversation: by URL path and by header. */
export function checkConversation(env: ComposerEnv, buyer: string, myUsername?: string): ComposeResponse | null {
  const want = buyer.toLowerCase();
  const onPath = conversationUsername(env.path()).toLowerCase();
  if (onPath !== want) return fail('wrong-page', `the open page is not the conversation with @${buyer}.`);
  const named = headerBuyer(env.doc, myUsername);
  if (named === null) return fail('wrong-buyer', 'could not read the buyer in the conversation header.');
  if (named !== want) return fail('wrong-buyer', `the conversation header shows a different buyer, not @${buyer}.`);
  return null;
}

/** Line breaks as the textarea keeps them. */
const lf = (s: string) => s.replace(/\r\n?/g, '\n');

/**
 * Sets the box's value the way React notices: the native setter of
 * HTMLTextAreaElement (React wraps the element's own `value` property and
 * would ignore a plain assignment), then input events that bubble.
 */
function writeValue(box: HTMLTextAreaElement, value: string, inputType: string, data: string | null) {
  const view = box.ownerDocument.defaultView ?? window;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')!.set!;
  const InputEv = view.InputEvent ?? view.Event;
  box.dispatchEvent(new InputEv('beforeinput', { bubbles: true, cancelable: true, inputType, data } as InputEventInit));
  setter.call(box, value);
  box.dispatchEvent(new InputEv('input', { bubbles: true, inputType, data } as InputEventInit));
}

/** The Send button, only if it is unique, a real button, enabled and not a forbidden control. */
export function findSendButton(doc: ParentNode): { button: HTMLButtonElement } | ComposeResponse {
  const all = Array.from(doc.querySelectorAll(COMPOSER.send));
  if (all.length !== 1 || !(all[0] instanceof HTMLButtonElement)) {
    return fail('no-button', all.length > 1 ? 'more than one Send button is on the page.' : 'the Send button is not on the page.');
  }
  const button = all[0];
  for (const sel of COMPOSER_FORBIDDEN) {
    if (button.matches(sel) || button.closest(sel) || button.querySelector(sel)) return fail('unsafe-button', 'the Send button is not where it should be.');
  }
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return fail('button-disabled', 'the Send button is disabled.');
  return { button };
}

/** Texts of the warning notices on the page now. */
export function warningTexts(doc: ParentNode): string[] {
  return Array.from(doc.querySelectorAll(COMPOSER.warning))
    .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Text for comparing what was typed with what Fiverr shows: whitespace and line breaks collapsed. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** Ids of all messages in the thread now. */
export function messageIds(doc: ParentNode): string[] {
  return Array.from(doc.querySelectorAll(CONVERSATION.message), (e) => e.id).filter(Boolean);
}

/**
 * Has the send gone through? "sent" only for a new message (id not in the
 * baseline) that is mine, has a real Fiverr id (a time-based UUID, not a
 * placeholder) and the same text. "blocked" for a new warning and no such
 * message; "unclear" for both at once.
 */
export function checkResult(doc: ParentNode, text: string, baseline: string[], warningsBefore: string[], myUsername?: string): ComposeResponse {
  const before = new Set(baseline);
  const me = myUsername?.toLowerCase();
  const mine = parseConversation(doc).find(
    (m) => !before.has(m.id) && (m.me || (me && m.sender.toLowerCase() === me)) && messageSentAt(m.id) !== null && sameText(m.text, text),
  );
  const old = new Set(warningsBefore);
  const warning = warningTexts(doc).find((w) => !old.has(w));
  if (mine && warning) return { ok: true, result: 'unclear', warning: warning.slice(0, 300) };
  if (mine) return { ok: true, result: 'sent', messageId: mine.id };
  if (warning) return { ok: true, result: 'blocked', warning: warning.slice(0, 300) };
  return { ok: true, result: 'pending' };
}

/**
 * Runs one step. `prepare` waits for the page (MutationObserver based); the
 * other steps answer at once.
 */
export async function handleCompose(msg: ComposeRequest, env: ComposerEnv = defaultEnv()): Promise<ComposeResponse> {
  const { doc } = env;
  switch (msg.type) {
    case 'compose:prepare': {
      await waitFor(COMPOSER.textbox, 20_000, doc);
      const thread = doc.querySelector(CONVERSATION.message);
      if (thread?.parentElement) await waitForQuiet(thread.parentElement, 1200, 6000);
      const wrong = checkConversation(env, msg.buyer, msg.myUsername);
      if (wrong) return wrong;
      const box = findTextbox(doc);
      if (!box) return fail('no-box', 'the message box is not on the page.');
      if (box.value !== '') return fail('draft', 'the message box on Fiverr already has a draft.');
      box.focus();
      return { ok: true, maxLength: box.maxLength > 0 ? box.maxLength : undefined };
    }
    case 'compose:type': {
      const wrong = checkConversation(env, msg.buyer, msg.myUsername);
      if (wrong) return wrong;
      const box = findTextbox(doc);
      if (!box) return fail('no-box', 'the message box disappeared while typing.');
      if (box.value !== msg.before) return fail('changed', 'the text in the message box changed while typing.');
      if (doc.activeElement !== box) box.focus();
      const chunk = lf(msg.chunk);
      writeValue(box, box.value + chunk, chunk === '\n' ? 'insertLineBreak' : 'insertText', chunk === '\n' ? null : chunk);
      if (box.value !== msg.before + chunk) return fail('changed', 'the message box did not take the text (it may have a length limit).');
      return { ok: true };
    }
    case 'compose:send': {
      const wrong = checkConversation(env, msg.buyer, msg.myUsername);
      if (wrong) return wrong;
      const box = findTextbox(doc);
      if (!box) return fail('no-box', 'the message box disappeared before sending.');
      if (box.value !== lf(msg.text)) return fail('changed', 'the text in the message box is not the confirmed text.');
      const found = findSendButton(doc);
      if (!('button' in found)) return found;
      const baseline = messageIds(doc);
      const warningsBefore = warningTexts(doc);
      found.button.click();
      return { ok: true, baseline, warningsBefore };
    }
    case 'compose:result':
      return checkResult(doc, msg.text, msg.baseline, msg.warningsBefore, msg.myUsername);
    case 'compose:clear': {
      const box = findTextbox(doc);
      if (!box || box.value !== lf(msg.text)) return { ok: true };
      writeValue(box, '', 'deleteContentBackward', null);
      return { ok: true };
    }
  }
}
