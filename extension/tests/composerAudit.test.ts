/// <reference types="vite/client" />
/**
 * The read-only rule has one exception, and it lives in one file:
 * src/content/composer.ts. This test fails if any other source file types,
 * clicks, focuses or sends key events on a page, or uses the composer's
 * selectors, so the exception stays easy to audit.
 */
import { describe, expect, it } from 'vitest';

const SOURCES: Record<string, string> = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
const WRITER = '../src/content/composer.ts';

/** Patterns that change a page. */
const WRITES: Array<[string, RegExp]> = [
  ['.click()', /\.click\(\s*\)/],
  ['dispatchEvent', /dispatchEvent\(/],
  ['.focus()', /\.focus\(\s*\)/],
  ['execCommand', /execCommand\(/],
  ['the native value setter', /HTMLTextAreaElement\.prototype|HTMLInputElement\.prototype/],
  ['.value =', /\.value\s*=[^=]/],
  ['.submit()', /\.submit\(\s*\)/],
];

describe('write-code audit', () => {
  it('finds the source files', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(30);
    expect(SOURCES[WRITER]).toBeDefined();
  });

  it('no file but composer.ts writes to a page', () => {
    const hits: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      if (file === WRITER || file.includes('/entrypoints/options/') || file.includes('/entrypoints/popup/') || file.includes('/ui/')) continue;
      for (const [name, re] of WRITES) if (re.test(src)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it('only composer.ts uses the composer selectors', () => {
    const users = Object.entries(SOURCES)
      .filter(([file, src]) => file !== WRITER && file !== '../src/lib/selectors.ts' && /\bCOMPOSER(_FORBIDDEN)?\b/.test(src))
      .map(([file]) => file);
    expect(users).toEqual([]);
  });

  it('composer.ts sends no key events, never touches visibilityState, uploads nothing', () => {
    const src = SOURCES[WRITER]!;
    expect(src).not.toMatch(/KeyboardEvent|keydown|keypress|keyup/);
    expect(src).not.toMatch(/visibilityState\s*=|defineProperty\([^)]*visibilityState/);
    expect(src).not.toMatch(/DataTransfer|\.files\s*=|FileList/);
    // It clicks exactly one thing: the Send button it found.
    expect(src.match(/\.click\(\s*\)/g)).toHaveLength(1);
    expect(src).toMatch(/found\.button\.click\(\)/);
  });

  it('nothing in the extension spoofs document.visibilityState', () => {
    for (const [file, src] of Object.entries(SOURCES)) {
      expect(`${file}: ${/defineProperty\(\s*document\s*,\s*['"]visibilityState/.test(src)}`).toBe(`${file}: false`);
    }
  });
});
