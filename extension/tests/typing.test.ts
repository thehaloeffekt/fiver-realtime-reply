import { describe, expect, it } from 'vitest';
import { TYPE_MAX_MS, planDuration, planTyping } from '../src/lib/typing';

/** Deterministic random numbers. */
function seeded(seed = 7) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

describe('planTyping', () => {
  it('the steps join to the exact text; line breaks are their own steps', () => {
    const text = 'Hello there.\n\nThe files are ready, see you soon!';
    const steps = planTyping(text, seeded());
    expect(steps.map((s) => s.text).join('')).toBe(text);
    expect(steps.filter((s) => s.text.includes('\n')).every((s) => s.text === '\n')).toBe(true);
    expect(steps.every((s) => s.text.length >= 1 && s.text.length <= 4)).toBe(true);
    expect(steps.every((s) => s.delayMs >= 70)).toBe(true);
  });

  it('a short reply takes a few seconds, like a fast typist', () => {
    const ms = planDuration(planTyping('Thanks, I will send it today.', seeded()));
    expect(ms).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(6000);
  });

  it('a 2,500-character reply is capped at 40 seconds', () => {
    const text = 'word '.repeat(500);
    const steps = planTyping(text, seeded());
    expect(steps.map((s) => s.text).join('')).toBe(text);
    expect(planDuration(steps)).toBeLessThanOrEqual(TYPE_MAX_MS);
    expect(planDuration(steps)).toBeGreaterThan(TYPE_MAX_MS * 0.5);
  });

  it('never splits an emoji', () => {
    const text = '👍🏽 ok 👨‍👩‍👧 done';
    const steps = planTyping(text, seeded(3));
    expect(steps.map((s) => s.text).join('')).toBe(text);
    for (const s of steps) expect(s.text.isWellFormed()).toBe(true);
    expect(steps.some((s) => s.text.includes('👨‍👩‍👧') || !s.text.includes('‍'))).toBe(true);
  });

  it('\\r\\n becomes \\n', () => {
    expect(planTyping('a\r\nb', seeded()).map((s) => s.text).join('')).toBe('a\nb');
  });
});
