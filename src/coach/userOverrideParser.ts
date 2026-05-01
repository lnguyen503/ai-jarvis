/**
 * NL override parser — pure function, no side effects (v1.19.0 D3 amended per R3).
 *
 * ADR 019 Decision 3 (R3 amendment): the parser is PURE.
 * It does NOT write to keyed memory, does NOT call tools, does NOT emit audit rows.
 * It only parses user messages and returns a list of OverrideIntent objects.
 * The caller (coach_log_user_override tool in commit 4b) is responsible for writing.
 *
 * Usage:
 *   const intents = parseOverrideIntents(messages, items);
 *   // Intents are just data; call coach_log_user_override to record them.
 *
 * Design decisions (ADR 019 R3):
 *   - Stop-word filter reduces false positives on common words.
 *   - Fuzzy match threshold 0.7 (raised from 0.6 per R3; requires ≥70% of title tokens match).
 *   - Negation window: 8 tokens before intent verb inverts intent (e.g. "don't skip" → push).
 *   - Multi-item ambiguity: pick most-recently-mutated item (max `updated` field).
 *   - Zero-match: no entry returned; caller logs warn.
 *
 * Dependency edges (binding per ADR 018 Decision 15 + ADR 019 R3 + ADR 020 D16):
 *   userOverrideParser.ts → organize/types (Item shape — read-only)
 *   userOverrideParser.ts → coach/textPatternMatcher (USES the shared fuzzy-match algorithm — ADR 020 D10 SSOT)
 *   NO import from agent/, tools/, memory/, or commands/.
 *   NO import from coach/index.ts.
 */

import type { OrganizeItem } from '../organize/types.js';
import {
  FUZZY_MATCH_THRESHOLD as _FUZZY_MATCH_THRESHOLD,
  tokenize,
  jaccardScore as _jaccardScoreShared,
  negationDetected,
} from './textPatternMatcher.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OverrideIntentKind = 'back_off' | 'push' | 'defer' | 'done_signal';

export interface OverrideIntent {
  /** Organize item ID this intent applies to. */
  itemId: string;
  /** Type of override the user expressed. */
  intent: OverrideIntentKind;
  /** Jaccard similarity score (0..1) of the fuzzy item match. */
  fuzzyScore: number;
  /** Original user message that triggered this intent (for audit; truncated at 500 chars). */
  fromMessage: string;
}

// ---------------------------------------------------------------------------
// Constants (re-exported from textPatternMatcher — ADR 020 D10 SSOT)
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity threshold for item-title fuzzy matching.
 * Must be ≥ this value to record an override intent.
 * ADR 019 R3: raised from 0.6 → 0.7.
 *
 * Re-exported from textPatternMatcher.ts per ADR 020 D10 SSOT rule.
 * Import from textPatternMatcher.ts directly for new consumers.
 */
export const FUZZY_MATCH_THRESHOLD = _FUZZY_MATCH_THRESHOLD;

/**
 * Token window (before the intent verb) to scan for negation markers.
 * ADR 019 R3: 8 tokens.
 */
export const NEGATION_TOKEN_WINDOW = 8;

/**
 * Maximum characters from fromMessage stored on the intent.
 * Aligns with coachOverrideTool.ts cap for the fromMessage field.
 */
const MAX_FROM_MESSAGE_CHARS = 500;

// ---------------------------------------------------------------------------
// Intent patterns (ADR 019 D3 + R3)
// ---------------------------------------------------------------------------

