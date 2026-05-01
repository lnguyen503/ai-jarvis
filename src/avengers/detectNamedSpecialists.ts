/**
 * Detect specialists named in a user prompt for orchestrator-mode steering
 * (v1.22.42).
 *
 * Background: Boss writes Avengers prompts like
 *   "Tony — concrete migration cost. ... Natasha — find one benchmark. ...
 *    Bruce — break-even analysis. ..."
 *
 * The orchestrator (Jarvis) is supposed to call delegate_to_specialist once
 * per named specialist. With smaller open-source models (minimax-m2.7) we
 * observed plans where Jarvis dropped one of the three delegations entirely
 * — plan #8 ran with only Tony + Natasha steps despite the user naming all
 * three. Even when delegations succeed, ordering can race so a junk
 * "I'm waiting on inputs" reply lands first and gets recorded as the step's
 * work.
 *
 * This module gives the gateway a deterministic way to extract the explicit
 * specialist list from the user's text. The gateway uses it to (a) inject a
 * mandatory-delegation note into the orchestrator's user message, and (b)
 * audit the post-turn delegation count against the expected set.
 *
 * Detection rule: a specialist counts as "named" when their first name (case-
 * insensitive) appears followed by a directive separator — em-dash, en-dash,
 * hyphen, colon, or comma — within a few chars. This matches Boss's typical
 * shape ("Tony —", "Tony,", "Tony:") without flagging incidental mentions
 * like "as Tony said earlier" or "remember that Tony was…".
 *
 * Closed set is hardcoded: only the three specialist personas in v1.22.x.
 * Adding a new specialist means: extend BOT_NAMES + this set together.
 */

export type NamedSpecialist = 'ai-tony' | 'ai-natasha' | 'ai-bruce';

interface SpecialistAlias {
  bot: NamedSpecialist;
  display: string;
  /**
   * Anchor regex: name + directive separator (— – - : ,) within 3 chars,
   * case-insensitive, word-boundary anchored. Surrounding whitespace is
   * tolerated. Matches "Tony —", "Tony:", "Tony,", "tony - " but NOT
   * "anthony" or "Tony said".
   */
  pattern: RegExp;
}

const SPECIALIST_ALIASES: SpecialistAlias[] = [
  {
    bot: 'ai-tony',
    display: 'Tony',
    pattern: /\btony\s*[—–\-:,]\s*\S/i,
  },
  {
    bot: 'ai-natasha',
    display: 'Natasha',
    pattern: /\bnatasha\s*[—–\-:,]\s*\S/i,
  },
  {
    bot: 'ai-bruce',
    display: 'Bruce',
    pattern: /\bbruce\s*[—–\-:,]\s*\S/i,
  },
];

export interface NamedSpecialistResult {
  /** Canonical bot names found, deduplicated, in source order. */
  names: NamedSpecialist[];
  /** Display labels parallel to `names` — for the steering note text. */
  displays: string[];
  /**
   * Per-specialist task text. Keys are the canonical bot names. Value is the
   * substring of `userText` between this specialist's directive separator
   * and the next specialist's name (or end of text). Used by the gateway as
   * the deterministic-delegation fallback when the orchestrator LLM
   * (minimax-m2.7) returns toolCallCount: 0 despite the steering note.
   * Empty string if the section couldn't be sliced (defensive default).
   */
  tasks: Partial<Record<NamedSpecialist, string>>;
}

/**
 * Scan `userText` for explicit specialist directives. Returns the deduplicated
 * canonical name list. Empty array means no specialists were addressed by name.
 */
export function detectNamedSpecialists(userText: string): NamedSpecialistResult {
  const names: NamedSpecialist[] = [];
  const displays: string[] = [];
  // Collect (bot, startIndex) for every directive match so we can slice
  // per-specialist task text in source order.
  const matches: Array<{ bot: NamedSpecialist; display: string; start: number; sepEnd: number }> = [];
  for (const alias of SPECIALIST_ALIASES) {
    const m = alias.pattern.exec(userText);
    if (m) {
      names.push(alias.bot);
      displays.push(alias.display);
      // Find the end of the separator (first non-name, non-separator char).
      // m.index points to the start of the name; m[0] includes name + sep + 1
      // content char. We want the position right after the separator.
      const tail = m[0];
      // The last char of m[0] is the first content char; everything before
      // it from the name end is the separator block.
      const sepEnd = m.index + tail.length - 1;
      matches.push({ bot: alias.bot, display: alias.display, start: m.index, sepEnd });
    }
  }

  // Sort matches by their position in the text so we can slice between them.
  matches.sort((a, b) => a.start - b.start);

  const tasks: Partial<Record<NamedSpecialist, string>> = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1];
    const sliceStart = cur.sepEnd;
    const sliceEnd = next ? next.start : userText.length;
    const raw = userText.slice(sliceStart, sliceEnd).trim();
    // Cap individual task text at 1500 chars — Telegram-friendly and well
    // under any reasonable per-step request budget.
    tasks[cur.bot] = raw.slice(0, 1500);
  }

  return { names, displays, tasks };
}
