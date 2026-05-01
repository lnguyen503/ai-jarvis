/**
 * Per-bot directive detection (v1.23.0).
 *
 * Wraps detectNamedSpecialists with full 4-bot coverage (Jarvis + 3 specialists)
 * and a "this bot's view" projection. Used by every bot's gateway to decide:
 *
 *   1. Did the user write a directive (`Tony — X`, `Bruce, Y`, `Jarvis: Z`)?
 *   2. Is THIS bot the one being directed?
 *   3. What is the task text for this bot?
 *
 * Decision tree on result:
 *   hasDirectives=false  → fall through to existing mention/alias routing
 *   thisBotNamed=true    → activate in WORK mode with `taskForThisBot`
 *   thisBotNamed=false   → SILENT (someone else is being addressed)
 *
 * The "directive present but not for me → silent" rule is the load-bearing
 * change. It eliminates the failure mode where Bruce chimes in on a prompt
 * directed at Tony just because a casual "Bruce" mention is elsewhere in
 * the message.
 *
 * Detection rule (inherited from detectNamedSpecialists): bot name + directive
 * separator (em-dash, en-dash, hyphen, colon, comma) within 3 chars,
 * case-insensitive, word-boundary anchored. Matches "Tony —", "Tony,", "Tony:"
 * but NOT incidental mentions like "as Tony said earlier".
 */

import type { BotName } from '../config/botIdentity.js';
import { detectNamedSpecialists, type NamedSpecialist } from './detectNamedSpecialists.js';

interface JarvisAlias {
  display: string;
  pattern: RegExp;
}

const JARVIS_ALIAS: JarvisAlias = {
  display: 'Jarvis',
  pattern: /\bjarvis\s*[—–\-:,]\s*\S/i,
};

export interface DirectiveDetectionResult {
  /** Any bot named with a directive separator? */
  hasDirectives: boolean;
  /** Is THIS bot one of the named bots? */
  thisBotNamed: boolean;
  /** Task text for THIS bot, or null if not named. */
  taskForThisBot: string | null;
  /** All bots named (deduplicated, in source order). For plan creation. */
  allNamedBots: BotName[];
  /** Task text per named bot. Used by Jarvis to seed plan steps. */
  taskByBot: Partial<Record<BotName, string>>;
}

/**
 * Detect directives in `userText` and project the result for `thisBotName`.
 * Pass the bot name as an argument (rather than threading BotIdentity) so the
 * function is easy to call from any context (gateway, tests).
 */
export function detectDirective(
  userText: string,
  thisBotName: BotName,
): DirectiveDetectionResult {
  // Specialists first (existing helper).
  const specialists = detectNamedSpecialists(userText);

  // Jarvis directive — separate scan because detectNamedSpecialists is
  // hardcoded to the 3 specialist set.
  const jarvisMatch = JARVIS_ALIAS.pattern.exec(userText);
  let jarvisTask: string | null = null;
  if (jarvisMatch) {
    // Slice from end-of-separator to either the next named bot or end-of-text.
    // We approximate end-of-separator as match.index + (match.length - 1)
    // to mirror detectNamedSpecialists' sepEnd logic.
    const sepEnd = jarvisMatch.index + jarvisMatch[0].length - 1;
    // If specialists were also named, the next specialist's start is the
    // upper bound; otherwise end-of-text.
    let sliceEnd = userText.length;
    for (const s of Object.keys(specialists.tasks) as NamedSpecialist[]) {
      // Find this specialist's start position by re-running their pattern.
      // Cheap because the specialist set is size 3.
      const re = SPECIALIST_PATTERNS[s];
      if (!re) continue;
      const m = re.exec(userText);
      if (m && m.index > sepEnd && m.index < sliceEnd) {
        sliceEnd = m.index;
      }
    }
    jarvisTask = userText.slice(sepEnd, sliceEnd).trim().slice(0, 1500);
  }

  const allNamedBots: BotName[] = [];
  const taskByBot: Partial<Record<BotName, string>> = {};

  if (jarvisMatch) {
    allNamedBots.push('ai-jarvis');
    if (jarvisTask) taskByBot['ai-jarvis'] = jarvisTask;
  }
  for (const s of specialists.names) {
    allNamedBots.push(s);
    const t = specialists.tasks[s];
    if (t) taskByBot[s] = t;
  }

  const hasDirectives = allNamedBots.length > 0;
  const thisBotNamed = allNamedBots.includes(thisBotName);
  const taskForThisBot = thisBotNamed ? taskByBot[thisBotName] ?? null : null;

  return {
    hasDirectives,
    thisBotNamed,
    taskForThisBot,
    allNamedBots,
    taskByBot,
  };
}

// ---------------------------------------------------------------------------
// Local mirror of the specialist patterns. Kept private so detectNamedSpecialists
// remains the single source of truth for specialist directive detection.
// ---------------------------------------------------------------------------

const SPECIALIST_PATTERNS: Partial<Record<BotName, RegExp>> = {
  'ai-tony': /\btony\s*[—–\-:,]\s*\S/i,
  'ai-natasha': /\bnatasha\s*[—–\-:,]\s*\S/i,
  'ai-bruce': /\bbruce\s*[—–\-:,]\s*\S/i,
};
