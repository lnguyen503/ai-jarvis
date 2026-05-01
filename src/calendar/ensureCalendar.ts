/**
 * ensureCalendar.ts — Idempotent find-or-create "Jarvis Organize" calendar (v1.19.0 ADR 019 D8).
 *
 * Algorithm (binding per ADR 019 D8):
 * 1. Read keyed memory `calendar.jarvis_calendar_id`.
 * 2. If present: validate by calling `calendar.calendars.get(id)`.
 *    - HTTP 200: use the cached ID.
 *    - HTTP 404 (user deleted the calendar): reset ID + cursor in memory, proceed to find-or-create.
 * 3. Find by name: `listCalendars()`, scan for summary === "Jarvis Organize".
 *    - Found: write ID to memory + return.
 * 4. Not found: `createCalendar("Jarvis Organize", description)`. Write ID. Return.
 * 5. On API failure: audit `calendar.jarvis_create_failed`, log warn, return null.
 *
 * Dependency edges (binding per ADR 019 D14):
 *   ensureCalendar.ts → google/calendar (CalendarApi)
 *                     → calendar/syncCursor (read/write jarvis_calendar_id)
 *                     → memory/auditLog (AuditCategory)
 *                     → logger
 *   NO import from src/organize/** or src/agent/**.
 */

import type { CalendarApi } from '../google/calendar.js';
import { isNotFoundError } from '../google/calendar.js';
import {
  readJarvisCalendarId,
  writeJarvisCalendarId,
  clearJarvisCalendarId,
  resetCursor,
} from './syncCursor.js';
import { child } from '../logger/index.js';

const log = child({ component: 'calendar.ensureCalendar' });

const JARVIS_CALENDAR_NAME = 'Jarvis Organize';
const JARVIS_CALENDAR_DESCRIPTION = 'Daily organize items synced from Jarvis. Do not edit metadata; edit times by drag.';

/**
 * Per-process verification cache. Avoids re-calling calendars.get() on every
 * poll cycle after the first successful verification.
 */
const _verifiedCalendarIds = new Set<string>();

/**
 * Ensure the "Jarvis Organize" calendar exists and return its ID.
 * Returns null if the API call fails (caller skips sync for this cycle).
 *
 * @param userId   The user ID (for keyed memory read/write).
 * @param dataDir  Data directory (for keyed memory file path).
 * @param calApi   The CalendarApi instance (pre-authenticated).
 * @param auditFn  Optional audit callback for `calendar.jarvis_created` row.
 */
export async function ensureJarvisCalendar(
  userId: number,
  dataDir: string,
  calApi: CalendarApi,
  auditFn?: (detail: Record<string, unknown>) => void,
): Promise<string | null> {
  // Step 1: Read cached calendar ID from keyed memory
  const cachedId = await readJarvisCalendarId(userId, dataDir);

  if (cachedId) {
    // Step 2: Verify the cached ID is still alive (once per process)
    if (_verifiedCalendarIds.has(cachedId)) {
      // Already verified in this process run — use it
      return cachedId;
    }

    // Call calendars.get to verify
    try {
      await (calApi as unknown as { _api: { calendars: { get: (p: { calendarId: string }) => Promise<unknown> } } })
        ._api.calendars.get({ calendarId: cachedId });
      // 200 — still alive
      _verifiedCalendarIds.add(cachedId);
      return cachedId;
    } catch (err) {
      if (isNotFoundError(err)) {
        // User deleted the Jarvis calendar — reset and fall through to find/create
        log.warn({ userId, calendarId: cachedId }, 'ensureJarvisCalendar: cached ID returned 404 — resetting');
        await clearJarvisCalendarId(userId, dataDir);
        await resetCursor(userId, dataDir);
        _verifiedCalendarIds.delete(cachedId);
        // Fall through to find/create below
      } else {
        // Non-404 API failure — return null (don't clear the cached ID; may be transient)
        log.warn(
          { userId, calendarId: cachedId, err: err instanceof Error ? err.message : String(err) },
          'ensureJarvisCalendar: calendars.get failed — skipping sync cycle',
        );
        return null;
      }
    }
  }

  // Step 3: Find by name
  try {
    const calendars = await calApi.listCalendars();
    const found = calendars.find((c) => c.summary === JARVIS_CALENDAR_NAME);
    if (found) {
      log.info({ userId, calendarId: found.id }, 'ensureJarvisCalendar: found existing calendar by name');
      await writeJarvisCalendarId(userId, dataDir, found.id);
      _verifiedCalendarIds.add(found.id);
      return found.id;
    }
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'ensureJarvisCalendar: listCalendars failed — skipping sync cycle',
    );
    if (auditFn) auditFn({ event: 'jarvis_create_failed', reason: 'listCalendars_api_error', userId });
    return null;
  }

  // Step 4: Create the calendar
  try {
    const created = await calApi.createCalendar(JARVIS_CALENDAR_NAME, JARVIS_CALENDAR_DESCRIPTION);
    log.info({ userId, calendarId: created.id }, 'ensureJarvisCalendar: created new Jarvis Organize calendar');
    await writeJarvisCalendarId(userId, dataDir, created.id);
    _verifiedCalendarIds.add(created.id);
    if (auditFn) auditFn({ event: 'jarvis_created', calendarId: created.id });
    return created.id;
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'ensureJarvisCalendar: createCalendar failed — skipping sync cycle',
    );
    if (auditFn) auditFn({ event: 'jarvis_create_failed', reason: 'createCalendar_api_error', userId });
    return null;
  }
}

/** Test-only: clear the in-process verification cache. */
export function _resetVerifiedCalendarIds(): void {
  _verifiedCalendarIds.clear();
}
