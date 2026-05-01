/**
 * Static test — ADR 020 D16: textPatternMatcher.ts is the SOLE owner of fuzzy
 * item-title matching + tokenization (Anti-Slop §6 SSOT).
 *
 * Binding assertions:
 *   1. userOverrideParser.ts imports from textPatternMatcher (not duplicating tokenize/jaccardScore)
 *   2. The literal 'function tokenize' does NOT appear in userOverrideParser.ts
 *   3. The literal 'function jaccardScore' does NOT appear in userOverrideParser.ts
 *   4. userOverrideParser.ts has an import from './textPatternMatcher'
 *
 * ADR 020 D16 commit 0c binding.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../');
const PARSER_PATH = path.join(ROOT, 'src', 'coach', 'userOverrideParser.ts');
const MATCHER_PATH = path.join(ROOT, 'src', 'coach', 'textPatternMatcher.ts');

const parserSrc = readFileSync(PARSER_PATH, 'utf8');
const matcherSrc = readFileSync(MATCHER_PATH, 'utf8');

describe('ADR 020 D16: textPatternMatcher SSOT — no duplication in userOverrideParser', () => {
  it('userOverrideParser.ts imports from ./textPatternMatcher', () => {
    expect(parserSrc).toMatch(/from\s+['"]\.\/textPatternMatcher/);
  });

  it('userOverrideParser.ts does not define a local "function tokenize"', () => {
    // The function must come from textPatternMatcher, not be redefined locally
    expect(parserSrc).not.toMatch(/^\s*function tokenize\s*\(/m);
  });

  it('userOverrideParser.ts does not define a local "function jaccardScore"', () => {
    // The jaccardScore function must come from textPatternMatcher (via wrapper or direct)
    expect(parserSrc).not.toMatch(/^\s*function jaccardScore\s*\(/m);
  });

  it('textPatternMatcher.ts exports tokenize', () => {
    expect(matcherSrc).toMatch(/export function tokenize/);
  });

  it('textPatternMatcher.ts exports jaccardScore', () => {
    expect(matcherSrc).toMatch(/export function jaccardScore/);
  });

  it('textPatternMatcher.ts exports FUZZY_MATCH_THRESHOLD', () => {
    expect(matcherSrc).toMatch(/export const FUZZY_MATCH_THRESHOLD/);
  });

  it('textPatternMatcher.ts exports STOP_WORDS', () => {
    expect(matcherSrc).toMatch(/export const STOP_WORDS/);
  });

  it('textPatternMatcher.ts exports negationDetected', () => {
    expect(matcherSrc).toMatch(/export function negationDetected/);
  });
});