interface IntentPattern {
  kind: OverrideIntentKind;
  re: RegExp;
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    kind: 'back_off',
    re: /\b(?:back\s+off|stop\s+bugging|leave\s+me\s+alone|don'?t\s+push|stop\s+nagging|skip|pause|hold\s+off\s+on|chill\s+on|leave\s+alone)\b/i,
  },
  {
    kind: 'push',
    re: /\b(?:push\s+(?:me|harder)|push\s+me\s+(?:harder|more)|focus\s+more|prioritize|nag\s+me\s+about|stay\s+on|don'?t\s+let\s+me\s+forget|harder\s+on)\b/i,
  },
  {
    kind: 'defer',
    re: /\b(?:remind\s+(?:me\s+)?(?:about|of)\s+.{1,40}\s+(?:tomorrow|later|next\s+week)|later|tomorrow|next\s+week|after|once\s+i'?ve?\s+finished)\b/i,
  },
  {
    kind: 'done_signal',
    re: /\b(?:i'?m\s+done\s+with|i\s+finished|completed|finished|wrapped\s+up)\b/i,
  },
];

// ---------------------------------------------------------------------------
// Negation detection (delegated to textPatternMatcher — ADR 020 D10 SSOT)
// ---------------------------------------------------------------------------

/**
 * Flip an intent based on negation.
 * push → back_off, back_off → push. defer/done_signal unchanged.
 */
function flipIntent(kind: OverrideIntentKind): OverrideIntentKind {
  if (kind === 'push') return 'back_off';
  if (kind === 'back_off') return 'push';
  return kind;
}

// jaccardScore is imported from textPatternMatcher as _jaccardScoreShared.
// Call it with Set<string> wrappers at each call site (ADR 020 D10 SSOT — no local wrapper).

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a list of recent user messages and match intent verbs to item titles.
 *
 * Returns a list of OverrideIntent objects (may be empty).
 * Pure function — no side effects, no async, no imports from tools or memory.
 *
 * ADR 019 R3 amended decision 3.
 */
export function parseOverrideIntents(
  messages: string[],
  items: OrganizeItem[],
): OverrideIntent[] {
  const results: OverrideIntent[] = [];

  for (const rawMessage of messages) {
    if (!rawMessage || rawMessage.trim().length === 0) continue;

    // Split into sentences for per-sentence negation resolution.
    const sentences = rawMessage.split(/[.!?]+/).filter((s) => s.trim().length > 0);

    for (const sentence of sentences) {
      const sentenceTokens = sentence.toLowerCase().split(/\s+/);

      for (const pattern of INTENT_PATTERNS) {
        const match = pattern.re.exec(sentence);
        if (!match) continue;

        // Find the approximate token index of the match for negation window
        const matchStart = match.index;
        const textBefore = sentence.slice(0, matchStart);
        const tokensBefore = textBefore.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
        const matchTokenIdx = tokensBefore.length;

        // Check for negation before the match within NEGATION_TOKEN_WINDOW
        // Delegates to shared negationDetected() from textPatternMatcher (ADR 020 D10 SSOT).
        const negated = negationDetected(sentenceTokens, matchTokenIdx, NEGATION_TOKEN_WINDOW);
        const effectiveIntent: OverrideIntentKind = negated ? flipIntent(pattern.kind) : pattern.kind;

        // Fuzzy-match the remaining phrase against item titles
        // Use the portion of sentence AFTER the intent verb as the "item reference"
        const afterMatch = sentence.slice(matchStart + match[0].length).trim();
        const phraseForMatch = afterMatch.length > 0 ? afterMatch : sentence;
        const phraseTokens = tokenize(phraseForMatch);

        // Also try full sentence tokens for broader coverage
        const fullSentenceTokens = tokenize(sentence);

        // Find best matching item
        let bestItem: OrganizeItem | null = null;
        let bestScore = 0;

        for (const item of items) {
          const titleTokens = tokenize(item.frontMatter.title);
          // Use shared jaccardScore with Set<string> wrappers (ADR 020 D10 SSOT — no local wrapper)
          const scoreAfter = _jaccardScoreShared(new Set(titleTokens), new Set(phraseTokens));
          const scoreFull = _jaccardScoreShared(new Set(titleTokens), new Set(fullSentenceTokens));
          const score = Math.max(scoreAfter, scoreFull);

          if (score > bestScore) {
            bestScore = score;
            bestItem = item;
          } else if (score === bestScore && bestItem !== null) {
            // Tie-break: prefer most-recently-mutated item
            const itemUpdated = item.frontMatter.updated ?? item.frontMatter.created;
            const bestUpdated = bestItem.frontMatter.updated ?? bestItem.frontMatter.created;
            if (itemUpdated > bestUpdated) {
              bestItem = item;
            }
          }
        }

        if (bestItem !== null && bestScore >= FUZZY_MATCH_THRESHOLD) {
          results.push({
            itemId: bestItem.frontMatter.id,
            intent: effectiveIntent,
            fuzzyScore: bestScore,
            fromMessage: rawMessage.slice(0, MAX_FROM_MESSAGE_CHARS),
          });
        }
        // Zero-match or below-threshold: no result added (caller logs warn)
        // Only process the first matching pattern per sentence
        break;
      }
    }
  }

  return results;
}
