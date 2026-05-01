/**
 * Item-state event trigger monitor (v1.20.0 ADR 020 D6.a).
 *
 * Hooked into storage.updateItem() and storage.createItem() via
 * callback registry pattern (same as v1.19.0 calendar-sync pattern).
 * Registered at boot from src/index.ts via registerItemStateMonitorCallback().
 *
 * Exports:
 *   detectItemStateTrigger(item, coachMemory, now) — pure detect; returns TriggerRecord | null
 *   notifyItemStateChange(deps, userId, item)     — callback body; calls detect → dispatch
 *   registerItemStateMonitorCallback(cb)          — boot-time registration
 *
 * Trigger conditions (mutually exclusive — first match wins per item):
 *   due_24h                       — dueDate within 24h, updated < 48h ago or absent
 *   goal_stale_14d                — goal type, not updated in 14d, not done
 *   persistent_zero_engagement_7d — coachIntensity='persistent', no recent engagement in 7d
 *   vague_new_goal                — goal type, created < 24h ago, title < 8 tokens, no notes
 *
 * Dependency edges (binding per ADR 020 D16):
 *   itemStateMonitor.ts → coach/triggerFiring (TriggerRecord, dispatchTrigger)
 *   itemStateMonitor.ts → organize/types (OrganizeItem — read-only)
 *   itemStateMonitor.ts → coach/rateLimits (indirect, via triggerFiring dispatch)
 *   itemStateMonitor.ts → logger
 *   FORBIDDEN: NO import from gateway/**, agent/**, memory/scheduledTasks.
 *
 * ADR 020 Decision 6.a + boot-wiring per D17.
 */

import { child } from '../logger/index.js';
import { tokenize } from './textPatternMatcher.js';
import {
  buildTriggerReason,
  dispatchTrigger,
  type TriggerRecord,
  type TriggerFireDeps,
} from './triggerFiring.js';
import type { OrganizeItem } from '../organize/types.js';

const log = child({ component: 'coach.itemStateMonitor' });

// ---------------------------------------------------------------------------
// Time constants
// ---------------------------------------------------------------------------

const MS_24H = 24 * 60 * 60 * 1000;
const MS_48H = 48 * 60 * 60 * 1000;
const MS_14D = 14 * 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;

/** Minimum token count for a "non-vague" goal title */
const VAGUE_GOAL_TITLE_MIN_TOKENS = 8;

// ---------------------------------------------------------------------------
// Coach memory type for engagement checks
// ---------------------------------------------------------------------------

/**
 * Minimal shape of coach memory relevant to engagement detection.
 * Used by detectItemStateTrigger to check fatigue/engagement state.
 */
