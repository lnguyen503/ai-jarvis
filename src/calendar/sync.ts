/**
 * sync.ts — Google Calendar two-way sync for organize items (v1.19.0 ADR 019).
 *
 * Exports:
 *   - notifyCalendarSync()          — post-write hook entry point (D4 + R2 debounce)
 *   - syncItemToCalendar()          — forward sync one item → calendar event
 *   - syncCalendarEventToItem()     — reverse sync one calendar event → organize item
 *   - pollCalendarChanges()         — poll Google Calendar for changes (D6 5-min cadence)
 *   - ensureJarvisCalendar()        — idempotent find-or-create "Jarvis Organize" (D8)
 *   - sanitizeCalendarTextForSync() — R1 Layer (a) sanitizer (strong reject)
 *
 * ADR 019 D14 ONE-WAY EDGE (BINDING):
 *   src/calendar/ reads from src/organize/ + src/google/ + src/memory/.
 *   NO file in src/organize/** may import from src/calendar/**.
 *   The post-write hook is registered via a callback in src/index.ts (boot),
 *   not by organize importing calendar. Static test enforces this invariant.
 *
 * ADR 019-revisions R1 Layer (a):
 *   sanitizeCalendarTextForSync() runs on EVERY reverse-sync ingest path.
 *   It does NOT run on forward-sync (we trust our own output).
 *   NUL-byte ban + per-field char caps + strong-reject injection markers.
 *
 * ADR 019-revisions R2 circuit breaker + debounce:
 *   - Per-user 500ms debounce buffer: latest-write-wins per itemId.
 *   - Pre-spawn skip check: goals/no-due/done/intensity_off never sync.
 *   - Circuit breaker: 5 consecutive failures → DM user + pause syncing.
 *
 * Dependency edges (binding per ADR 019 D14):
 *   sync.ts → calendar/syncTypes, calendar/syncCursor
 *            → google/calendar (CalendarApi)
 *            → organize/types (OrganizeItem — types only; no storage import here)
 *            → memory/userMemoryEntries (via syncCursor)
 *            → memory/auditLog (AuditCategory)
 *            → logger
 *   FORBIDDEN: NO import from src/organize/storage.ts or src/organize/** non-type modules.
 *              calendar → organize(types) is OK; calendar → organize(storage) is FORBIDDEN.
 */

import { child } from '../logger/index.js';
import type { OrganizeItem } from '../organize/types.js';
import type { SyncResult, SyncSkipReason, SyncCursorBody } from './syncTypes.js';

const log = child({ component: 'calendar.sync' });

// ---------------------------------------------------------------------------
// Calendar event monitor callback registry (v1.20.0 ADR 020 D6.c)
// Same fire-and-forget registry pattern as organize/storage.ts.
// FORBIDDEN: sync.ts MUST NOT import from coach/**. The coach module registers
// its callback at boot via registerCalendarEventCallback() from coach/calendarMonitor.ts.
// ---------------------------------------------------------------------------

/** Minimal event shape passed to the calendar event monitor callback. */
export interface CalendarMonitorEvent {
  id: string;
  summary: string;
  description?: string;
  start: string | null;
  itemId: string;
  recurringEventId?: string;
}

/** Type for the calendar event monitor callback. */
export type CalendarEventMonitorCallback = (userId: number, event: CalendarMonitorEvent) => void;

let _calendarEventMonitorCallback: CalendarEventMonitorCallback | null = null;

/**
 * Register the calendar event monitor callback (called at boot from src/index.ts).
 * Fires after every event processed by pollCalendarChanges (ADR 020 D6.c).
 * ADR 020 D17: must NOT be registered with an identity stub.
 */
export function registerCalendarEventMonitorCallback(cb: CalendarEventMonitorCallback): void {
  _calendarEventMonitorCallback = cb;
}

