/**
 * Drives one confirmed reply on the watch tab: open the buyer's
 * conversation, type the text in small steps, click Send once, and watch
 * for the result. It only sends "compose:*" requests; the page work itself
 * is in src/content/composer.ts, the one module that writes to Fiverr.
 *
 * Why the steps are paced from here: the watch tab is usually hidden, and
 * Chrome runs timers in a hidden tab about once a second (after 5 minutes
 * hidden, as rarely as once a minute). A setTimeout loop in the content
 * script would type one chunk per second or slower. The service worker is
 * not a page, so its timers are not throttled that way; each step is a
 * message to the tab, and Chrome delivers messages to a hidden tab at once.
 * Every message is an extension API call, which also keeps the worker alive
 * during the send.
 *
 * Never retries a send. Anything that goes wrong before the click is "Not
 * sent" (failed). After the click: "sent" only when the own message shows in
 * the thread; a warning without it is "Not sent"; anything else is unknown.
 */
import type { ComposeRequest, ComposeResponse } from '../content/composer';
import { planTyping, type TypingStep } from '../lib/typing';

/** How long to wait for the own message after the click. */
export const CONFIRM_TIMEOUT_MS = 20_000;
export const CONFIRM_POLL_MS = 500;
/** After the own message shows, look this long more for a warning. */
export const CONFIRM_SETTLE_MS = 1_500;
/** A typing step the page does not answer within this is a failure. */
const STEP_TIMEOUT_MS = 5_000;

export type SendOutcome =
  | { state: 'sent'; at: number }
  | { state: 'failed'; reason: string }
  | { state: 'unknown'; reason: string };

export interface DriverPage {
  /** First step: waits for the page to load (retries until the content script answers). Throws on timeout. */
  prepare(msg: ComposeRequest): Promise<ComposeResponse>;
  /** Later steps: one try; null when the page did not answer in time. */
  ask(msg: ComposeRequest, timeoutMs: number): Promise<ComposeResponse | null>;
}

export interface DriverHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  plan?: (text: string) => TypingStep[];
  /** True when the profile was disconnected meanwhile: stop before the next step. */
  aborted?: () => boolean;
  /** Called right before the click (the own message must not alert). */
  beforeClick?: () => void | Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const notOk = (r: ComposeResponse | null): r is Extract<ComposeResponse, { ok: false }> => r !== null && r.ok === false;

export async function driveReply(page: DriverPage, buyer: string, text: string, myUsername: string | undefined, hooks: DriverHooks = {}): Promise<SendOutcome> {
  const sleep = hooks.sleep ?? realSleep;
  const now = hooks.now ?? Date.now;
  const aborted = hooks.aborted ?? (() => false);
  const stopped = { state: 'failed', reason: 'this profile was disconnected during the send.' } as const;

  // 1. The conversation, the header and an empty box.
  let ready: ComposeResponse;
  try {
    ready = await page.prepare({ type: 'compose:prepare', buyer, myUsername });
  } catch (e) {
    return { state: 'failed', reason: `the conversation did not load (${String((e as Error).message ?? e)}).` };
  }
  if (notOk(ready)) return { state: 'failed', reason: ready.reason };
  const maxLength = 'maxLength' in ready ? ready.maxLength : undefined;
  if (maxLength && text.length > maxLength) return { state: 'failed', reason: `the text is longer than the message box allows (${maxLength} characters).` };

  // 2. Type. `typed` is what the box must hold after each step.
  let typed = '';
  const clearTyped = async () => {
    if (typed) await page.ask({ type: 'compose:clear', text: typed }, STEP_TIMEOUT_MS).catch(() => null);
  };
  for (const step of (hooks.plan ?? planTyping)(text)) {
    await sleep(step.delayMs);
    if (aborted()) {
      await clearTyped();
      return stopped;
    }
    const res = await page.ask({ type: 'compose:type', buyer, myUsername, before: typed, chunk: step.text }, STEP_TIMEOUT_MS).catch(() => null);
    if (res === null) return { state: 'failed', reason: 'the Fiverr page stopped answering while typing. Part of the text may be left in the message box.' };
    if (notOk(res)) {
      // "changed": someone else's text is in the box now. Leave it alone.
      if (res.stop !== 'changed' && res.stop !== 'draft') await clearTyped();
      return { state: 'failed', reason: res.reason };
    }
    typed += step.text;
  }
  if (typed !== text) return { state: 'failed', reason: 'the typed text does not match.' };

  // 3. One click on Send, after the same checks again.
  await sleep(250 + Math.floor(Math.random() * 400));
  if (aborted()) {
    await clearTyped();
    return stopped;
  }
  await hooks.beforeClick?.();
  const sent = await page.ask({ type: 'compose:send', buyer, myUsername, text }, STEP_TIMEOUT_MS).catch(() => null);
  // No answer: the click may or may not have happened.
  if (sent === null) return { state: 'unknown', reason: 'the Fiverr page did not answer when Send was pressed.' };
  if (notOk(sent)) {
    if (sent.stop !== 'changed') await clearTyped();
    return { state: 'failed', reason: sent.reason };
  }
  const baseline = 'baseline' in sent ? (sent.baseline ?? []) : [];
  const warningsBefore = 'warningsBefore' in sent ? (sent.warningsBefore ?? []) : [];

  // 4. The result. Never a second click.
  const deadline = now() + CONFIRM_TIMEOUT_MS;
  let sentSeenAt: number | null = null;
  while (now() < deadline) {
    await sleep(CONFIRM_POLL_MS);
    const r = await page.ask({ type: 'compose:result', buyer, myUsername, text, baseline, warningsBefore }, STEP_TIMEOUT_MS).catch(() => null);
    if (!r || !r.ok || !('result' in r)) continue;
    if (r.result === 'blocked') {
      await clearTyped();
      return { state: 'failed', reason: `Fiverr showed: "${r.warning}"` };
    }
    if (r.result === 'unclear') return { state: 'unknown', reason: r.warning ? `Fiverr showed: "${r.warning}"` : 'the result is not clear.' };
    if (r.result === 'sent') {
      sentSeenAt ??= now();
      if (now() - sentSeenAt >= CONFIRM_SETTLE_MS) return { state: 'sent', at: sentSeenAt };
    }
  }
  if (sentSeenAt !== null) return { state: 'sent', at: sentSeenAt };
  return { state: 'unknown', reason: `the message did not show in the conversation within ${CONFIRM_TIMEOUT_MS / 1000} seconds.` };
}
