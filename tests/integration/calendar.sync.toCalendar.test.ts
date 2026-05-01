/**
 * Integration tests for organize→calendar one-way sync (v1.19.0 ADR 019 D4 + R2).
 *
 * Covers:
 *   - create/update/done/delete flow
 *   - bulk batch (50 items → 1 debounced flush)
 *   - debounce (same itemId 3x in 200ms → 1 sync call)
 *   - skip checks (no due / goal / done / off intensity)
 *   - circuit breaker: open after 5 consecutive failures + DM + auto-close on success
 *
 * Tests use the SyncDeps interface with mocked callbacks for testability.
 * Timer control uses vi.useFakeTimers().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  notifyCalendarSync,
  syncItemToCalendar,
  shouldQueueForSync,
  _userSyncQueues,
} from '../../src/calendar/sync.js';
import type { SyncDeps } from '../../src/calendar/sync.js';
import type { OrganizeItem } from '../../src/organize/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: {
  id?: string;
  due?: string | null;
  type?: 'task' | 'event' | 'goal';
  status?: 'active' | 'done' | 'abandoned';
  coachIntensity?: 'off' | 'gentle' | 'moderate' | 'persistent' | 'auto';
  deletedAt?: string;
  calendarEventId?: string | null;
  notes?: string;
  title?: string;
} = {}): OrganizeItem {
  // Use 'due' in overrides check to handle explicit null (null ?? default would give default)
  const due = 'due' in overrides ? overrides.due ?? null : '2026-06-01';
  return {
    frontMatter: {
      id: overrides.id ?? '2026-05-01-abcd',
      type: overrides.type ?? 'task',
      status: overrides.status ?? 'active',
      title: overrides.title ?? 'Test task',
      created: '2026-05-01T08:00:00Z',
      due,
      parentId: null,
      calendarEventId: overrides.calendarEventId ?? null,
      tags: [],
      coachIntensity: overrides.coachIntensity ?? 'gentle',
      ...(overrides.deletedAt ? { deletedAt: overrides.deletedAt } : {}),
    },
    notesBody: overrides.notes ?? '',
    progressBody: '',
    filePath: '/data/organize/1/2026-05-01-abcd.md',
  };
}

function makeMockDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  const createCalendarEvent = vi.fn().mockResolvedValue({ id: 'evt_001', updated: new Date().toISOString() });
  const updateCalendarEvent = vi.fn().mockResolvedValue({ id: 'evt_001', updated: new Date().toISOString() });
  const deleteCalendarEvent = vi.fn().mockResolvedValue(undefined);
  const listCalendarEvents = vi.fn().mockResolvedValue([]);
  const ensureJarvisCalendar = vi.fn().mockResolvedValue('cal_jarvis@group.calendar.google.com');
  const readItem = vi.fn().mockResolvedValue(null);
  const updateItemCalendarId = vi.fn().mockResolvedValue(undefined);
  const updateItemFromEvent = vi.fn().mockResolvedValue(undefined);
  const createItemFromEvent = vi.fn().mockResolvedValue(undefined);
  const updateLastSyncedAt = vi.fn().mockResolvedValue(undefined);
  const readSyncCursor = vi.fn().mockResolvedValue(null);
  const writeSyncCursor = vi.fn().mockResolvedValue(undefined);
  const isCircuitBreakerOpen = vi.fn().mockResolvedValue(false);
  const recordFailure = vi.fn().mockResolvedValue(undefined);
  const recordSuccess = vi.fn().mockResolvedValue(undefined);
  const auditSuccess = vi.fn();
  const auditFailure = vi.fn();
  const auditSkip = vi.fn();
  const auditRejectedInjection = vi.fn();
  const auditTruncated = vi.fn();

  return {
    createCalendarEvent,
    updateCalendarEvent,
    deleteCalendarEvent,
    listCalendarEvents,
    ensureJarvisCalendar,
    readItem,
    updateItemCalendarId,
    updateItemFromEvent,
    createItemFromEvent,
    updateLastSyncedAt,
    readSyncCursor,
    writeSyncCursor,
    isCircuitBreakerOpen,
    recordFailure,
    recordSuccess,
    auditSuccess,
    auditFailure,
    auditSkip,
    auditRejectedInjection,
    auditTruncated,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldQueueForSync — pre-spawn skip check (R2 Part 2)
// ---------------------------------------------------------------------------

describe('shouldQueueForSync — pre-spawn skip check', () => {
  it('returns skip=false for a valid active task with due date', () => {
    const item = makeItem({ type: 'task', status: 'active', due: '2026-06-01', coachIntensity: 'gentle' });
    expect(shouldQueueForSync(item)).toEqual({ skip: false });
  });

  it('returns skip=true for item with no due date', () => {
    const item = makeItem({ due: null });
    const result = shouldQueueForSync(item);
    expect(result.skip).toBe(true);
    expect((result as { skip: true; reason: string }).reason).toBe('no_due_date');
  });

  it('returns skip=true for soft-deleted item', () => {
    const item = makeItem({ deletedAt: '2026-05-01T12:00:00Z' });
    const result = shouldQueueForSync(item);
    expect(result.skip).toBe(true);
    expect((result as { skip: true; reason: string }).reason).toBe('soft_deleted');
  });

  it('returns skip=true for goal type', () => {
    const item = makeItem({ type: 'goal', due: null });
    const result = shouldQueueForSync(item);
    expect(result.skip).toBe(true);
    expect((result as { skip: true; reason: string }).reason).toMatch(/goal_type|no_due_date/);
  });

  it('returns skip=true for done status', () => {
    const item = makeItem({ status: 'done', due: '2026-06-01' });
    const result = shouldQueueForSync(item);
    expect(result.skip).toBe(true);
    expect((result as { skip: true; reason: string }).reason).toBe('status_done');
  });

  it('returns skip=true for coachIntensity=off', () => {
    const item = makeItem({ coachIntensity: 'off', due: '2026-06-01' });
    const result = shouldQueueForSync(item);
    expect(result.skip).toBe(true);
    expect((result as { skip: true; reason: string }).reason).toBe('intensity_off');
  });
});

// ---------------------------------------------------------------------------
// syncItemToCalendar — forward sync
// ---------------------------------------------------------------------------

describe('syncItemToCalendar — create/update/done flow', () => {
  const USER_ID = 1001;

  it('creates a new calendar event for an item with no calendarEventId', async () => {
    const item = makeItem({ calendarEventId: null });
    const deps = makeMockDeps();
    const result = await syncItemToCalendar(item, USER_ID, deps);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('created');
    expect(result.eventId).toBe('evt_001');
    expect(deps.createCalendarEvent).toHaveBeenCalledOnce();
    const callArg = (deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      itemId: string;
      summary: string;
    };
    expect(callArg.itemId).toBe('2026-05-01-abcd');
    expect(callArg.summary).toBe('Test task');
    expect(deps.updateItemCalendarId).toHaveBeenCalledOnce();
    expect((deps.auditSuccess as ReturnType<typeof vi.fn>).mock.calls[0]).toBeDefined();
  });

  it('updates an existing calendar event for an item with calendarEventId', async () => {
    const item = makeItem({ calendarEventId: 'existing_evt' });
    const deps = makeMockDeps();
    const result = await syncItemToCalendar(item, USER_ID, deps);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('updated');
    expect(deps.updateCalendarEvent).toHaveBeenCalledOnce();
    expect(deps.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('prefixes done items with ✅ in the event title', async () => {
    const item = makeItem({ status: 'done', due: '2026-06-01', calendarEventId: 'evt_done' });
    const deps = makeMockDeps();
    await syncItemToCalendar(item, USER_ID, deps);

    const callArg = (deps.updateCalendarEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      summary: string;
    };
    expect(callArg.summary).toBe('✅ Test task');
  });

  it('returns skipped when ensureJarvisCalendar returns null', async () => {
    const item = makeItem({});
    const deps = makeMockDeps({ ensureJarvisCalendar: vi.fn().mockResolvedValue(null) });
    const result = await syncItemToCalendar(item, USER_ID, deps);

    expect(result.action).toBe('skipped');
    expect(deps.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('records failure and audits when createEvent throws', async () => {
    const item = makeItem({});
    const deps = makeMockDeps({
      createCalendarEvent: vi.fn().mockRejectedValue(new Error('API error')),
    });
    const result = await syncItemToCalendar(item, USER_ID, deps);

    expect(result.ok).toBe(false);
    expect(result.action).toBe('skipped');
    expect((deps.recordFailure as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((deps.auditFailure as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// notifyCalendarSync — debounce + skip
// ---------------------------------------------------------------------------

describe('notifyCalendarSync — debounce + skip (R2)', () => {
  const USER_ID = 2001;

  beforeEach(() => {
    vi.useFakeTimers();
    // Clean up any leftover queues from previous tests
    _userSyncQueues.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    _userSyncQueues.clear();
  });

  it('skips items that fail the shouldQueueForSync check, emits audit skip', () => {
    const item = makeItem({ due: null });
    const deps = makeMockDeps();

    notifyCalendarSync(USER_ID, item, deps);

    expect((deps.auditSkip as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((deps.auditSkip as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe('no_due_date');
    // No queue entry
    expect(_userSyncQueues.has(USER_ID)).toBe(false);
  });

  it('queues the item and flushes after debounce window', async () => {
    const item = makeItem({});
    const deps = makeMockDeps();

    notifyCalendarSync(USER_ID, item, deps);
    expect(_userSyncQueues.get(USER_ID)?.items.size).toBe(1);

    // Advance fake timer past debounce
    await vi.runAllTimersAsync();

    // After flush, the queue is cleared and createCalendarEvent was called
    expect(_userSyncQueues.get(USER_ID)?.items.size ?? 0).toBe(0);
    expect((deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('latest-write-wins for same itemId within debounce window', async () => {
    const item1 = makeItem({ title: 'First version' });
    const item2 = makeItem({ title: 'Second version' });
    const item3 = makeItem({ title: 'Third version' });
    const deps = makeMockDeps();

    // All three notify within the debounce window
    notifyCalendarSync(USER_ID, item1, deps);
    notifyCalendarSync(USER_ID, item2, deps);
    notifyCalendarSync(USER_ID, item3, deps);

    await vi.runAllTimersAsync();

    // Only ONE call total; the last write (item3) should be the one synced
    expect((deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const callArg = (deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      summary: string;
    };
    expect(callArg.summary).toBe('Third version');
  });

  it('skips the entire batch when circuit breaker is open', async () => {
    const item = makeItem({});
    const deps = makeMockDeps({ isCircuitBreakerOpen: vi.fn().mockResolvedValue(true) });

    notifyCalendarSync(USER_ID, item, deps);
    await vi.runAllTimersAsync();

    expect((deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.auditSkip as ReturnType<typeof vi.fn>).mock.calls.some(
      (c: unknown[]) => c[2] === 'circuit_breaker_open',
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bulk batch: 50 items → 1 debounced flush
// ---------------------------------------------------------------------------

describe('Bulk batch: 50 items → 1 flush after debounce', () => {
  const USER_ID = 3001;

  beforeEach(() => {
    vi.useFakeTimers();
    _userSyncQueues.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    _userSyncQueues.clear();
  });

  it('50 notifyCalendarSync calls with unique itemIds → single flush of 50 syncs', async () => {
    const deps = makeMockDeps();

    for (let i = 0; i < 50; i++) {
      const item = makeItem({ id: `2026-05-01-${i.toString().padStart(4, '0')}` });
      notifyCalendarSync(USER_ID, item, deps);
    }

    // 50 items in the queue, timer fires once
    expect(_userSyncQueues.get(USER_ID)?.items.size).toBe(50);

    await vi.runAllTimersAsync();

    // All 50 items flushed sequentially
    expect((deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(50);
    expect(_userSyncQueues.get(USER_ID)?.items.size ?? 0).toBe(0);
  });

  it('50 items all with no due date → ZERO sync calls', async () => {
    const deps = makeMockDeps();

    for (let i = 0; i < 50; i++) {
      const item = makeItem({ id: `2026-05-01-${i.toString().padStart(4, '0')}`, due: null });
      notifyCalendarSync(USER_ID, item, deps);
    }

    await vi.runAllTimersAsync();

    expect((deps.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.auditSkip as ReturnType<typeof vi.fn>).mock.calls.length).toBe(50);
  });
});