function _fireCalendarEventMonitor(userId: number, event: CalendarMonitorEvent): void {
  if (_calendarEventMonitorCallback) {
    Promise.resolve()
      .then(() => _calendarEventMonitorCallback!(userId, event))
      .catch(() => {
        // swallow — must not affect calendar sync
      });
  }
}

// ---------------------------------------------------------------------------
// R1 Layer (a) — Sanitizer constants
// ---------------------------------------------------------------------------

/** Title max chars (matches OrganizeFrontMatter.title cap). */
const TITLE_MAX = 200;

/** Description max chars (matches notes cap). */
const DESCRIPTION_MAX = 4096;

/** Truncation marker appended when content exceeds char cap. */
const TRUNCATION_MARKER = '[truncated]';

/**
 * Prompt-injection marker patterns (strong-reject; per ADR 019-revisions R1).
 * These are NOT user-content patterns — they are structural injection markers.
 * Any match → reject the entire field; do not sanitize/escape.
 */
const INJECTION_MARKER_PATTERNS: RegExp[] = [
  /<untrusted/i,
  /<\/untrusted/i,
  /<system>/i,
  /<\/system>/i,
  /ignore\s+previous\s+instructions/i,
  /disregard\s+the\s+above/i,
  /<!--\s*key:/i,     // sentinel-injection guard (v1.17.0 R3 + F1 pattern verbatim)
  /<!--\s*coach:/i,   // coach-sentinel variant
];

// ---------------------------------------------------------------------------
// R1 Layer (a) — sanitizeCalendarTextForSync
// ---------------------------------------------------------------------------

/**
 * R1 Layer (a) sanitizer — runs on EVERY reverse-sync ingest.
 *
 * Algorithm:
 * 1. NUL-byte ban: reject any \x00 byte (code NUL_BYTE_REJECTED).
 * 2. Normalize to NFC (for Unicode-NFC variant detection of injection markers).
 * 3. Strong-reject injection markers (code INJECTION_MARKER).
 * 4. Char cap: truncate (not reject) at field-specific cap; emit audit hint.
 *
 * Returns:
 *   { ok: true; sanitized: string }               — clean content (may be truncated)
 *   { ok: false; code: string; reason: string }   — rejected; caller must skip + audit
 *
 * Only runs on REVERSE-SYNC ingest (calendar → organize).
 * Does NOT run on forward-sync (organize → calendar) — we trust our own output.
 */
