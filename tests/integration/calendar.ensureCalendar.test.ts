/**
 * Integration tests for ensureJarvisCalendar (v1.19.0 ADR 019 D8 — commit 7).
 *
 * Tests per ADR D8:
 *   T-D8-1 — First call: listCalendars returns 0 matches → createCalendar called → ID stored
 *   T-D8-2 — Second call (same process): verification cache hit → listCalendars NOT called
 *   T-D8-3 — User manually deletes calendar: 404 → cursor + ID reset → find-or-create re-runs
 *   T-D8-4 — User has pre-existing "Jarvis Organize" calendar: find returns it → no duplicate
 *   T-D8-5 — listCalendars API error: audit emitted → null returned → sync skipped
 *   T-D8-6 — createCalendar API error: audit emitted → null returned → sync skipped
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureJarvisCalendar, _resetVerifiedCalendarIds } from '../../src/calendar/ensureCalendar.js';
import { readJarvisCalendarId, writeJarvisCalendarId } from '../../src/calendar/syncCursor.js';
import { CalendarApi } from '../../src/google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

const fakeAuth = {} as OAuth2Client;

// ---------------------------------------------------------------------------
// Mock CalendarApi internals
// ---------------------------------------------------------------------------

interface MockApiInternals {
  calendars: {
    get: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  calendarList: {
    list: ReturnType<typeof vi.fn>;
  };
}

function buildMockedCalendarApi(): { api: CalendarApi; mocks: MockApiInternals } {
  const api = new CalendarApi(fakeAuth);
  const mocks: MockApiInternals = {
    calendars: {
      get: vi.fn(),
      insert: vi.fn(),
    },
    calendarList: {
      list: vi.fn(),
    },
  };
  (api as unknown as { _api: MockApiInternals })._api = mocks;
  return { api, mocks };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const USER_ID = 99901;
let dataDir: string;
const auditCalls: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-ensure-cal-'));
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });
  auditCalls.length = 0;
  _resetVerifiedCalendarIds();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  _resetVerifiedCalendarIds();
});

function auditFn(detail: Record<string, unknown>): void {
  auditCalls.push(detail);
}

// ---------------------------------------------------------------------------
// T-D8-1: First call — no existing calendar → create
// ---------------------------------------------------------------------------

describe('T-D8-1: First call, no existing calendar', () => {
  it('calls listCalendars and createCalendar, stores ID in memory', async () => {
    const { api, mocks } = buildMockedCalendarApi();

    mocks.calendarList.list.mockResolvedValue({
      data: { items: [], nextPageToken: undefined },
    });
    mocks.calendars.insert.mockResolvedValue({
      data: { id: 'new_cal_abc@group.calendar.google.com', summary: 'Jarvis Organize' },
    });

    const result = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);

    expect(result).toBe('new_cal_abc@group.calendar.google.com');
    expect(mocks.calendarList.list).toHaveBeenCalledOnce();
    expect(mocks.calendars.insert).toHaveBeenCalledOnce();

    // ID must be stored in keyed memory
    const stored = await readJarvisCalendarId(USER_ID, dataDir);
    expect(stored).toBe('new_cal_abc@group.calendar.google.com');

    // Audit row for jarvis_created
    expect(auditCalls.some((c) => c['event'] === 'jarvis_created')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-D8-2: Second call — cached ID in memory → verification cache hit
// ---------------------------------------------------------------------------

describe('T-D8-2: Second call, cached ID in memory (verification cache)', () => {
  it('returns cached ID without calling listCalendars or createCalendar', async () => {
    const { api, mocks } = buildMockedCalendarApi();

    // Pre-seed the memory with the calendar ID
    await writeJarvisCalendarId(USER_ID, dataDir, 'cached_cal_xyz@group.calendar.google.com');

    // First call: verification via calendars.get
    mocks.calendars.get.mockResolvedValue({ data: { id: 'cached_cal_xyz@group.calendar.google.com' } });
    const first = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);
    expect(first).toBe('cached_cal_xyz@group.calendar.google.com');
    expect(mocks.calendars.get).toHaveBeenCalledOnce();

    // Second call: verification cache hit — no additional API calls
    mocks.calendars.get.mockClear();
    mocks.calendarList.list.mockClear();
    const second = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);
    expect(second).toBe('cached_cal_xyz@group.calendar.google.com');
    expect(mocks.calendars.get).not.toHaveBeenCalled();
    expect(mocks.calendarList.list).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-D8-3: User deletes the Jarvis calendar → 404 → find-or-create re-runs
// ---------------------------------------------------------------------------

describe('T-D8-3: Cached ID returns 404 — reset + find-or-create', () => {
  it('clears the stale ID, then creates a new calendar', async () => {
    const { api, mocks } = buildMockedCalendarApi();

    // Pre-seed stale calendar ID
    await writeJarvisCalendarId(USER_ID, dataDir, 'stale_cal@group.calendar.google.com');

    // calendars.get returns 404 (user deleted it)
    const notFoundError = Object.assign(new Error('Not Found'), { code: 404 });
    mocks.calendars.get.mockRejectedValue(notFoundError);

    // listCalendars returns empty (calendar is gone)
    mocks.calendarList.list.mockResolvedValue({
      data: { items: [], nextPageToken: undefined },
    });

    // createCalendar creates a new one
    mocks.calendars.insert.mockResolvedValue({
      data: { id: 'fresh_cal_999@group.calendar.google.com', summary: 'Jarvis Organize' },
    });

    const result = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);

    expect(result).toBe('fresh_cal_999@group.calendar.google.com');
    expect(mocks.calendars.get).toHaveBeenCalledOnce();
    expect(mocks.calendarList.list).toHaveBeenCalledOnce();
    expect(mocks.calendars.insert).toHaveBeenCalledOnce();

    // New ID stored in memory
    const stored = await readJarvisCalendarId(USER_ID, dataDir);
    expect(stored).toBe('fresh_cal_999@group.calendar.google.com');
  });
});

// ---------------------------------------------------------------------------
// T-D8-4: User already has "Jarvis Organize" calendar (prior install)
// ---------------------------------------------------------------------------

describe('T-D8-4: Pre-existing "Jarvis Organize" calendar found by name', () => {
  it('uses the existing calendar without creating a duplicate', async () => {
    const { api, mocks } = buildMockedCalendarApi();

    // No cached ID in memory
    mocks.calendarList.list.mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'My Calendar', primary: true },
          { id: 'existing_jarvis@group.calendar.google.com', summary: 'Jarvis Organize' },
        ],
        nextPageToken: undefined,
      },
    });

    const result = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);

    expect(result).toBe('existing_jarvis@group.calendar.google.com');
    expect(mocks.calendars.insert).not.toHaveBeenCalled();  // no duplicate created

    const stored = await readJarvisCalendarId(USER_ID, dataDir);
    expect(stored).toBe('existing_jarvis@group.calendar.google.com');

    // No jarvis_created audit row (found, not created)
    expect(auditCalls.some((c) => c['event'] === 'jarvis_created')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-D8-5: listCalendars API error → null returned → sync skipped
// ---------------------------------------------------------------------------

describe('T-D8-5: listCalendars API failure', () => {
  it('returns null and emits audit row', async () => {
    const { api, mocks } = buildMockedCalendarApi();

    mocks.calendarList.list.mockRejectedValue(new Error('Network error'));

    const result = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);

    expect(result).toBeNull();
    expect(auditCalls.some((c) => c['event'] === 'jarvis_create_failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-D8-6: createCalendar API error → null returned → sync skipped
// ---------------------------------------------------------------------------

describe('T-D8-6: createCalendar API failure', () => {
  it('returns null and emits audit row', async () => {
    const { api, mocks } = buildMockedCalendarApi();

    mocks.calendarList.list.mockResolvedValue({
      data: { items: [], nextPageToken: undefined },
    });
    mocks.calendars.insert.mockRejectedValue(new Error('Quota exceeded'));

    const result = await ensureJarvisCalendar(USER_ID, dataDir, api, auditFn);

    expect(result).toBeNull();
    expect(auditCalls.some((c) => c['event'] === 'jarvis_create_failed')).toBe(true);
  });
});
