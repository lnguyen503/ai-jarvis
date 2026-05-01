/**
 * syncCursor.ts — Calendar sync cursor read/write/reset (v1.19.0 ADR 019 D5).
 *
 * Stores the Google Calendar sync cursor in keyed memory under
 * `calendar.jarvis_sync_cursor`. The cursor is Google's nextSyncToken —
 * an opaque string that tells Google's API to return only events changed
 * since the last poll.
 *
 * Corruption recovery (ADR 019 D5, binding):
 *   If the cursor entry is missing OR JSON.parse throws OR lastEventEtag is
 *   not a string: log warn + return null (caller falls back to 24h lookback).
 *
 * Dependency edges (binding):
 *   syncCursor.ts → memory/userMemoryEntries (sole-writer invariant)
 *   NO import from src/organize/**, src/calendar/sync.ts, or agent layer.
 */

import { getEntry, createEntry, updateEntry, deleteEntry } from '../memory/userMemoryEntries.js';
import { child } from '../logger/index.js';
import type { SyncCursorBody } from './syncTypes.js';

const log = child({ component: 'calendar.syncCursor' });

/** Keyed memory key for the sync cursor. */
const CURSOR_KEY = 'calendar.jarvis_sync_cursor';

/** Keyed memory key for the Jarvis calendar ID (D8). */
const CALENDAR_ID_KEY = 'calendar.jarvis_calendar_id';

// ---------------------------------------------------------------------------
// Sync cursor CRUD
// ---------------------------------------------------------------------------

/**
 * Read the sync cursor from keyed memory.
 * Returns null on missing, JSON parse failure, or invalid shape.
 * Caller must handle null by falling back to the 24h lookback.
 */
export async function readCursor(
  userId: number,
  dataDir: string,
): Promise<SyncCursorBody | null> {
  const entry = await getEntry(userId, dataDir, CURSOR_KEY);
  if (!entry) return null;

  try {
    const parsed: unknown = JSON.parse(entry.body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'lastPolledAt' in parsed &&
      'lastEventEtag' in parsed &&
      typeof (parsed as SyncCursorBody).lastPolledAt === 'string' &&
      typeof (parsed as SyncCursorBody).lastEventEtag === 'string'
    ) {
      return parsed as SyncCursorBody;
    }
    log.warn(
      { userId, body: entry.body.slice(0, 80) },
      'syncCursor: cursor entry has invalid shape — returning null (caller recovers)',
    );
    return null;
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'syncCursor: cursor JSON.parse failed — returning null (caller recovers)',
    );
    return null;
  }
}

/**
 * Write (create or update) the sync cursor in keyed memory.
 */
export async function writeCursor(
  userId: number,
  dataDir: string,
  body: SyncCursorBody,
): Promise<void> {
  const serialized = JSON.stringify(body);
  const existing = await getEntry(userId, dataDir, CURSOR_KEY);
  if (existing) {
    await updateEntry(userId, dataDir, CURSOR_KEY, serialized);
  } else {
    await createEntry(userId, dataDir, CURSOR_KEY, serialized);
  }
}

/**
 * Reset the sync cursor (delete the entry).
 * After reset, the next poll falls back to the 24h lookback.
 */
export async function resetCursor(userId: number, dataDir: string): Promise<void> {
  const existing = await getEntry(userId, dataDir, CURSOR_KEY);
  if (existing) {
    await deleteEntry(userId, dataDir, CURSOR_KEY);
    log.info({ userId }, 'syncCursor: cursor reset');
  }
}

// ---------------------------------------------------------------------------
// Jarvis calendar ID CRUD (D8 companion entry)
// ---------------------------------------------------------------------------

/**
 * Read the stored Jarvis calendar ID from keyed memory.
 * Returns null if not set yet.
 */
export async function readJarvisCalendarId(
  userId: number,
  dataDir: string,
): Promise<string | null> {
  const entry = await getEntry(userId, dataDir, CALENDAR_ID_KEY);
  return entry ? entry.body : null;
}

/**
 * Write the Jarvis calendar ID to keyed memory.
 */
export async function writeJarvisCalendarId(
  userId: number,
  dataDir: string,
  calendarId: string,
): Promise<void> {
  const existing = await getEntry(userId, dataDir, CALENDAR_ID_KEY);
  if (existing) {
    await updateEntry(userId, dataDir, CALENDAR_ID_KEY, calendarId);
  } else {
    await createEntry(userId, dataDir, CALENDAR_ID_KEY, calendarId);
  }
}

/**
 * Clear the stored Jarvis calendar ID from keyed memory.
 * Called when the calendar is detected as deleted (ensureJarvisCalendar 404 recovery).
 */
export async function clearJarvisCalendarId(
  userId: number,
  dataDir: string,
): Promise<void> {
  const existing = await getEntry(userId, dataDir, CALENDAR_ID_KEY);
  if (existing) {
    await deleteEntry(userId, dataDir, CALENDAR_ID_KEY);
    log.info({ userId }, 'syncCursor: jarvis_calendar_id cleared');
  }
}
