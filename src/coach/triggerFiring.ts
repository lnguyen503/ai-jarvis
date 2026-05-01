/**
 * Shared trigger dispatch for event-driven proactive coach (v1.20.0 ADR 020 D7).
 *
 * Exports:
 *   TriggerRecord   — shape of one detected event trigger
 *   TriggerReason   — closed-set enum (W1 fix: replaces free-form string)
 *   TRIGGER_REASONS — const array of all reasons (for static tests)
 *   buildTriggerReason() — maps triggerType → TriggerReason (W1 mapping)
 *   dispatchTrigger()    — runs rate-limit + quiet checks, fires or suppresses
 *
 * Dependency edges (binding per ADR 020 D16 + FORBIDDEN edges):
 *   triggerFiring.ts → memory/auditLog (audit emission)
 *   triggerFiring.ts → coach/rateLimits (all rate-limit primitives)
 *   triggerFiring.ts → logger
 *   FORBIDDEN: NO import from gateway/**, agent/**, or coach/index.ts
 *   (the gateway calls IN to fireSpontaneousCoachTurn; this module never reaches back)
 *
 * ADR 020 Decision 7 + CP1 revisions R1/W1/R5.
 */

import { child } from '../logger/index.js';
import type { AuditLogRepo } from '../memory/auditLog.js';
import {
  checkPerItemRateLimit,
  recordPerItemFire,
  checkGlobalDailyCap,
  recordGlobalDailyFire,
  checkQuietMode,
  checkUserMessageDebounce,
  checkCoachDMCooldown,
} from './rateLimits.js';

const log = child({ component: 'coach.triggerFiring' });

// ---------------------------------------------------------------------------
// TriggerReason closed set (W1 — Anti-Slop §14 fix: replaces free-form string)
// ---------------------------------------------------------------------------

/**
 * Closed-set enum of trigger reason slugs.
 *
 * W1 fix (ADR 020 CP1 revisions): reason is NOT a free-form string.
 * These slugs are the only values injected into the coach prompt via ${trigger_context}.
 * No user-supplied or item-derived content reaches the LLM via this field.
 *
 * ADR 020 D6 trigger types map to these slugs via buildTriggerReason().
 */
export type TriggerReason =
  // itemState triggers (D6.a)
  | 'due_24h'
  | 'goal_stale_14d'
  | 'persistent_zero_engagement_7d'
  | 'vague_new_goal'
  // chat triggers (D6.b)
  | 'commitment_language'
  | 'blocker_language'
  | 'procrastination_language'
  | 'completion_language'
  // calendar triggers (D6.c)
  | 'recurring_meeting'
  | 'standalone_meaningful_event';

/** Closed-set array (for static tests asserting length === 10). */
export const TRIGGER_REASONS: readonly TriggerReason[] = [
  'due_24h',
  'goal_stale_14d',
  'persistent_zero_engagement_7d',
  'vague_new_goal',
  'commitment_language',
  'blocker_language',
  'procrastination_language',
  'completion_language',
  'recurring_meeting',
  'standalone_meaningful_event',
] as const;

// ---------------------------------------------------------------------------
// TriggerRecord shape (binding per ADR 020 D6)
// ---------------------------------------------------------------------------

/**
 * ADR 020 D6 trigger types (hyphenated, used in audit detail + today-focus-card).
 * Map to TriggerReason slugs via buildTriggerReason().
 */
export type TriggerType =
  | 'due-in-24h-no-progress'
  | 'goal-stale-14d'
  | 'persistent-zero-engagement-7d'
  | 'new-vague-goal'
  | 'commitment'
  | 'blocker'
  | 'procrastination'
  | 'done-signal-confirmation'
  | 'recurring-meeting-detected'
  | 'standalone-meaningful-event';

/**
 * A detected event trigger, produced by itemStateMonitor / chatMonitor / calendarMonitor.
 * Pure data; no side effects at detect time.
 *
 * triggerContext is structural metadata only (never user message body per W1 / v1.17.0 H gate).
 * It is injected into the coach prompt in Step 0.5 — populated by fireSpontaneousCoachTurn.
 */