export interface ItemCoachMemory {
  /**
   * ISO timestamp of the last nudge reply that was marked 'engaged'.
   * null or undefined = no engagement recorded.
   */
  lastEngagedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Pure detect function
// ---------------------------------------------------------------------------

/**
 * Detect whether an item's current state should trigger a spontaneous coach fire.
 *
 * Pure function — no side effects, no async.
 * Caller is responsible for dispatch (via dispatchTrigger).
 *
 * Returns a TriggerRecord if any condition matches, null otherwise.
 * Conditions are mutually exclusive — first match wins.
 *
 * @param item         The organize item to inspect.
 * @param coachMemory  Engagement memory for this item (used for persistent check).
 * @param now          Current timestamp (injectable for testing).
 */
export function detectItemStateTrigger(
  item: OrganizeItem,
  coachMemory: ItemCoachMemory,
  now: Date = new Date(),
): TriggerRecord | null {
  const { frontMatter: fm } = item;
  const nowMs = now.getTime();

  // Skip done/abandoned items — no coaching needed
  if (fm.status !== 'active') return null;

  const updatedMs = fm.updated ? new Date(fm.updated).getTime() : null;
  const createdMs = new Date(fm.created).getTime();

  // --- Condition 1: due-in-24h-no-progress ---
  // Due is set, due - now ∈ [0, 24h), progress not updated in 48h (or absent)
  // Note: fm.due may be YYYY-MM-DD (end-of-day semantics: use +1 day midnight)
  // or full ISO. We treat YYYY-MM-DD as end-of-day (23:59:59 UTC) for due-check.
  if (fm.due) {
    let dueMs: number;
    if (/^\d{4}-\d{2}-\d{2}$/.test(fm.due)) {
      // YYYY-MM-DD: treat as end of that day in UTC (midnight of next day)
      const [y, m, d] = fm.due.split('-').map(Number);
      dueMs = Date.UTC(y!, m! - 1, d! + 1); // midnight of next day = end of this day
    } else {
      dueMs = new Date(fm.due).getTime();
    }
    const timeUntilDueMs = dueMs - nowMs;

    if (timeUntilDueMs >= 0 && timeUntilDueMs < MS_24H) {
      const noRecentProgress =
        updatedMs === null || nowMs - updatedMs > MS_48H;

      if (noRecentProgress) {
        return {
          userId: 0, // placeholder — filled in by notifyItemStateChange
          itemId: fm.id,
          kind: 'item-state',
          triggerType: 'due-in-24h-no-progress',
          reason: buildTriggerReason('due-in-24h-no-progress'),
          triggerContext: `kind=item-state reason=due_24h itemId=${fm.id}`,
          detectedAt: now.toISOString(),
        };
      }
    }
  }

  // --- Condition 2: goal-stale-14d ---
  // goal type, status active, not updated in 14d
  if (fm.type === 'goal') {
    const ageWithoutUpdateMs = updatedMs !== null
      ? nowMs - updatedMs
      : nowMs - createdMs;

    if (ageWithoutUpdateMs > MS_14D) {
      return {
        userId: 0,
        itemId: fm.id,
        kind: 'item-state',
        triggerType: 'goal-stale-14d',
        reason: buildTriggerReason('goal-stale-14d'),
        triggerContext: `kind=item-state reason=goal_stale_14d itemId=${fm.id}`,
        detectedAt: now.toISOString(),
      };
    }
  }

  // --- Condition 3: persistent-zero-engagement-7d ---
  // coachIntensity === 'persistent', no engagement in last 7d
  if (fm.coachIntensity === 'persistent') {
    const lastEngagedMs = coachMemory.lastEngagedAt
      ? new Date(coachMemory.lastEngagedAt).getTime()
      : null;

    const noRecentEngagement =
      lastEngagedMs === null || nowMs - lastEngagedMs > MS_7D;

    if (noRecentEngagement) {
      return {
        userId: 0,
        itemId: fm.id,
        kind: 'item-state',
        triggerType: 'persistent-zero-engagement-7d',
        reason: buildTriggerReason('persistent-zero-engagement-7d'),
        triggerContext: `kind=item-state reason=persistent_zero_engagement_7d itemId=${fm.id}`,
        detectedAt: now.toISOString(),
      };
    }
  }

  // --- Condition 4: new-vague-goal ---
  // goal type, created < 24h ago, title < 8 tokens, no notes
  if (fm.type === 'goal') {
    const ageMs = nowMs - createdMs;

    if (ageMs < MS_24H) {
      const titleTokens = tokenize(fm.title);
      const hasNotes = item.notesBody.trim().length > 0;

      if (titleTokens.length < VAGUE_GOAL_TITLE_MIN_TOKENS && !hasNotes) {
        return {
          userId: 0,
          itemId: fm.id,
          kind: 'item-state',
          triggerType: 'new-vague-goal',
          reason: buildTriggerReason('new-vague-goal'),
          triggerContext: `kind=item-state reason=vague_new_goal itemId=${fm.id}`,
          detectedAt: now.toISOString(),
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Boot-time callback registry (same pattern as v1.19.0 calendar sync)
// ---------------------------------------------------------------------------

/**
 * Type for the item-state monitor callback.
 * Receives userId + the just-written item. Fire-and-forget.
 */
export type ItemStateMonitorCallback = (userId: number, item: OrganizeItem) => void;

let _itemStateMonitorCallback: ItemStateMonitorCallback | null = null;

/**
 * Register the item-state monitor callback (called at boot from src/index.ts).
 * Fires after every createItem / updateItem write via storage.ts post-write hook.
 *
 * ADR 020 D17 boot-wiring lint asserts this is NOT registered with a stub.
 */
export function registerItemStateMonitorCallback(cb: ItemStateMonitorCallback): void {
  _itemStateMonitorCallback = cb;
}

/**
 * Internal: fire the item-state monitor callback fire-and-forget.
 * Called from storage.ts post-write hooks (same as _fireCalendarSync pattern).
 */
export function fireItemStateMonitor(userId: number, item: OrganizeItem): void {
  if (_itemStateMonitorCallback) {
    Promise.resolve()
      .then(() => _itemStateMonitorCallback!(userId, item))
      .catch((err: unknown) => {
        log.warn(
          {
            userId,
            itemId: item.frontMatter.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'item-state monitor callback rejected',
        );
      });
  }
}

// ---------------------------------------------------------------------------
// notifyItemStateChange — callback body (registered at boot)
// ---------------------------------------------------------------------------

/**
 * Dependencies for notifyItemStateChange.
 * Subset of TriggerFireDeps + coachMemory reader.
 */
export interface ItemStateMonitorDeps extends TriggerFireDeps {
  /**
   * Read coach memory for a specific item.
   * Returns ItemCoachMemory or null if no memory exists.
   */
  readItemCoachMemory: (userId: number, itemId: string) => Promise<ItemCoachMemory | null>;
}

/**
 * Main callback body — invoked via fire-and-forget after every item write.
 *
 * 1. Reads coach memory for the item (for engagement check).
 * 2. Calls detectItemStateTrigger (pure detect).
 * 3. If trigger detected, calls dispatchTrigger (rate-limits + fire).
 *
 * Failures are logged and silently swallowed — must not block storage writes.
 * ADR 020 D17 boot-wiring lint asserts the registered callback calls this function.
 */
export async function notifyItemStateChange(
  deps: ItemStateMonitorDeps,
  userId: number,
  item: OrganizeItem,
): Promise<void> {
  try {
    const coachMemory = await deps.readItemCoachMemory(userId, item.frontMatter.id) ?? {};
    const trigger = detectItemStateTrigger(item, coachMemory);

    if (!trigger) {
      log.debug({ userId, itemId: item.frontMatter.id }, 'itemStateMonitor: no trigger detected');
      return;
    }

    // Stamp userId (was 0 placeholder in pure detect)
    const stampedTrigger: TriggerRecord = { ...trigger, userId };

    log.info(
      { userId, itemId: item.frontMatter.id, triggerType: trigger.triggerType },
      'itemStateMonitor: trigger detected, dispatching',
    );

    await dispatchTrigger(deps, stampedTrigger);
  } catch (err) {
    log.error(
      {
        userId,
        itemId: item.frontMatter.id,
        err: err instanceof Error ? err.message : String(err),
      },
      'itemStateMonitor: notifyItemStateChange threw — swallowed',
    );
  }
}
