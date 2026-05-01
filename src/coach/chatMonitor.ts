/**
 * Chat-message event trigger monitor (v1.20.0 ADR 020 D6.b).
 *
 * Hooked into agent.turn() post-turn callback via callback registry pattern
 * (same as v1.19.0 calendar-sync pattern). Registered at boot from
 * src/index.ts via registerChatMessageCallback().
 *
 * Exports:
 *   detectChatTrigger(message, items, now) — pure detect; returns TriggerRecord | null
 *   notifyChatMessage(deps, userId, message) — callback body; calls detect → dispatch
 *   registerChatMessageCallback(cb)         — boot-time registration
 *   fireChatMessageMonitor(userId, message) — called from agent.turn() post-turn
 *
 * Trigger conditions (mutually exclusive — first match wins per message):
 *   commitment              — "I'll / I will / going to / gonna / let me" near fuzzy item match
 *   blocker                 — "blocked on / stuck on / can't make progress on" near fuzzy match
 *   procrastination         — "I keep putting off / haven't gotten to / been avoiding" near fuzzy match
 *   done-signal-confirmation — "done with / finished / wrapped up / completed" near fuzzy match
 *
 * Fuzzy matching: jaccardScore >= FUZZY_MATCH_THRESHOLD (0.7) between message
 * tokens and item title tokens. Same algorithm as userOverrideParser.ts via
 * shared textPatternMatcher.ts (Anti-Slop §6 SSOT).
 *
 * DM cooldown: suppresses trigger if now - coach.global.lastCoachDmAt < 30min
 * to prevent feedback loops (D10).
 *
 * Dependency edges (binding per ADR 020 D16):
 *   chatMonitor.ts → coach/triggerFiring (TriggerRecord, dispatchTrigger)
 *   chatMonitor.ts → coach/textPatternMatcher (tokenize, jaccardScore, FUZZY_MATCH_THRESHOLD)
 *   chatMonitor.ts → coach/rateLimits (checkCoachDMCooldown)
 *   chatMonitor.ts → organize/types (OrganizeItem — read-only)
 *   chatMonitor.ts → logger
 *   FORBIDDEN: NO import from gateway/**, agent/**, memory/scheduledTasks.
 *
 * ADR 020 Decision 6.b + D10 + boot-wiring per D17.
 */

import crypto from 'node:crypto';
import { child } from '../logger/index.js';
import {
  tokenize,
  jaccardScore,
  FUZZY_MATCH_THRESHOLD,
  negationDetected,
} from './textPatternMatcher.js';
import {
  buildTriggerReason,
  dispatchTrigger,
  type TriggerRecord,
  type TriggerFireDeps,
} from './triggerFiring.js';
import { checkCoachDMCooldown } from './rateLimits.js';
import type { OrganizeItem } from '../organize/types.js';

const log = child({ component: 'coach.chatMonitor' });

// ---------------------------------------------------------------------------
// Pattern families (ADR 020 D6.b — binding regex set)
// ---------------------------------------------------------------------------