export function sanitizeCalendarTextForSync(
  field: 'summary' | 'description',
  value: string, // ALLOWED: function parameter — not an audit detail field
): { ok: true; sanitized: string; truncated: boolean } | { ok: false; code: string; reason: string } {
  // 1. NUL-byte ban
  if (value.includes('\x00')) {
    return { ok: false, code: 'NUL_BYTE_REJECTED', reason: 'Field contains NUL byte' };
  }

  // 2. Normalize to NFC for injection detection
  const normalized = value.normalize('NFC');

  // 3. Strong-reject injection markers
  for (const pattern of INJECTION_MARKER_PATTERNS) {
    if (pattern.test(normalized)) {
      return { ok: false, code: 'INJECTION_MARKER', reason: `Field matches injection marker pattern: ${pattern.source}` };
    }
  }

  // 4. Char cap: truncate with marker
  const cap = field === 'summary' ? TITLE_MAX : DESCRIPTION_MAX;
  if (normalized.length > cap) {
    const sanitized = normalized.slice(0, cap - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    return { ok: true, sanitized, truncated: true };
  }

  return { ok: true, sanitized: normalized, truncated: false };
}

// ---------------------------------------------------------------------------
// R2 — Pre-spawn skip check
// ---------------------------------------------------------------------------

/**
 * Determine whether an item should be queued for calendar sync.
 * Returns { skip: true; reason } for items that should never sync.
 * Returns { skip: false } for items that should sync.
 *
 * Per ADR 019-revisions R2 Part 2 (binding).
 */
export function shouldQueueForSync(item: OrganizeItem): { skip: false } | { skip: true; reason: SyncSkipReason } {
  const fm = item.frontMatter;

  if (!fm.due) return { skip: true, reason: 'no_due_date' };
  if (fm.deletedAt) return { skip: true, reason: 'soft_deleted' };
  if (fm.type === 'goal') return { skip: true, reason: 'goal_type' };
  if (fm.status === 'done') return { skip: true, reason: 'status_done' };
  if (fm.coachIntensity === 'off') return { skip: true, reason: 'intensity_off' };

  return { skip: false };
}

// ---------------------------------------------------------------------------
// R2 — Per-user debounce buffer
// ---------------------------------------------------------------------------

interface UserSyncQueue {
  items: Map<string, OrganizeItem>;
  timer: ReturnType<typeof setTimeout> | null;
}

const _userSyncQueues = new Map<number, UserSyncQueue>();

/** Debounce window in ms (ADR 019-revisions R2 Part 1). */
const DEBOUNCE_MS = 500;

/**
 * Post-write hook entry point. Called by src/organize/storage.ts via the
 * registered callback after every successful updateItem / createItem / restoreItem.
 *
 * Behavior:
 *   1. Pre-spawn skip check: if item should not sync, audit + return.
 *   2. Queue item into the per-user debounce buffer.
 *   3. Reset the 500ms timer (latest-write-wins per itemId).
 *   4. After the 500ms quiet window, flush the batch sequentially.
 *
 * The callback itself is registered at boot in src/index.ts; see D4 callback pattern.
 */
export function notifyCalendarSync(
  userId: number,
  item: OrganizeItem,
  deps: SyncDeps,
): void {
  const skipCheck = shouldQueueForSync(item);
  if (skipCheck.skip) {
    log.debug({ userId, itemId: item.frontMatter.id, reason: skipCheck.reason }, 'calendar sync: pre-spawn skip');
    deps.auditSkip(userId, item.frontMatter.id, skipCheck.reason);
    return;
  }

  let entry = _userSyncQueues.get(userId);
  if (!entry) {
    entry = { items: new Map(), timer: null };
    _userSyncQueues.set(userId, entry);
  }

  // Latest-write-wins per itemId
  entry.items.set(item.frontMatter.id, item);

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const batch = Array.from(entry!.items.values());
    entry!.items.clear();
    entry!.timer = null;
    void flushSyncBatch(userId, batch, deps);
  }, DEBOUNCE_MS);
}

/**
 * Flush a batch of items to Google Calendar sequentially (not parallel).
 * Sequential to stay under Google's per-user QPS limit.
 */
async function flushSyncBatch(
  userId: number,
  batch: OrganizeItem[],
  deps: SyncDeps,
): Promise<void> {
  // Check circuit breaker before making any API calls
  const breakerOpen = await deps.isCircuitBreakerOpen(userId);
  if (breakerOpen) {
    log.info({ userId, batchSize: batch.length }, 'calendar sync: circuit breaker open — skipping batch');
    for (const item of batch) {
      deps.auditSkip(userId, item.frontMatter.id, 'circuit_breaker_open');
    }
    return;
  }

  for (const item of batch) {
    await syncItemToCalendar(item, userId, deps);
  }
}

// ---------------------------------------------------------------------------
// R2 — Process shutdown drain
// ---------------------------------------------------------------------------

/**
 * Drain all pending debounce queues immediately (called on SIGTERM/SIGINT).
 * Returns a Promise that resolves when all queues are flushed or the timeout expires.
 */
