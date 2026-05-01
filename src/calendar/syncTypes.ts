/**
 * syncTypes.ts — Type definitions for the calendar two-way sync module (v1.19.0 ADR 019 D14).
 *
 * Dependency edges (binding per ADR 019 D14 one-way edge invariant):
 *   syncTypes.ts has NO imports from src/organize/** or src/calendar/**
 *   (it is imported BY those modules, not the reverse).
 */

// ---------------------------------------------------------------------------
// Sync direction
// ---------------------------------------------------------------------------

/**
 * Direction of a sync operation.
 * - 'to_event'   — organize item → Google Calendar event (forward sync)
 * - 'from_event' — Google Calendar event → organize item (reverse sync)
 */
export type SyncDirection = 'to_event' | 'from_event';

// ---------------------------------------------------------------------------
// Conflict resolution strategy
// ---------------------------------------------------------------------------

/**
 * How to resolve a conflict when both sides have changed.
 * Per ADR 019 D7: webapp wins within the 1-minute debounce window; after that,
 * last-modified wins; ties (within ±1s) go to webapp.
 */
export type ConflictResolution = 'webapp_wins' | 'calendar_wins' | 'merge';

// ---------------------------------------------------------------------------
// Sync result
// ---------------------------------------------------------------------------

/**
 * Result of a single sync operation on one item.
 */
export interface SyncResult {
  ok: boolean;
  /** Google Calendar event ID (present when action is 'created' or 'updated'). */
  eventId?: string;
  /** Error message when ok is false. */
  error?: string;
  /** What action was performed. */
  action: 'created' | 'updated' | 'deleted' | 'skipped';
}

// ---------------------------------------------------------------------------
// Sync cursor body (D5 keyed memory shape)
// ---------------------------------------------------------------------------

/**
 * Stored in keyed memory as `calendar.jarvis_sync_cursor`.
 * Body shape for JSON serialization.
 */
export interface SyncCursorBody {
  lastPolledAt: string;       // ISO 8601
  lastEventEtag: string;      // Google's nextSyncToken (opaque cursor)
}

// ---------------------------------------------------------------------------
// Circuit breaker body (R2 keyed memory shape)
// ---------------------------------------------------------------------------

/**
 * Stored in keyed memory as `calendar.consecutive_failures`.
 * Body shape for JSON serialization.
 */
export interface CircuitBreakerBody {
  count: number;
  lastFailureAt: string;       // ISO 8601
  lastErrorCode: string;
  lastNotifiedAt: string | null;
}

// ---------------------------------------------------------------------------
// Sync-skip reasons (R2 pre-spawn skip check)
// ---------------------------------------------------------------------------

export type SyncSkipReason =
  | 'no_due_date'
  | 'soft_deleted'
  | 'goal_type'
  | 'status_done'
  | 'intensity_off'
  | 'circuit_breaker_open';