export interface TriggerRecord {
  userId: number;
  itemId: string;
  kind: 'item-state' | 'chat' | 'calendar';
  triggerType: TriggerType;
  reason: TriggerReason;
  /** Optional structural metadata for the coach prompt (NOT user content). */
  triggerContext?: string;
  /** chat trigger only — sha256(message)[0:16]; NEVER the message itself. */
  fromMessageHash?: string;
  detectedAt: string;
}

/**
 * Build the TriggerReason slug from a triggerType.
 * Single-source-of-truth mapping (W1 binding).
 */
export function buildTriggerReason(triggerType: TriggerType): TriggerReason {
  const m: Record<TriggerType, TriggerReason> = {
    'due-in-24h-no-progress': 'due_24h',
    'goal-stale-14d': 'goal_stale_14d',
    'persistent-zero-engagement-7d': 'persistent_zero_engagement_7d',
    'new-vague-goal': 'vague_new_goal',
    'commitment': 'commitment_language',
    'blocker': 'blocker_language',
    'procrastination': 'procrastination_language',
    'done-signal-confirmation': 'completion_language',
    'recurring-meeting-detected': 'recurring_meeting',
    'standalone-meaningful-event': 'standalone_meaningful_event',
  };
  return m[triggerType];
}

// ---------------------------------------------------------------------------
// Suppression reason type
// ---------------------------------------------------------------------------

export type SuppressionReason =
  | 'PER_ITEM_BACKOFF'
  | 'GLOBAL_DAILY_CAP'
  | 'QUIET_ACTIVE'
  | 'USER_MESSAGE_DEBOUNCE'
  | 'COACH_DM_COOLDOWN';

// ---------------------------------------------------------------------------
// Dispatch dependencies (injected; no direct gateway import)
// ---------------------------------------------------------------------------

/**
 * Dependencies for dispatchTrigger.
 *
 * The gateway calls IN — triggerFiring.ts never imports from gateway.
 * The fireSpontaneousCoachTurn function is passed as a dep.
 */
export interface TriggerFireDeps {
  /** Data directory for keyed memory reads/writes. */
  dataDir: string;
  /** AuditLogRepo for audit emission. */
  auditLog: AuditLogRepo;
  /**
   * Fire function supplied by gateway.fireSpontaneousCoachTurn.
   * Called AFTER all rate-limit checks pass.
   */
  fireSpontaneousCoachTurn: (trigger: TriggerRecord) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Dispatch options (R5 delay support)
// ---------------------------------------------------------------------------

export interface DispatchOpts {
  /**
   * Minimum delay (ms) before firing the trigger.
   * Used by calendarMonitor for the 5-min gentleness delay (R5).
   * Default: 0 (no delay).
   */
  delayMs?: number;
}

// ---------------------------------------------------------------------------
// Today's ISO date helper
// ---------------------------------------------------------------------------

function todayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// dispatchTrigger — main entry point for all three monitor modules
// ---------------------------------------------------------------------------

/**
 * Run all rate-limit + quiet-mode checks, then fire or suppress the trigger.
 *
 * Rate-limit checks (all mandatory before any fire per ADR 020 D7 + RA1 invariant 4):
 *   1. checkPerItemRateLimit (4h per item)
 *   2. checkGlobalDailyCap (3/day global)
 *   3. checkQuietMode (kill switch)
 *   4. checkUserMessageDebounce (60s debounce D12)
 *   5. checkCoachDMCooldown (30-min feedback-loop guard D10)
 *
 * On suppress: emit `coach.event_trigger.suppressed` audit (NEVER silent suppress).
 * On fire: emit `coach.event_trigger.fired` audit + call fireSpontaneousCoachTurn.
 *
 * If opts.delayMs > 0: waits before firing; re-checks rate limits after delay
 * (handles quiet mode invoked during the wait window — R5).
 */
export async function dispatchTrigger(
  deps: TriggerFireDeps,
  trigger: TriggerRecord,
  opts: DispatchOpts = {},
): Promise<{ fired: true } | { fired: false; reason: SuppressionReason }> {
  const { userId, itemId } = trigger;
  const { dataDir, auditLog } = deps;

  // --- Initial rate-limit checks ---
  const suppressResult = await runRateLimitChecks(userId, dataDir, itemId);
  if (suppressResult !== null) {
    emitSuppressed(auditLog, trigger, suppressResult);
    return { fired: false, reason: suppressResult };
  }

  // --- Optional delay (R5: calendar triggers wait 5 min) ---
  if (opts.delayMs && opts.delayMs > 0) {
    log.debug({ userId, itemId, delayMs: opts.delayMs }, 'triggerFiring: waiting before fire');
    await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs));

