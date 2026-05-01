/**
 * breakerState.ts — Calendar OAuth circuit breaker (v1.19.0 ADR 019-revisions R2 Part 3).
 *
 * Owns the consecutive-failure counter for forward + reverse calendar sync.
 * Stored in keyed memory under `calendar.consecutive_failures`.
 *
 * Behavior (binding per ADR 019 R2 Part 3):
 *   - Increment on every API failure.
 *   - At count === 5 AND `lastNotifiedAt` is null OR > 24h ago: DM the user
 *     "Calendar sync paused — your Google authorization may have expired.
 *      Reauthorize via `/calendar setup` in a normal chat message."
 *     Set `lastNotifiedAt` to now. Audit `calendar.fail_token_expired`.
 *     The DM is dedup'd at 24h to avoid spam if the user hasn't reauthorized.
 *   - At count >= 5: subsequent calls to `isCircuitBreakerOpen()` return true;
 *     `flushSyncBatch` (in sync.ts) skips the API call and audits as
 *     `calendar.sync_skipped` with reason `circuit_breaker_open`.
 *   - On success: reset counter to 0; if breaker was open, audit
 *     `calendar.circuit_breaker_reset`.
 *
 * Why circuit breaker NOT inside the polling loop:
 *   The polling loop is a separate failure surface (network errors, transient
 *   5xx) that we want to retry without the breaker. The breaker fires on 5
 *   consecutive failures specifically so transient errors don't trip it; only
 *   systemic failures (token expiration; calendar deleted; permission revoked)
 *   accumulate enough to trip.
 *
 * Dependency edges (binding):
 *   breakerState.ts → memory/userMemoryEntries (sole-writer for the breaker key)
 *                   → messaging/adapter (DM owner on threshold trip)
 *                   → memory/auditLog (AuditLogRepo for category emission)
 *   NO import from src/calendar/sync.ts (avoid circular).
 */

import { getEntry, createEntry, updateEntry } from '../memory/userMemoryEntries.js';
import { child } from '../logger/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { AuditLogRepo } from '../memory/auditLog.js';

