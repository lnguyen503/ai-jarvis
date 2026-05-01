/**
 * Mention router — bot identity-aware activation filter (v1.21.0 Pillar 2 D7).
 *
 * In a shared Telegram group where multiple bots coexist (ai-jarvis, ai-tony),
 * each bot independently decides whether to process an incoming message.
 *
 * Decision tree:
 *   1. DM (chat type 'private') AND recipient is this bot → process (reason: 'dm')
 *   2. Group AND `@<selfBotUsername>` appears in message text or entities → process (reason: 'mention')
 *   3. Group AND `message.reply_to_message.from.id === selfBotId` → process (reason: 'reply_to_self')
 *   4. Otherwise → drop (reason: 'ignored' — another bot was addressed or no mention)
 *
 * Implementation notes:
 *   - Telegram entities (`message_entity` type `mention`) are checked FIRST over
 *     raw regex (per Anti-Slop §1: use platform APIs before regex where available).
 *   - Fallback to case-insensitive text search handles edge cases (e.g., forwarded
 *     messages, captions, clients that don't emit entity data).
 *   - Username matching is case-insensitive (Telegram is case-insensitive for @mentions).
 *
 * Tests: tests/unit/gateway.mentionRouter.test.ts (~20 cases)
 *
 * ADR: ADR 021 D7 (Pillar 2 mention routing).
 * Boundary: does NOT handle self-message echo drop (commit 9 does that) or loop
 * protection (commit 11). Those run before/after this in the activation gate.
 */

