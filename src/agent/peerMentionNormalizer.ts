/**
 * Peer-bot @-mention normalizer (v1.21.9).
 *
 * LLMs frequently emit malformed Telegram usernames — dropping
 * underscores or hyphens — when @-mentioning peer bots. Example:
 *   Canonical: @your_tony_bot
 *   LLM-emitted: @aiTonyStark_bot, @aitonystarkbot, @ai-tony, @tony_bot
 *
 * Telegram only renders @-handles as MENTION entities when they match
 * an existing user's username exactly. Variants get sent as plain text
 * and the receiving bot never sees a mention — silent delivery failure.
 *
 * This module fuzzy-matches every `@\w+` substring in a reply against
 * known bot identifiers (canonical Telegram username + BotName +
 * aliases) by stripping separators and lowercasing both sides. On a
 * match, the @-handle is rewritten to the canonical Telegram username
 * so Telegram resolves it as a real mention.
 *
 * BINDING: only applies when BOT_TELEGRAM_USERNAMES has a non-empty
 * canonical username for the matched bot. Bots without deployed
 * usernames (ai-natasha, ai-bruce until BotFather setup) are skipped —
 * the LLM's @-text is left as-is.
 */

import {
  BOT_NAMES,
  BOT_TELEGRAM_USERNAMES,
  BOT_ALIASES_BY_NAME,
  type BotName,
} from '../config/botIdentity.js';

/**
 * Lowercase + remove all non-alphanumerics. Used for fuzzy comparison.
 *   "your_tony_bot" → "aitonystarkbot"
 *   "aiTonyStark_bot"   → "aitonystarkbot"  (matches!)
 *   "ai-tony"           → "aitony"          (matches BotName 'ai-tony')
 */
function normalizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build the lookup table once: normalized-form → canonical Telegram
 * username for the bot that owns it. Aliases map to the same canonical
 * username as their bot.
 *
 * If two bots share an alias (shouldn't happen — closed-set discipline)
 * the FIRST registered bot wins. The closed-set test asserts no overlap.
 */
function buildLookupTable(): Map<string, string> {
  const table = new Map<string, string>();
  for (const bn of BOT_NAMES) {
    const canonical = BOT_TELEGRAM_USERNAMES[bn];
    if (!canonical || canonical.length === 0) continue;

    const candidates = new Set<string>([canonical, bn, ...BOT_ALIASES_BY_NAME[bn]]);
    for (const c of candidates) {
      const norm = normalizeId(c);
      if (norm.length === 0) continue;
      if (!table.has(norm)) table.set(norm, canonical);
    }
  }
  return table;
}

const _lookupTable = buildLookupTable();

/**
 * Replace fuzzy @-mention variants with the canonical Telegram username.
 *
 * @param text  reply text from the agent (group mode)
 * @returns     same text with peer-bot @-mentions rewritten
 */
export function normalizePeerBotMentions(text: string): string {
  if (text.length === 0) return text;
  // Match @ followed by word chars OR hyphens — handles both Telegram-
  // canonical (\w only) and BotName-style "@ai-tony" style with hyphens.
  return text.replace(/@([\w-]+)/g, (full, raw: string) => {
    const norm = normalizeId(raw);
    const canonical = _lookupTable.get(norm);
    if (canonical === undefined) return full; // not a known bot
    if (raw === canonical) return full; // already canonical
    return `@${canonical}`;
  });
}

/**
 * Test-only: return the lookup table for assertions.
 */
export function _peerMentionLookupTable(): Map<string, string> {
  return _lookupTable;
}

export type { BotName };
