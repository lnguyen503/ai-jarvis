/**
 * Shared text-pattern matching utilities (v1.20.0 commit 0c).
 *
 * Extracted from userOverrideParser.ts per Anti-Slop §6 SSOT — single source
 * of truth for fuzzy item-title matching and tokenization.
 *
 * Used by:
 *   - src/coach/userOverrideParser.ts (NL override parser)
 *   - src/coach/chatMonitor.ts (event-trigger chat pattern detector)
 *
 * Dependency edges (binding per ADR 020 D16):
 *   textPatternMatcher.ts → (no internal deps; pure functions only)
 *   NO import from agent/, tools/, memory/, commands/, or coach/*.
 *
 * ADR 020 Decision 10 + D16 (R2 — Anti-Slop §6 single-source-of-truth).
 */

// ---------------------------------------------------------------------------
// Stop words (shared across NL parser + chat monitor)
// ---------------------------------------------------------------------------

/**
 * Stop-word set for token filtering.
 * Shared by userOverrideParser.ts and chatMonitor.ts.
 * ADR 019 R3 origin; ADR 020 D10 SSOT extraction.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by',
  'with', 'my', 'your', 'this', 'that', 'these', 'those', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'i', 'me', 'do', 'did', 'it', 'its',
]);

// ---------------------------------------------------------------------------
// Fuzzy match constants
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity threshold for item-title fuzzy matching.
 * Must be ≥ this value to record an intent match.
 * ADR 019 R3: raised from 0.6 → 0.7.
 * ADR 020 D10: exported here as SSOT; consumers import from this module.
 */
export const FUZZY_MATCH_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase tokens, filtering stop words and short tokens.
 *
 * Used by:
 *   - jaccardScore() for item-title fuzzy matching
 *   - chatMonitor.ts for chat-pattern token analysis
 *
 * ADR 020 D10 SSOT extraction from userOverrideParser.ts.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

/**
 * Compute fuzzy match score between two sets of tokens.
 *
 * ADR 019 R3 spec: "0.7 requires that ≥70% of stop-word-filtered title tokens find a match."
 * Implements: max(titleCoverage, phraseCoverage) using substring-enabled matching.
 *
 * - titleCoverage = |title tokens matching phrase| / |title tokens|
 * - phraseCoverage = |phrase tokens matching title| / |phrase tokens|
 *
 * Taking the max handles asymmetric cases: a short phrase matching a long title
 * (phrase coverage high), or a short title appearing in a long phrase (title coverage high).
 *
 * Substring matching: "exercise" matches "exercises", "exercising", etc.
 *
 * Returns score in [0, 1].
 *
 * ADR 020 D10 SSOT extraction from userOverrideParser.ts.
 */
export function jaccardScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  function countMatches(setA: Set<string>, setB: Set<string>): number {
    let hits = 0;
    for (const x of setA) {
      if (setB.has(x)) {
        hits++;
      } else {
        for (const y of setB) {
          if (x.includes(y) || y.includes(x)) {
            hits++;
            break;
          }
        }
      }
    }
    return hits;
  }

  const aHits = countMatches(a, b);
  const bHits = countMatches(b, a);

  const aCoverage = aHits / a.size;
  const bCoverage = b.size > 0 ? bHits / b.size : 0;

  return Math.max(aCoverage, bCoverage);
}

// ---------------------------------------------------------------------------
// Negation detection
// ---------------------------------------------------------------------------

const NEGATION_RE = /\b(?:not|don'?t|do\s+not|won'?t|can'?t|never)\b/i;

/**
 * Detect if a negation token exists within `windowSize` tokens BEFORE
 * `verbIdx` in the tokenized sentence.
 *
 * ADR 019 D3 + R3: negation window = 8 tokens (NEGATION_TOKEN_WINDOW).
 * ADR 020 D10 SSOT extraction from userOverrideParser.ts.
 *
 * @param tokens    Tokenized sentence (from text.toLowerCase().split(/\s+/)).
 * @param verbIdx   Index of the intent-verb token in `tokens`.
 * @param windowSize  Number of tokens before verbIdx to scan (binding: 8 per R3).
 */
export function negationDetected(tokens: string[], verbIdx: number, windowSize: number): boolean {
  const start = Math.max(0, verbIdx - windowSize);
  for (let i = start; i < verbIdx; i++) {
    const tok = tokens[i];
    if (tok !== undefined && NEGATION_RE.test(tok)) return true;
  }
  return false;
}
