/**
 * The typing plan for "Send replies from Telegram": the text cut into small
 * chunks, each with a pause before it, so the message box fills at a
 * person's pace instead of all at once.
 *
 * Numbers:
 * - Chunks of 1–4 characters with 70–220 ms before each: about 2.5
 *   characters per 145 ms, roughly 17 characters (3–4 words) a second. That
 *   is a fast typist, so a short reply takes a few seconds, not a minute.
 * - A longer pause after a space (+0–150 ms), after . , ! ? (+150–400 ms) and
 *   before a line break (250–600 ms), as people pause there.
 * - The whole plan is capped at TYPE_MAX_MS (40 s). Over that, chunks get
 *   longer (the number of steps stays about the same) and, if needed, every
 *   pause is scaled down. Why 40 s: the preview is confirmed by then, the
 *   watch tab cannot reload or show another conversation during the send,
 *   and the user waits in Telegram for "Sent". A 2,500-character reply at a
 *   human 17 chars/s would take 2.5 minutes.
 * - Line breaks are their own step (an "insertLineBreak" input), and the
 *   text is cut between graphemes, so an emoji is never split.
 */

export const TYPE_MAX_MS = 40_000;
const CHUNK_MIN = 1;
const CHUNK_MAX = 4;
const DELAY_MIN = 70;
const DELAY_MAX = 220;
const AVG_STEP_MS = 160;

export interface TypingStep {
  /** Pause before this step, in ms. */
  delayMs: number;
  text: string;
}

function graphemes(text: string): string[] {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  return Array.from(text);
}

const between = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/** The plan for `text`. `rand` is Math.random outside tests. */
export function planTyping(text: string, rand: () => number = Math.random, maxMs = TYPE_MAX_MS): TypingStep[] {
  const chars = graphemes(text.replace(/\r\n?/g, '\n'));
  // Steps a 1–4 chunk plan would take; above the cap, scale the chunk size up.
  const estimate = (chars.length / ((CHUNK_MIN + CHUNK_MAX) / 2)) * AVG_STEP_MS;
  const scale = Math.max(1, Math.ceil(estimate / maxMs));
  const steps: TypingStep[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '\n') {
      steps.push({ delayMs: between(rand, 250, 600), text: '\n' });
      i++;
      continue;
    }
    const size = between(rand, CHUNK_MIN * scale, CHUNK_MAX * scale);
    let chunk = '';
    for (let n = 0; n < size && i < chars.length && chars[i] !== '\n'; n++) chunk += chars[i++];
    const prev = steps.at(-1)?.text.slice(-1) ?? '';
    let delay = between(rand, DELAY_MIN, DELAY_MAX);
    if (prev === ' ') delay += between(rand, 0, 150);
    if (/[.,!?;:]/.test(prev)) delay += between(rand, 150, 400);
    steps.push({ delayMs: delay, text: chunk });
  }
  if (steps.length) steps[0]!.delayMs = between(rand, 300, 700); // "finding the box"
  const total = steps.reduce((t, s) => t + s.delayMs, 0);
  if (total > maxMs) {
    const f = maxMs / total;
    for (const s of steps) s.delayMs = Math.floor(s.delayMs * f);
  }
  return steps;
}

export const planDuration = (steps: TypingStep[]) => steps.reduce((t, s) => t + s.delayMs, 0);