import type { BotIdentity } from '../config/botIdentity.js';
import { BOT_ALIASES_BY_NAME, COLLECTIVE_ALIASES } from '../config/botIdentity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Normalized Telegram message shape for mention routing (subset of grammY Message). */
export interface MentionRoutableMessage {
  chat?: { type?: string };
  from?: { id?: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  reply_to_message?: {
    from?: { id?: number };
  };
  entities?: Array<{ type: string; offset: number; length: number }>;
  caption_entities?: Array<{ type: string; offset: number; length: number }>;
}

export type MentionRoutingReason =
  | 'mention'
  | 'reply_to_self'
  | 'dm'
  | 'alias'
  | 'collective'
  | 'ignored';

export interface MentionRoutingResult {
  /** Whether this bot should process the message. */
  process: boolean;
  reason: MentionRoutingReason;
}

// ---------------------------------------------------------------------------
// parseMentions — extract @<username> strings from message text
// ---------------------------------------------------------------------------

/**
 * Extract all @mention strings from a message text.
 * Returns an array of lowercase usernames WITHOUT the '@' prefix.
 * e.g., "Hey @ai-jarvis can you help?" → ['ai-jarvis']
 *
 * Uses a simple case-insensitive regex over the raw text.
 * Called as a fallback when Telegram entity data is unavailable.
 */
export function parseMentions(messageText: string): string[] {
  const matches = messageText.matchAll(/@([A-Za-z0-9_-]+)/g);
  return Array.from(matches).map((m) => (m[1] ?? '').toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// isMentionedViaEntities — check Telegram entities for this bot's username
// ---------------------------------------------------------------------------

/**
 * Returns true if any Telegram entity of type 'mention' references the given
 * bot username in the message text.
 *
 * Telegram clients emit `message_entity` records with `type: 'mention'` and
 * the byte offset + length in the text for each @username. This is more reliable
 * than regex (handles multi-byte characters, edge-case inputs, etc.).
 */
function isMentionedViaEntities(
  text: string,
  entities: Array<{ type: string; offset: number; length: number }>,
  selfUsername: string,
): boolean {
  const lowerSelf = selfUsername.toLowerCase();
  for (const entity of entities) {
    if (entity.type !== 'mention') continue;
    // Extract the mention text from the message (includes '@')
    const mentionText = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    // mentionText is '@username'; compare after stripping '@'
    if (mentionText === `@${lowerSelf}`) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// isAliasMatched — check whether any of this bot's aliases appears in text
// ---------------------------------------------------------------------------

/**
 * Returns true if any alias appears in `text` as a whole word
 * (case-insensitive). Word boundary uses \b on both sides; multi-word aliases
 * (e.g. "mr. stark") are matched literally with internal whitespace flexible
 * via `\s+`. Punctuation in aliases (e.g. the dot in "mr.") is treated as
 * optional via `\.?`.
 *
 * Examples:
 *   alias "tony"       matches "Tony, ping" but not "stony" or "tonysoprano"
 *   alias "mr. stark"  matches "Mr. Stark", "mr stark", "Mr.  Stark"
 *   alias "stark"      matches "ask stark for help" but not "starks"
 *
 * Each alias is escaped from regex metacharacters EXCEPT the dot, which is
 * normalized to optional + flexible whitespace.
 */
export function isAliasMatched(text: string, aliases: readonly string[]): boolean {
  if (text.length === 0 || aliases.length === 0) return false;
  for (const alias of aliases) {
    const lowered = alias.toLowerCase().trim();
    if (lowered.length === 0) continue;
    // Build a regex with \b boundaries. Replace dots with optional dot,
    // and runs of whitespace with \s+. Other regex metas escaped.
    const pattern = lowered
      .replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '.' ? '\\.?' : `\\${m}`))
      .replace(/\s+/g, '\\s+');
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// shouldThisBotProcess — main routing decision
// ---------------------------------------------------------------------------

/**
 * Determine whether this bot (identified by `identity`) should process the
 * given Telegram message.
 *
 * v1.22.0 simplification: aliases (e.g. "tony", "jarvis") only fire for
 * full-scope orchestrator bots. Specialists require an explicit @-mention
 * or reply-to-self. This makes the orchestrator (Jarvis) the unambiguous
 * entry point for human prompts; specialists only act when explicitly
 * tagged — by Jarvis or by Boss. Eliminates the need for earliest-bot
 * turn-taking heuristics.
 *
 * @param message          Telegram message (subset used by routing logic only).
 * @param identity         This bot's resolved identity.
 * @param selfBotId        This bot's Telegram user id (from `getMe` at boot).
 * @param selfBotUsername  This bot's Telegram username WITHOUT '@'.
 */
export function shouldThisBotProcess(
  message: MentionRoutableMessage,
  identity: BotIdentity,
  selfBotId: number,
  selfBotUsername: string,
): MentionRoutingResult {
  const chatType = message.chat?.type;
  const text = message.text ?? message.caption ?? '';

  // --- Rule 1: DM -------------------------------------------------------
  // In private chats, process unconditionally (the message is TO this bot directly).
  if (chatType === 'private') {
    return { process: true, reason: 'dm' };
  }

  // --- Rules 2 & 3 apply only to group / supergroup chats ---------------
  if (chatType !== 'group' && chatType !== 'supergroup') {
    // Channel, channel post, unknown — ignore.
    return { process: false, reason: 'ignored' };
  }

  // --- Rule 3: Reply to this bot's own message --------------------------
  const replyFromId = message.reply_to_message?.from?.id;
  if (replyFromId !== undefined && replyFromId === selfBotId) {
    return { process: true, reason: 'reply_to_self' };
  }

  // --- Rule 2: @mention in message (entities FIRST, regex fallback) -----
  const entities = [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];

  let selfMentioned = false;
  if (entities.length > 0 && text.length > 0) {
    // Preferred path: use Telegram entity data (per Anti-Slop §1)
    selfMentioned = isMentionedViaEntities(text, entities, selfBotUsername);
  }

  if (!selfMentioned && text.length > 0) {
    // Fallback: case-insensitive text scan for @<selfUsername>
    const mentioned = parseMentions(text);
    selfMentioned = mentioned.includes(selfBotUsername.toLowerCase());
  }

  if (selfMentioned) {
    return { process: true, reason: 'mention' };
  }

  // v1.22.18 — collective alias check fires EVERY bot regardless of scope.
  // Boss says "Avengers, …" or "team, …" or "everyone, …" → all four bots
  // see the message and decide whether to chime in based on their persona
  // (scope-relevance check). Bypasses the v1.22.17 orchestrator-priority
  // deferral rule because collective addressing is the explicit invitation
  // for parallel responses.
  if (text.length > 0 && isAliasMatched(text, COLLECTIVE_ALIASES)) {
    return { process: true, reason: 'collective' };
  }

  // v1.22.17 — alias activation rules:
  //
  //   Full-scope (orchestrator):
  //     Fires whenever its alias is in the message. "jarvis, …" → Jarvis.
  //
  //   Specialist:
  //     Fires when its alias is in the message AND the orchestrator's alias
  //     is NOT also in the message. So "bruce, calculate X" fires Bruce
  //     directly, but "jarvis, ask bruce to calculate X" routes through
  //     Jarvis (orchestrator priority — he'll then delegate via the
  //     `delegate_to_specialist` tool, which posts the @-mention that wakes
  //     the specialist). This makes natural-language addressing work for
  //     all four bots without re-introducing earliest-bot turn-taking
  //     edge cases on co-orchestrator-and-specialist messages.
  if (text.length > 0 && isAliasMatched(text, identity.aliases)) {
    if (identity.scope === 'full') {
      return { process: true, reason: 'alias' };
    }
    // Specialist scope — defer to orchestrator if both aliases present.
    const orchestratorAliases = BOT_ALIASES_BY_NAME['ai-jarvis'];
    if (!isAliasMatched(text, orchestratorAliases)) {
      return { process: true, reason: 'alias' };
    }
  }

  return { process: false, reason: 'ignored' };
}
