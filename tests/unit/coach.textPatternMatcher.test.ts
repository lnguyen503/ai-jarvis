/**
 * Unit tests for src/coach/textPatternMatcher.ts (v1.20.0 commit 0c).
 *
 * ADR 020 D10 SSOT: textPatternMatcher is the single source of truth for
 * fuzzy item-title matching and tokenization.
 *
 * Tests:
 *   - tokenize(): stop-word filtering, lowercase, split on non-word chars
 *   - STOP_WORDS: basic membership
 *   - FUZZY_MATCH_THRESHOLD: is 0.7
 *   - jaccardScore(): exact match, partial match, below-threshold, empty sets
 *   - negationDetected(): detects negation within window, misses negation outside window
 */

import { describe, it, expect } from 'vitest';
import {
  tokenize,
  STOP_WORDS,
  FUZZY_MATCH_THRESHOLD,
  jaccardScore,
  negationDetected,
} from '../../src/coach/textPatternMatcher.js';

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases and splits on non-word chars', () => {
    const result = tokenize('Hello, World!');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('filters stop words', () => {
    const result = tokenize('the exercise and my goal');
    expect(result).not.toContain('the');
    expect(result).not.toContain('and');
    expect(result).not.toContain('my');
    expect(result).toContain('exercise');
    expect(result).toContain('goal');
  });

  it('filters tokens of length <= 1', () => {
    const result = tokenize('a b exercise');
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
    expect(result).toContain('exercise');
  });

  it('returns empty array for stop-word-only text', () => {
    const result = tokenize('the a an');
    expect(result).toEqual([]);
  });

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// STOP_WORDS
// ---------------------------------------------------------------------------

describe('STOP_WORDS', () => {
  it('contains common words', () => {
    expect(STOP_WORDS.has('the')).toBe(true);
    expect(STOP_WORDS.has('a')).toBe(true);
    expect(STOP_WORDS.has('i')).toBe(true);
  });

  it('does not contain meaningful nouns', () => {
    expect(STOP_WORDS.has('exercise')).toBe(false);
    expect(STOP_WORDS.has('project')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FUZZY_MATCH_THRESHOLD
// ---------------------------------------------------------------------------

describe('FUZZY_MATCH_THRESHOLD', () => {
  it('is 0.7 (ADR 019 R3)', () => {
    expect(FUZZY_MATCH_THRESHOLD).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// jaccardScore
// ---------------------------------------------------------------------------

describe('jaccardScore', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['exercise', 'project']);
    const b = new Set(['exercise', 'project']);
    expect(jaccardScore(a, b)).toBe(1.0);
  });

  it('returns 0 for empty sets', () => {
    expect(jaccardScore(new Set(), new Set(['exercise']))).toBe(0);
    expect(jaccardScore(new Set(['exercise']), new Set())).toBe(0);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['exercise']);
    const b = new Set(['retirement']);
    // "exercise" and "retirement" share no substring either
    const score = jaccardScore(a, b);
    expect(score).toBe(0);
  });

  it('handles substring matching', () => {
    const a = new Set(['exercise']);
    const b = new Set(['exercises']);
    // "exercises" includes "exercise" → hits
    expect(jaccardScore(a, b)).toBeGreaterThan(0);
  });

  it('returns high score for superset coverage', () => {
    const titleTokens = new Set(['exercise']); // short title
    const phraseTokens = new Set(['exercise', 'routine', 'daily']); // phrase covers title
    // phraseCoverage = 1/3, titleCoverage = 1/1 = 1.0
    expect(jaccardScore(titleTokens, phraseTokens)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// negationDetected
// ---------------------------------------------------------------------------

describe('negationDetected', () => {
  it('returns true when negation is within window', () => {
    const tokens = ["don't", 'push', 'me', 'on', 'exercise'];
    // verbIdx = 1 (push), window = 8
    expect(negationDetected(tokens, 1, 8)).toBe(true);
  });

  it('returns false when negation is outside window', () => {
    const tokens = ["don't", 'care', 'about', 'that', 'at', 'all', 'just', 'push', 'me', 'on', 'exercise'];
    // verbIdx = 7 (push), window = 3 — "don't" is at idx 0, outside window
    expect(negationDetected(tokens, 7, 3)).toBe(false);
  });

  it('returns false with no negation in tokens', () => {
    const tokens = ['please', 'push', 'me', 'on', 'exercise'];
    expect(negationDetected(tokens, 1, 8)).toBe(false);
  });

  it('returns false for empty tokens', () => {
    expect(negationDetected([], 0, 8)).toBe(false);
  });

  it('handles "not" as negation', () => {
    const tokens = ['not', 'skip'];
    expect(negationDetected(tokens, 1, 8)).toBe(true);
  });

  it('handles "won\'t" as negation', () => {
    const tokens = ["won't", 'back', 'off'];
    expect(negationDetected(tokens, 2, 8)).toBe(true);
  });
});