    // Re-check after delay: user may have invoked /coach quiet during the wait
    const postDelaySuppressResult = await runRateLimitChecks(userId, dataDir, itemId);
    if (postDelaySuppressResult !== null) {
      emitSuppressed(auditLog, trigger, postDelaySuppressResult);
      return { fired: false, reason: postDelaySuppressResult };
    }
  }

  // --- Fire ---
  log.info({ userId, itemId, kind: trigger.kind, reason: trigger.reason }, 'triggerFiring: firing spontaneous coach turn');

  try {
    await deps.fireSpontaneousCoachTurn(trigger);

    // Record counters on success
    await recordPerItemFire(userId, dataDir, itemId);
    await recordGlobalDailyFire(userId, dataDir, todayYYYYMMDD());

    // Emit fired audit
    auditLog.insert({
      category: 'coach.event_trigger.fired',
      actor_user_id: userId,
      detail: {
        kind: trigger.kind,
        triggerType: trigger.triggerType,
        reason: trigger.reason,
        itemId,
        fromMessageHash: trigger.fromMessageHash ?? null,
      },
    });

    return { fired: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error({ userId, itemId, err: errorMsg }, 'triggerFiring: fireSpontaneousCoachTurn threw');
    emitSuppressed(auditLog, trigger, 'PER_ITEM_BACKOFF'); // treat fire failure as backoff
    return { fired: false, reason: 'PER_ITEM_BACKOFF' };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runRateLimitChecks(
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<SuppressionReason | null> {
  // 1. Per-item 4h window
  const perItem = await checkPerItemRateLimit(userId, dataDir, itemId);
  if (!perItem.allowed) return 'PER_ITEM_BACKOFF';

  // 2. Global daily cap
  const daily = await checkGlobalDailyCap(userId, dataDir, todayYYYYMMDD());
  if (!daily.allowed) return 'GLOBAL_DAILY_CAP';

  // 3. Quiet mode kill switch
  const quiet = await checkQuietMode(userId, dataDir);
  if (quiet.active) return 'QUIET_ACTIVE';

  // 4. User message debounce (60s)
  const debounce = await checkUserMessageDebounce(userId, dataDir);
  if (!debounce.allowed) return 'USER_MESSAGE_DEBOUNCE';

  // 5. Coach DM cooldown (30-min)
  const dmCooldown = await checkCoachDMCooldown(userId, dataDir);
  if (!dmCooldown.allowed) return 'COACH_DM_COOLDOWN';

  return null;
}

function emitSuppressed(
  auditLog: AuditLogRepo,
  trigger: TriggerRecord,
  suppressionReason: SuppressionReason,
): void {
  auditLog.insert({
    category: 'coach.event_trigger.suppressed',
    actor_user_id: trigger.userId,
    detail: {
      kind: trigger.kind,
      triggerType: trigger.triggerType,
      reason: trigger.reason,
      itemId: trigger.itemId,
      suppressionReason,
    },
  });
  log.debug(
    { userId: trigger.userId, itemId: trigger.itemId, suppressionReason },
    'triggerFiring: trigger suppressed',
  );
}