/** Commitment intent pattern (ADR 020 D6.b). */
const COMMITMENT_RE = /\b(?:i'?ll|i\s+will|going\s+to|gonna|let\s+me)\s+\w/i;

/** Blocker intent pattern. */
const BLOCKER_RE = /\b(?:blocked\s+on|stuck\s+on|can'?t\s+make\s+progress\s+(?:on|with))\b/i;

/** Procrastination intent pattern. */
const PROCRASTINATION_RE = /\b(?:i\s+keep\s+(?:putting\s+off|delaying)|haven'?t\s+gotten\s+to|been\s+avoiding)\b/i;

/** Completion-claim intent pattern (done-signal-confirmation). */
const COMPLETION_RE = /\b(?:done\s+with|finished|wrapped\s+up|completed)\b/i;

/**
 * Token window scanned BEFORE a matched intent verb for negation markers.
 * Same value as v1.19.0 NEGATION_TOKEN_WINDOW (userOverrideParser.ts) — 8 tokens
 * is the binding ADR 019 R3 / ADR 020 D10 SSOT value. Re-stating the literal
 * here (rather than importing from userOverrideParser) avoids cross-coupling
 * a chat-monitor module to an override-parser module; both consume the shared
 * negationDetected primitive from textPatternMatcher with the same constant.
 */
const NEGATION_TOKEN_WINDOW = 8;

// ---------------------------------------------------------------------------
// Negation guard helper
// ---------------------------------------------------------------------------

/**
 * Test whether `pattern` matches `message` AND is NOT negated within the
 * 8-token window before the matched verb.
 *
 * Returns true only if the user actually expressed the intent (commitment /
 * blocker / procrastination / completion). Returns false on either:
 *   - no regex match
 *   - regex match but negation marker within NEGATION_TOKEN_WINDOW tokens
 *     before the matched start (e.g. "I'm NOT going to start retirement").
 *
 * Per Item 2 spec (P2 fix loop): negation must be a HARD guard, not an
 * incidental side-effect of fuzzy threshold filtering. Without this check,
 * a long-titled item could push "I'm not going to start retirement" above
 * the 0.7 jaccard threshold and incorrectly fire a commitment trigger.
 *
 * Edge case (documented, not fixed in this revision): "I should but I don't
 * keep avoiding retirement" is structurally a double-negative where the
 * procrastination admission semantically STANDS, but our 8-token window
 * detects the "don't" before "keep" and suppresses. Acceptable because
 * a false-suppress is strictly better than a false-fire (the user can
 * still surface the problem on the next non-negated message).
 */
function matchesWithoutNegation(message: string, pattern: RegExp): boolean {
  const match = pattern.exec(message);
  if (!match) return false;

  // Token-stream view of the message (whitespace-split, no stop-word filter so
  // negation tokens like "not" are preserved — STOP_WORDS would erase them).
  const sentenceTokens = message.toLowerCase().split(/\s+/);

  // Compute the token index of the match-start in that stream.
  // Same approach as userOverrideParser.ts (ADR 019 D3 + R3).
  const matchStart = match.index;
  const textBefore = message.slice(0, matchStart);
  const tokensBefore = textBefore.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const matchTokenIdx = tokensBefore.length;

  // Compute how many tokens the match span covers — chat patterns often include
  // an auxiliary verb + main verb (e.g. "i will not start" -> matched span is
  // "i will n", but the actual "will + start" verb phrase wraps the negation).
  // Counting tokens in the match span lets us scan for an in-span negation too.
  const matchTokenCount = Math.max(1, match[0].toLowerCase().split(/\s+/).filter((t) => t.length > 0).length);

  // (1) Standard pre-verb scan: 8 tokens before the match start.
  if (negationDetected(sentenceTokens, matchTokenIdx, NEGATION_TOKEN_WINDOW)) return false;

  // (2) In-span scan + immediately-after scan: covers "I will NOT start ...",
  // "going to NOT do ...", "let me NOT do ...". Pin the anchor at the END of
  // the match span and scan back through the span so a negation token sitting
  // INSIDE the verb phrase still suppresses. Bound the anchor by
  // matchTokenCount + 2 to keep the scan local to the verb phrase rather than
  // re-checking arbitrary earlier text.
  const inSpanAnchor = matchTokenIdx + matchTokenCount + 1;
  if (negationDetected(sentenceTokens, inSpanAnchor, matchTokenCount + 2)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Pure detect function
// ---------------------------------------------------------------------------

/**
 * Detect whether a chat message matches any trigger-pattern family and
 * fuzzy-matches an active organize item title.
 *
 * Pure function — no side effects, no async.
 * Returns a TriggerRecord with userId=0 (placeholder; caller stamps real userId),
 * or null if no match.
 *
 * Detection order (first match wins):
 *   1. commitment
 *   2. blocker
 *   3. procrastination
 *   4. done-signal-confirmation
 *
 * @param message  User's raw message text.
 * @param items    Active organize items to fuzzy-match against.
 * @param now      Current timestamp (injectable for testing).
 */
export function detectChatTrigger(
  message: string,
  items: OrganizeItem[],
  now: Date = new Date(),
): TriggerRecord | null {
  if (!message.trim()) return null;

  // Find best fuzzy-matched item for the message
  const msgTokens = new Set(tokenize(message));
  if (msgTokens.size === 0) return null;

  let bestItem: OrganizeItem | null = null;
  let bestScore = 0;

  for (const item of items) {
    if (item.frontMatter.status !== 'active') continue;
    const titleTokens = new Set(tokenize(item.frontMatter.title));
    if (titleTokens.size === 0) continue;
    const score = jaccardScore(msgTokens, titleTokens);
    if (score >= FUZZY_MATCH_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  // No fuzzy match above threshold — no trigger
  if (!bestItem) return null;

  const itemId = bestItem.frontMatter.id;

  // sha256 of message for audit trail (NEVER store the message text)
  const fromMessageHash = crypto.createHash('sha256').update(message).digest('hex').slice(0, 16);

  // Test pattern families in priority order.
  // Each pattern is wrapped in matchesWithoutNegation() — if a negation marker
  // (not / don't / won't / can't / never) appears within 8 tokens before the
  // matched verb, the trigger is suppressed. See helper docstring for the
  // double-negative edge case that is intentionally NOT fixed in this revision.
  if (matchesWithoutNegation(message, COMMITMENT_RE)) {
    return {
      userId: 0,
      itemId,
      kind: 'chat',
      triggerType: 'commitment',
      reason: buildTriggerReason('commitment'),
      triggerContext: `kind=chat reason=commitment_language itemId=${itemId}`,
      fromMessageHash,
      detectedAt: now.toISOString(),
    };
  }

  if (matchesWithoutNegation(message, BLOCKER_RE)) {
    return {
      userId: 0,
      itemId,
      kind: 'chat',
      triggerType: 'blocker',
      reason: buildTriggerReason('blocker'),
      triggerContext: `kind=chat reason=blocker_language itemId=${itemId}`,
      fromMessageHash,
      detectedAt: now.toISOString(),
    };
  }

  if (matchesWithoutNegation(message, PROCRASTINATION_RE)) {
    return {
      userId: 0,
      itemId,
      kind: 'chat',
      triggerType: 'procrastination',
      reason: buildTriggerReason('procrastination'),
      triggerContext: `kind=chat reason=procrastination_language itemId=${itemId}`,
      fromMessageHash,
      detectedAt: now.toISOString(),
    };
  }

  if (matchesWithoutNegation(message, COMPLETION_RE)) {
    return {
      userId: 0,
      itemId,
      kind: 'chat',
      triggerType: 'done-signal-confirmation',
      reason: buildTriggerReason('done-signal-confirmation'),
      triggerContext: `kind=chat reason=completion_language itemId=${itemId}`,
      fromMessageHash,
      detectedAt: now.toISOString(),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Boot-time callback registry (same pattern as v1.19.0 calendar sync)
// ---------------------------------------------------------------------------

/**
 * Type for the chat message monitor callback.
 * Receives userId + the user's just-sent message text. Fire-and-forget.
 */
export type ChatMessageMonitorCallback = (userId: number, message: string) => void;

let _chatMessageMonitorCallback: ChatMessageMonitorCallback | null = null;

/**
 * Register the chat message monitor callback (called at boot from src/index.ts).
 * Fires after every agent.turn() via agent.ts post-turn hook.
 *
 * ADR 020 D17 boot-wiring lint asserts this is NOT registered with a stub.
 */
export function registerChatMessageCallback(cb: ChatMessageMonitorCallback): void {
  _chatMessageMonitorCallback = cb;
}

/**
 * Internal: fire the chat message monitor callback fire-and-forget.
 * Called from agent/index.ts post-turn (same as _fireCalendarSync pattern).
 */
export function fireChatMessageMonitor(userId: number, message: string): void {
  if (_chatMessageMonitorCallback) {
    Promise.resolve()
      .then(() => _chatMessageMonitorCallback!(userId, message))
      .catch((err: unknown) => {
        log.warn(
          {
            userId,
            err: err instanceof Error ? err.message : String(err),
          },
          'chat message monitor callback rejected',
        );
      });
  }
}

// ---------------------------------------------------------------------------
// notifyChatMessage — callback body (registered at boot)
// ---------------------------------------------------------------------------

/**
 * Dependencies for notifyChatMessage.
 * TriggerFireDeps + item reader + DM cooldown deps are satisfied by TriggerFireDeps.
 */
export interface ChatMonitorDeps extends TriggerFireDeps {
  /**
   * Read all active organize items for a user.
   * Used for fuzzy title matching.
   */
  listActiveItems: (userId: number) => Promise<OrganizeItem[]>;
}

/**
 * Main callback body — invoked via fire-and-forget after every agent.turn().
 *
 * 1. Reads all active organize items (for fuzzy match).
 * 2. Checks DM cooldown (D10) — suppresses if coach DM was within 30 min.
 * 3. Calls detectChatTrigger (pure detect).
 * 4. If trigger detected, calls dispatchTrigger (rate-limits + fire).
 *
 * Failures are logged and silently swallowed — must not block agent turns.
 * ADR 020 D17 boot-wiring lint asserts the registered callback calls this function.
 */
export async function notifyChatMessage(
  deps: ChatMonitorDeps,
  userId: number,
  message: string,
): Promise<void> {
  try {
    // D10: suppress if coach DM was within 30 min (feedback-loop prevention)
    const dmCooldownResult = await checkCoachDMCooldown(userId, deps.dataDir);
    if (!dmCooldownResult.allowed) {
      log.debug(
        { userId, suppressedBy: 'dm_cooldown' },
        'chatMonitor: suppressed by DM cooldown',
      );
      return;
    }

    const items = await deps.listActiveItems(userId);
    const trigger = detectChatTrigger(message, items);

    if (!trigger) {
      log.debug({ userId }, 'chatMonitor: no trigger detected');
      return;
    }

    // Stamp userId (was 0 placeholder in pure detect)
    const stampedTrigger: TriggerRecord = { ...trigger, userId };

    log.info(
      { userId, itemId: trigger.itemId, triggerType: trigger.triggerType },
      'chatMonitor: trigger detected, dispatching',
    );

    await dispatchTrigger(deps, stampedTrigger);
  } catch (err) {
    log.error(
      {
        userId,
        err: err instanceof Error ? err.message : String(err),
      },
      'chatMonitor: notifyChatMessage threw — swallowed',
    );
  }
}