export async function drainAllQueues(deps: SyncDeps, timeoutMs = 5000): Promise<void> {
  const drainPromises: Promise<void>[] = [];

  for (const [userId, entry] of _userSyncQueues.entries()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.items.size > 0) {
      const batch = Array.from(entry.items.values());
      entry.items.clear();
      drainPromises.push(flushSyncBatch(userId, batch, deps));
    }
  }
  _userSyncQueues.clear();

  if (drainPromises.length === 0) return;

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      log.warn({ pending: drainPromises.length }, 'calendar sync: drain timeout — some queues not flushed');
      resolve();
    }, timeoutMs);
  });

  await Promise.race([Promise.allSettled(drainPromises).then(() => undefined), timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Forward sync: organize item → Google Calendar event
// ---------------------------------------------------------------------------

/**
 * Sync a single organize item to a Google Calendar event.
 * Creates a new event if no calendarEventId; updates if it has one.
 *
 * Implementation details:
 *   - Done items get a "✅ " prefix on the event title.
 *   - calendarEventId is stored back on the item via the deps.updateItemCalendarId callback.
 *   - lastSyncedAt is stored in keyed memory via deps.updateLastSyncedAt.
 *
 * @param item   The organize item to sync.
 * @param userId The user ID (for calendar API auth + audit).
 * @param deps   Injected dependencies for testability.
 */
export async function syncItemToCalendar(
  item: OrganizeItem,
  userId: number,
  deps: SyncDeps,
): Promise<SyncResult> {
  const fm = item.frontMatter;

  try {
    const calendarId = await deps.ensureJarvisCalendar(userId);
    if (!calendarId) {
      log.warn({ userId, itemId: fm.id }, 'calendar sync: no calendarId — skipping');
      return { ok: false, error: 'CALENDAR_NOT_AVAILABLE', action: 'skipped' };
    }

    // Construct event title (done items prefixed with ✅)
    const summary = fm.status === 'done' ? `✅ ${fm.title}` : fm.title;

    // Event time: due date → all-day event (1-day span)
    const startDate = fm.due!; // already checked by shouldQueueForSync
    // For all-day events, end date is exclusive next day
    const endDate = nextDay(startDate);

    if (!fm.calendarEventId) {
      // Create new event
      const event = await deps.createCalendarEvent({
        calendarId,
        summary,
        startTime: startDate,
        endTime: endDate,
        allDay: true,
        description: item.notesBody.trim() || undefined,
        itemId: fm.id,
      });

      // Store the calendarEventId back on the item
      await deps.updateItemCalendarId(userId, fm.id, event.id);
      await deps.updateLastSyncedAt(userId, fm.id);

      deps.auditSuccess(userId, fm.id, event.id, 'to_event', ['title', 'due', 'notes']);
      log.info({ userId, itemId: fm.id, eventId: event.id }, 'calendar sync: created event');
      return { ok: true, eventId: event.id, action: 'created' };
    } else {
      // Update existing event
      const event = await deps.updateCalendarEvent({
        calendarId,
        eventId: fm.calendarEventId,
        summary,
        startTime: startDate,
        endTime: endDate,
        allDay: true,
        description: item.notesBody.trim() || undefined,
      });

      await deps.updateLastSyncedAt(userId, fm.id);
      deps.auditSuccess(userId, fm.id, event.id, 'to_event', ['title', 'due', 'notes']);
      log.info({ userId, itemId: fm.id, eventId: event.id }, 'calendar sync: updated event');
      return { ok: true, eventId: event.id, action: 'updated' };
    }
  } catch (err) {
    const errorCode = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    log.warn({ userId, itemId: fm.id, errorCode }, 'calendar sync: forward sync failed');
    await deps.recordFailure(userId, errorCode);
    deps.auditFailure(userId, fm.id, errorCode);
    return { ok: false, error: errorCode, action: 'skipped' };
  }
}

// ---------------------------------------------------------------------------
// Reverse sync: Google Calendar event → organize item
// ---------------------------------------------------------------------------

/**
 * Reverse sync: apply one Google Calendar event's changes back to an organize item.
 * Runs the R1 Layer (a) sanitizer on summary + description before any storage write.
 *
 * @param event   The normalized calendar event (from CalendarEventSummary).
 * @param userId  The user ID.
 * @param deps    Injected dependencies.
 */
export async function syncCalendarEventToItem(
  event: {
    id: string;
    summary: string;
    description?: string;
    start: string | null;
    updated?: string;
    itemId?: string;
  },
  userId: number,
  deps: SyncDeps,
): Promise<SyncResult> {
  if (!event.itemId) {
    log.info({ userId, eventId: event.id }, 'calendar reverse-sync: no itemId — skipping external event');
    return { ok: true, action: 'skipped' };
  }

  // Run Layer (a) sanitizer on summary
  const summaryResult = sanitizeCalendarTextForSync('summary', event.summary);
  if (!summaryResult.ok) {
    log.warn({ userId, eventId: event.id, code: summaryResult.code }, 'calendar reverse-sync: rejected injection in summary');
    deps.auditRejectedInjection(userId, event.itemId, event.id, summaryResult.code, 'summary');
    return { ok: false, error: summaryResult.code, action: 'skipped' };
  }
  if (summaryResult.truncated) {
    deps.auditTruncated(userId, event.itemId, event.id, 'summary', event.summary.length, summaryResult.sanitized.length);
  }

  // Run Layer (a) sanitizer on description (if present)
  let sanitizedDescription: string | undefined;
  if (event.description !== undefined) {
    const descResult = sanitizeCalendarTextForSync('description', event.description);
    if (!descResult.ok) {
      log.warn({ userId, eventId: event.id, code: descResult.code }, 'calendar reverse-sync: rejected injection in description');
      deps.auditRejectedInjection(userId, event.itemId, event.id, descResult.code, 'description');
      return { ok: false, error: descResult.code, action: 'skipped' };
    }
    if (descResult.truncated) {
      deps.auditTruncated(userId, event.itemId, event.id, 'description', event.description.length, descResult.sanitized.length);
    }
    sanitizedDescription = descResult.sanitized;
  }

  // Check if item exists; if not, create a new task from the event
  const existingItem = await deps.readItem(userId, event.itemId);
  if (!existingItem) {
    // User-created event in the Jarvis calendar (no matching item) — create a new task
    if (event.start) {
      await deps.createItemFromEvent(userId, {
        title: summaryResult.sanitized, // ALLOWED: item creation — not an audit detail field
        due: event.start.slice(0, 10), // YYYY-MM-DD
        notes: sanitizedDescription,
        calendarEventId: event.id,
      });
      log.info({ userId, eventId: event.id }, 'calendar reverse-sync: created item from event');
      return { ok: true, eventId: event.id, action: 'created' };
    }
    return { ok: true, action: 'skipped' };
  }

  // D7 conflict resolution: webapp wins within 1-min window; ties (±1s) → webapp wins.
  // Binding per ADR 019 D7.
  const WEBAPP_WINS_WINDOW_MS = 60 * 1000;
  const nowMs = Date.now();
  const itemUpdatedMs = existingItem.frontMatter.updated
    ? new Date(existingItem.frontMatter.updated).getTime()
    : null;

  if (itemUpdatedMs !== null) {
    const itemAgeMs = nowMs - itemUpdatedMs;

    if (itemAgeMs < WEBAPP_WINS_WINDOW_MS) {
      // Item was updated within the last 60s → webapp wins; skip calendar overwrite.
      log.debug(
        { userId, itemId: event.itemId, itemAgeMs },
        'calendar reverse-sync: webapp wins (within 1-min window)',
      );
      return { ok: true, action: 'skipped' };
    }

    // Tie check: if item.updated and event.updated are within ±1s → webapp wins.
    const calendarUpdatedMs = event.updated ? new Date(event.updated).getTime() : null;
    if (calendarUpdatedMs !== null && Math.abs(calendarUpdatedMs - itemUpdatedMs) <= 1000) {
      log.debug(
        { userId, itemId: event.itemId },
        'calendar reverse-sync: webapp wins (tie within ±1s)',
      );
      return { ok: true, action: 'skipped' };
    }
  }

  // Update existing item with sanitized event data
  await deps.updateItemFromEvent(userId, event.itemId, {
    title: summaryResult.sanitized, // ALLOWED: item update — not an audit detail field
    due: event.start ? event.start.slice(0, 10) : undefined,
    notes: sanitizedDescription,
  });
  await deps.updateLastSyncedAt(userId, event.itemId);

  deps.auditSuccess(userId, event.itemId, event.id, 'from_event', ['title', 'due', 'notes']);
  log.info({ userId, itemId: event.itemId, eventId: event.id }, 'calendar reverse-sync: updated item from event');
  return { ok: true, eventId: event.id, action: 'updated' };
}

// ---------------------------------------------------------------------------
// Poll calendar changes (D6 5-min cadence)
// ---------------------------------------------------------------------------

/**
 * Poll Google Calendar for changes since the last sync cursor.
 * Integrates R1 Layer (a) sanitizer on every event's summary + description.
 *
 * Algorithm (ADR 019 D5 + D6, binding):
 * 1. Read cursor from keyed memory. If present, use its `lastPolledAt` as `updatedMin`.
 *    If missing (first run or reset), fall back to 24h lookback.
 * 2. Call deps.listCalendarEvents(userId, calendarId, updatedMin).
 * 3. For each returned event, run syncCalendarEventToItem (includes R1 Layer (a) sanitizer).
 * 4. On success: write new cursor with current timestamp via deps.writeSyncCursor(userId, cursor).
 * 5. On API failure: record failure (circuit breaker); do NOT advance cursor.
 *
 * Called by calendarPoller.ts every 5 minutes (src/calendar/calendarPoller.ts).
 */
export async function pollCalendarChanges(userId: number, deps: SyncDeps): Promise<void> {
  const calendarId = await deps.ensureJarvisCalendar(userId);
  if (!calendarId) {
    log.debug({ userId }, 'calendar poll: no calendarId — skipping');
    return;
  }

  // Read cursor to determine updatedMin for the Google API call.
  // Null = first run or reset; fall back to 24h lookback.
  const cursor = await deps.readSyncCursor(userId);
  const now = new Date().toISOString();

  // Cursor present → use its lastPolledAt as updatedMin (plus 1ms epsilon to avoid duplicates).
  // Cursor absent → 24h lookback.
  let updatedMin: string;
  if (cursor) {
    const cursorMs = new Date(cursor.lastPolledAt).getTime();
    updatedMin = new Date(cursorMs + 1).toISOString();
  } else {
    const fallbackMs = Date.now() - 24 * 60 * 60 * 1000;
    updatedMin = new Date(fallbackMs).toISOString();
  }

  try {
    const events = await deps.listCalendarEvents(userId, calendarId, updatedMin);

    log.debug({ userId, eventCount: events.length, updatedMin }, 'calendar poll: processing events');

    for (const event of events) {
      const result = await syncCalendarEventToItem(event, userId, deps);
      // v1.20.0 ADR 020 D6.c: fire calendar event monitor after successful sync
      // (created or updated — skipped events don't need coach inspection).
      if (result.ok && result.action !== 'skipped' && event.itemId) {
        _fireCalendarEventMonitor(userId, {
          id: event.id,
          summary: event.summary,
          description: event.description,
          start: event.start,
          itemId: event.itemId,
          recurringEventId: event.recurringEventId,
        });
      }
    }

    // Advance cursor to now on success.
    const newCursor: SyncCursorBody = {
      lastPolledAt: now,
      lastEventEtag: '',  // nextSyncToken not used in this rev; reserved for D5 future use
    };
    await deps.writeSyncCursor(userId, newCursor);

    log.info({ userId, eventCount: events.length }, 'calendar poll: complete');
  } catch (err) {
    const errorCode = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    log.warn({ userId, errorCode }, 'calendar poll: failed');
    await deps.recordFailure(userId, errorCode);
    // Do NOT advance cursor on failure — next poll re-tries same window.
  }
}

// ---------------------------------------------------------------------------
// ensureJarvisCalendar (D8)
// ---------------------------------------------------------------------------

/**
 * Idempotent find-or-create for the "Jarvis Organize" calendar.
 * Returns the calendar ID string, or null if the API fails.
 *
 * Algorithm per ADR 019 D8:
 * 1. Read keyed memory `calendar.jarvis_calendar_id`.
 * 2. If present: validate (verify alive via calendars.get); if 404, proceed to find/create.
 * 3. If missing: listCalendars(), scan for "Jarvis Organize"; if found, store + return.
 * 4. If not found: createCalendar("Jarvis Organize", description); store + return.
 *
 * Implementation is delegated to deps.getOrCreateJarvisCalendar() for testability.
 */
export async function ensureJarvisCalendar(
  userId: number,
  deps: SyncDeps,
): Promise<string | null> {
  return deps.ensureJarvisCalendar(userId);
}

// ---------------------------------------------------------------------------
// SyncDeps interface (for testability + boot-time injection)
// ---------------------------------------------------------------------------

/**
 * All external dependencies for the sync module.
 * Injected at boot in src/index.ts; mocked in tests.
 *
 * This interface allows full unit testing without a live Google API or database.
 */
export interface SyncDeps {
  // Calendar API operations
  createCalendarEvent(opts: {
    calendarId: string;
    summary: string;
    startTime: string;
    endTime: string;
    allDay: boolean;
    description?: string;
    itemId: string;
  }): Promise<{ id: string; updated?: string }>;

  updateCalendarEvent(opts: {
    calendarId: string;
    eventId: string;
    summary: string;
    startTime: string;
    endTime: string;
    allDay: boolean;
    description?: string;
  }): Promise<{ id: string; updated?: string }>;

  deleteCalendarEvent(calendarId: string, eventId: string): Promise<void>;

  listCalendarEvents(
    userId: number,
    calendarId: string,
    /** ISO 8601 timestamp — if provided, only return events updated after this time. */
    updatedMin?: string,
  ): Promise<Array<{
    id: string;
    summary: string;
    description?: string;
    start: string | null;
    updated?: string;
    itemId?: string;
    /** v1.20.0 ADR 020 D6.c: present on recurring event instances. */
    recurringEventId?: string;
  }>>;

  // Jarvis calendar management
  ensureJarvisCalendar(userId: number): Promise<string | null>;

  // Organize item operations (no direct import from storage.ts — caller provides)
  readItem(userId: number, itemId: string): Promise<OrganizeItem | null>;
  updateItemCalendarId(userId: number, itemId: string, calendarEventId: string): Promise<void>;
  updateItemFromEvent(userId: number, itemId: string, patch: { title?: string; due?: string; notes?: string }): Promise<void>; // ALLOWED: interface type definition — not an audit detail field
  createItemFromEvent(userId: number, opts: { title: string; due: string; notes?: string; calendarEventId: string }): Promise<void>; // ALLOWED: interface type definition — not an audit detail field

  // Sync state
  updateLastSyncedAt(userId: number, itemId: string): Promise<void>;
  readSyncCursor(userId: number): Promise<SyncCursorBody | null>;
  writeSyncCursor(userId: number, cursor: SyncCursorBody): Promise<void>;

  // Circuit breaker
  isCircuitBreakerOpen(userId: number): Promise<boolean>;
  recordFailure(userId: number, errorCode: string): Promise<void>;
  recordSuccess(userId: number): Promise<void>;

  // Audit emission
  auditSuccess(userId: number, itemId: string, eventId: string, direction: 'to_event' | 'from_event', fields: string[]): void;
  auditFailure(userId: number, itemId: string, errorCode: string): void;
  auditSkip(userId: number, itemId: string, reason: SyncSkipReason): void;
  auditRejectedInjection(userId: number, itemId: string, calendarEventId: string, markerHit: string, field: string): void;
  auditTruncated(userId: number, itemId: string, calendarEventId: string, field: string, originalLen: number, truncatedLen: number): void;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Given a YYYY-MM-DD date string, return the next calendar day.
 * Used for all-day event exclusive end date (Google convention).
 */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Export for test access. */
export { _userSyncQueues };
