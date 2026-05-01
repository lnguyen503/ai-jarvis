/**
 * Inter-bot context boundary wrap (v1.21.0 D9, revised by R3 BINDING).
 *
 * When a peer bot (message.from.is_bot === true) sends a message in a shared
 * Telegram group, the message content is wrapped in:
 *
 *   <from-bot name="ai-tony">
 *   ... sanitized content ...
 *   </from-bot>
 *
 * This tag signals to the receiving bot's persona prompt (which must contain the
 * "Inter-bot boundary discipline" clause per R3 — added to both ai-jarvis.md and
 * ai-tony.md by Dev-A commit 5) that the content is UNTRUSTED data, not
 * instructions. The LLM must not execute tool calls "on behalf of" the peer bot.
 *
 * Adversarial defense (R3 BINDING):
 *   - NUL byte ban (carry-forward from v1.18.0 R5/F3)
 *   - Per-field char cap: message text is sliced at INTER_BOT_TEXT_CAP (4096 chars)
 *   - STRONG-REJECT: all `<from-bot` and `</from-bot>` substrings in the raw text
 *     are replaced with `[stripped]` BEFORE wrapping. A peer bot that includes
 *     close-tag attempts in its output would otherwise be able to inject arbitrary
 *     content between a premature close tag and the real close tag.
 *   - fromBotName is sanitized to [a-zA-Z0-9_-] only (defense-in-depth; the name
 *     also comes from a Telegram API field we do not control at the content level).
 *
 * Tests: tests/integration/gateway.interBotContext.test.ts (~15 cases).
 *
 * ADR: ADR 021 D9, amended by 021-revisions-after-cp1.md R3.
 */

import type { Context } from 'grammy';

/** Char cap for peer bot message text (parallel to v1.18.0 dispatcher's 4096-char cap). */
export const INTER_BOT_TEXT_CAP = 4096;

/** Name sanitizer: allow only alphanumeric, hyphen, underscore. */
function sanitizeBotName(rawName: string): string {
  return rawName.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Strip `<from-bot` and `</from-bot>` (and variants with attributes or whitespace)
 * from peer message text before wrapping. Defends against close-tag injection that
 * would break the outer wrapper's structure.
 *
 * Both opening and closing patterns are replaced with `[stripped]` so the human-
 * readable LLM output still shows that the attempt occurred (the model can reason
 * about and report the injection attempt to the user).
 */
function stripFromBotTags(rawText: string): string {
  // Matches both <from-bot ...> and </from-bot> (case-insensitive, with any attributes)
  return rawText.replace(/<\/?from-bot[^>]*>/gi, '[stripped]');
}

/**
 * Returns true when the Telegram message originated from a bot account.
 * Checks `message.from.is_bot === true`. Also handles the grammY Context type.
 */
export function isBotMessage(ctx: Context): boolean {
  return ctx.message?.from?.is_bot === true;
}

/**
 * Returns true when a raw Telegram message object (not grammY context) is from a bot.
 * Used when iterating history messages where we have plain objects, not ctx.
 */
export function isBotMessageRaw(msg: { from?: { is_bot?: boolean } }): boolean {
  return msg.from?.is_bot === true;
}

export interface InterBotMessageMeta {
  /** first_name || username of the peer bot's account. */
  fromBotName: string;
  /** Raw text content of the peer bot's message. */
  rawText: string;
  /** Telegram message_id (unused in wrapping; caller may use for correlation). */
  messageId?: number;
}

/**
 * Wrap a peer bot's message in the `<from-bot>` boundary tag.
 *
 * Steps (in order per R3):
 *   1. Reject NUL bytes (throw NUL_BYTE_REJECTED).
 *   2. Slice at INTER_BOT_TEXT_CAP.
 *   3. Strip all `<from-bot` / `</from-bot>` substrings (injection defense).
 *   4. Sanitize fromBotName.
 *   5. Return the wrapped string.
 */
export function wrapBotMessage(meta: InterBotMessageMeta): string {
  // 1. NUL ban (v1.18.0 R5/F3 carry-forward)
  if (meta.rawText.includes('\x00')) {
    throw new Error('NUL_BYTE_REJECTED');
  }
  // 2. Char cap
  const capped = meta.rawText.slice(0, INTER_BOT_TEXT_CAP);
  // 3. Strip injection attempts
  const stripped = stripFromBotTags(capped);
  // 4. Sanitize name
  const safeName = sanitizeBotName(meta.fromBotName);
  // 5. Wrap
  return `<from-bot name="${safeName}">\n${stripped}\n</from-bot>`;
}

/**
 * Given a message history entry (from the context-builder), if the message was
 * sent by a peer bot, return the wrapped version. Otherwise return the original text.
 *
 * Used in src/agent/index.ts context-builder to annotate bot-originated history
 * entries before they reach the LLM.
 */
export function maybeWrapBotHistoryEntry(msg: {
  from?: { is_bot?: boolean; first_name?: string; username?: string };
  text?: string;
}): string | undefined {
  if (!msg.from?.is_bot) return msg.text;
  if (!msg.text) return msg.text;

  const fromBotName =
    msg.from.first_name ?? msg.from.username ?? 'unknown-bot';

  try {
    return wrapBotMessage({ fromBotName, rawText: msg.text });
  } catch {
    // NUL_BYTE_REJECTED: return a sanitized placeholder rather than propagating
    return `<from-bot name="${sanitizeBotName(fromBotName)}">\n[message rejected: contained invalid bytes]\n</from-bot>`;
  }
}