const log = child({ component: 'calendar.breaker' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keyed memory key for the breaker state (per ADR 019 R2 Part 3). */
const BREAKER_KEY = 'calendar.consecutive_failures';

/** Threshold for tripping the breaker. */
export const BREAKER_THRESHOLD = 5;

/** Re-DM dedup window (24h). */
const DM_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** DM body sent to the user when the breaker first trips. */
export const BREAKER_DM_BODY =
  'Calendar sync paused — your Google authorization may have expired. ' +
  'Reauthorize via `/calendar setup` in a normal chat message.';

// ---------------------------------------------------------------------------
// State shape (stored as JSON in keyed memory)
// ---------------------------------------------------------------------------

interface BreakerState {
  /** Consecutive-failure count. Reset to 0 on success. */
  count: number;
  /**
   * ISO timestamp of the most recent error (for forensics + audit detail).
   * Null when count === 0.
   */
  lastErrorAt: string | null;
  /** Most recent error code (truncated). Null when count === 0. */
  lastErrorCode: string | null;
  /**
   * ISO timestamp of the most recent owner DM. Used for 24h DM-dedup.
   * Null when no DM has ever been sent.
   */
  lastNotifiedAt: string | null;
}

const ZERO_STATE: BreakerState = {
  count: 0,
  lastErrorAt: null,
  lastErrorCode: null,
  lastNotifiedAt: null,
};

// ---------------------------------------------------------------------------
// Internal helpers — read/write breaker state via keyed memory
// ---------------------------------------------------------------------------

async function readState(userId: number, dataDir: string): Promise<BreakerState> {
  const entry = await getEntry(userId, dataDir, BREAKER_KEY);
  if (!entry) return { ...ZERO_STATE };

  try {
    const parsed: unknown = JSON.parse(entry.body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'count' in parsed &&
      typeof (parsed as { count: unknown }).count === 'number'
    ) {
      const p = parsed as Partial<BreakerState>;
      return {
        count: typeof p.count === 'number' && Number.isFinite(p.count) ? p.count : 0,
        lastErrorAt: typeof p.lastErrorAt === 'string' ? p.lastErrorAt : null,
        lastErrorCode: typeof p.lastErrorCode === 'string' ? p.lastErrorCode : null,
        lastNotifiedAt: typeof p.lastNotifiedAt === 'string' ? p.lastNotifiedAt : null,
      };
    }
    log.warn(
      { userId, body: entry.body.slice(0, 80) },
      'breakerState: invalid shape — treating as zero state',
    );
    return { ...ZERO_STATE };
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'breakerState: JSON.parse failed — treating as zero state',
    );
    return { ...ZERO_STATE };
  }
}

async function writeState(
  userId: number,
  dataDir: string,
  state: BreakerState,
): Promise<void> {
  const body = JSON.stringify(state);
  const existing = await getEntry(userId, dataDir, BREAKER_KEY);
  if (existing) {
    await updateEntry(userId, dataDir, BREAKER_KEY, body);
  } else {
    await createEntry(userId, dataDir, BREAKER_KEY, body);
  }
}

// ---------------------------------------------------------------------------
// Public API — module-level functions (testable; injected into SyncDeps)
// ---------------------------------------------------------------------------

/**
 * Read the breaker state and return whether it is open.
 *
 * The breaker is open when count >= BREAKER_THRESHOLD (5).
 * `flushSyncBatch` consults this before every batch and skips the API call
 * (auditing each item as `calendar.sync_skipped` with reason `circuit_breaker_open`)
 * when open.
 */
export async function isCircuitBreakerOpen(
  userId: number,
  dataDir: string,
): Promise<boolean> {
  const state = await readState(userId, dataDir);
  return state.count >= BREAKER_THRESHOLD;
}

/**
 * Record a sync failure. Increments the counter. If this increment reaches
 * BREAKER_THRESHOLD for the first time (or after the 24h DM-dedup window),
 * DMs the owner and emits `calendar.fail_token_expired`.
 *
 * @param userId         The user whose breaker state should be incremented.
 * @param dataDir        The data directory for keyed memory.
 * @param errorCode      The (truncated) error code from the failed API call.
 * @param messaging      Messaging adapter for the DM (null = no DM, audit-only).
 * @param auditLog       Audit log repo for the threshold-trip audit row.
 */
export async function recordFailure(
  userId: number,
  dataDir: string,
  errorCode: string,
  messaging: MessagingAdapter | null,
  auditLog: AuditLogRepo,
): Promise<void> {
  const state = await readState(userId, dataDir);
  const nowIso = new Date().toISOString();
  const truncatedCode = errorCode.slice(0, 200);

  const wasOpen = state.count >= BREAKER_THRESHOLD;

  state.count += 1;
  state.lastErrorAt = nowIso;
  state.lastErrorCode = truncatedCode;

  // Threshold check: only fire DM + audit if we just CROSSED into open state
  // (i.e., wasOpen=false AND now state.count >= threshold) OR if we're at >=
  // threshold but the dedup window has elapsed.
  const justTripped = !wasOpen && state.count >= BREAKER_THRESHOLD;

  let shouldDmAndAudit = false;
  if (justTripped) {
    shouldDmAndAudit = true;
  } else if (state.count >= BREAKER_THRESHOLD && state.lastNotifiedAt !== null) {
    const lastMs = new Date(state.lastNotifiedAt).getTime();
    if (!Number.isFinite(lastMs) || Date.now() - lastMs > DM_DEDUP_WINDOW_MS) {
      shouldDmAndAudit = true;
    }
  } else if (state.count >= BREAKER_THRESHOLD && state.lastNotifiedAt === null) {
    // Edge case: count was already >= threshold but lastNotifiedAt is null
    // (e.g., manual write). Treat like first trip.
    shouldDmAndAudit = true;
  }

  if (shouldDmAndAudit) {
    state.lastNotifiedAt = nowIso;

    // Send DM (best-effort). Failures here MUST NOT crash the sync path —
    // the breaker is already audit-logged regardless of DM delivery.
    if (messaging !== null) {
      const dmChatId = messaging.resolveDmChatId(userId);
      if (dmChatId !== null) {
        try {
          await messaging.sendMessage(dmChatId, BREAKER_DM_BODY);
          log.info({ userId, dmChatId, count: state.count }, 'calendar breaker: tripped — DM sent');
        } catch (err) {
          log.warn(
            {
              userId,
              dmChatId,
              err: err instanceof Error ? err.message : String(err),
            },
            'calendar breaker: tripped but DM failed (audit emitted regardless)',
          );
        }
      } else {
        log.warn({ userId }, 'calendar breaker: tripped but no DM chat available');
      }
    }

    // Audit row — structural only; no content fields.
    auditLog.insert({
      category: 'calendar.fail_token_expired',
      actor_user_id: userId,
      detail: {
        count: state.count,
        lastErrorCode: truncatedCode,
      },
    });
  }

  await writeState(userId, dataDir, state);
}

/**
 * Record a sync success. Resets the counter to 0.
 * If the breaker was open (count >= threshold) prior to the reset, emits
 * `calendar.circuit_breaker_reset` with the previous count.
 *
 * @param userId         The user whose breaker state should be reset.
 * @param dataDir        The data directory for keyed memory.
 * @param auditLog       Audit log repo for the auto-reset audit row.
 */
export async function recordSuccess(
  userId: number,
  dataDir: string,
  auditLog: AuditLogRepo,
): Promise<void> {
  const state = await readState(userId, dataDir);
  if (state.count === 0) return; // No-op fast path.

  const previousCount = state.count;
  const wasOpen = previousCount >= BREAKER_THRESHOLD;

  // Reset to ZERO_STATE (preserves nothing — fresh slate).
  await writeState(userId, dataDir, { ...ZERO_STATE });

  if (wasOpen) {
    auditLog.insert({
      category: 'calendar.circuit_breaker_reset',
      actor_user_id: userId,
      detail: {
        previousCount,
        reason: 'auto_recovery',
      },
    });
    log.info({ userId, previousCount }, 'calendar breaker: auto-reset on success');
  }
}

/**
 * Manual reset — exposed for `/calendar reset-circuit-breaker` admin command.
 * Same audit emission as auto-reset but with `reason: 'manual'`.
 */
export async function manualReset(
  userId: number,
  dataDir: string,
  auditLog: AuditLogRepo,
): Promise<void> {
  const state = await readState(userId, dataDir);
  const previousCount = state.count;
  await writeState(userId, dataDir, { ...ZERO_STATE });

  if (previousCount > 0) {
    auditLog.insert({
      category: 'calendar.circuit_breaker_reset',
      actor_user_id: userId,
      detail: {
        previousCount,
        reason: 'manual',
      },
    });
  }
  log.info({ userId, previousCount }, 'calendar breaker: manual reset');
}
