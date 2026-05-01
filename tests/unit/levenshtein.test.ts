/**
 * Unit tests for src/utils/levenshtein.ts (v1.14.3 R5).
 *
 * Covers boundary cases including empty strings, same strings,
 * single edits, and item-id-shaped inputs.
 */

import { describe, it, expect } from 'vitest';
import { levenshtein } from '../../src/utils/levenshtein.js';

describe('levenshtein()', () => {
  it('L-1: identical strings → 0', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('2026-04-25-abcd', '2026-04-25-abcd')).toBe(0);
  });

  it('L-2: empty string vs non-empty → length of non-empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'x')).toBe(1);
  });

  it('L-3: single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
    expect(levenshtein('kitten', 'sitten')).toBe(1);
  });

  it('L-4: single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  it('L-5: classic example — kitten → sitting = 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('L-6: item-id typo — one char off at suffix', () => {
    // '2026-04-20-abcd' vs '2026-04-20-abce' → 1 substitution
    expect(levenshtein('2026-04-20-abcd', '2026-04-20-abce')).toBe(1);
  });

  it('L-7: item-id typo — two chars off', () => {
    expect(levenshtein('2026-04-20-abcd', '2026-04-20-abef')).toBe(2);
  });

  it('L-8: completely different strings → distance = max(len) for short ones', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });

  it('L-9: symmetric — levenshtein(a,b) === levenshtein(b,a)', () => {
    expect(levenshtein('2026-04-20-abcd', '2026-04-20-efgh')).toBe(
      levenshtein('2026-04-20-efgh', '2026-04-20-abcd'),
    );
  });

  it('L-10: deletion at end', () => {
    expect(levenshtein('hello', 'hell')).toBe(1);
  });
});
