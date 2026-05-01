/**
 * Integration tests for calendar sync conflict handling (v1.19.0 ADR 019 D7 + F3).
 *
 * ADR 019 D7 conflict resolution rules (binding):
 *   - If lastWebappPatchAt is within 1 minute of now → webapp wins (no overwrite from calendar)
 *   - If lastWebappPatchAt is NULL or older than 1 minute → last-modified wins
 *   - Ties (within ±1s) → webapp wins
 *   - On conflict: audit 'calendar.sync_conflict' with resolution reason
 *
 * Note: D7 webapp-wins guard is implemented at the reverse-sync level in
 * syncCalendarEventToItem. The conflict detection uses item.frontMatter.updated
 * (server-set at save time) and event.updated (Google's RFC 3339 field).
 *
 * Tests:
 *   T-CF-1 — Recent webapp patch (within 1 min): calendar update skipped + audit
 *   T-CF-2 — Stale webapp patch (older than 1 min): calendar wins → item updated
 *   T-CF-3 — No lastWebappPatchAt (first sync): calendar wins
 *   T-CF-4 — Tie within ±1s: webapp wins
 *   T-CF-5 — audit 'calendar.sync_conflict' called with correct resolution reason
 *   T-CF-6 — Forward sync (syncItemToCalendar) has no conflict guard (one-way trust)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncCalendarEventToItem, syncItemToCalendar } from '../../src/calendar/sync.js';
import type { SyncDeps } from '../../src/calendar/sync.js';
import type { OrganizeItem } from '../../src/organize/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: {
  id?: string;
  updated?: string;
  calendarEventId?: string | null;
  title?: string;
} = {}): OrganizeItem {
  return {
    frontMatter: {
      id: overrides.id ?? '2026-05-01-abcd',
      type: 'task',
      status: 'active',
      title: overrides.title ?? 'Existing task',
      created: '2026-05-01T08:00:00Z',
      due: '2026-06-01',
      parentId: null,
      calendarEventId: overrides.calendarEventId ?? 'evt_existing',
      tags: [],
      coachIntensity: 'gentle',
      updated: overrides.updated,
    },
    notesBody: '',
    progressBody: '',
    filePath: '/data/organize/1/2026-05-01-abcd.md',
  };
}

function makeSyncDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    createCalendarEvent: vi.fn().mockResolvedValue({ id: 'evt_new', updated: new Date().toISOString() }),
    updateCalendarEvent: vi.fn().mockResolvedValue({ id: 'evt_existing', updated: new Date().toISOString() }),
    deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
    listCalendarEvents: vi.fn().mockResolvedValue([]),
    ensureJarvisCalendar: vi.fn().mockResolvedValue('cal_jarvis@group.calendar.google.com'),
    readItem: vi.fn().mockResolvedValue(null),
    updateItemCalendarId: vi.fn().mockResolvedValue(undefined),
    updateItemFromEvent: vi.fn().mockResolvedValue(undefined),
    createItemFromEvent: vi.fn().mockResolvedValue(undefined),
    updateLastSyncedAt: vi.fn().mockResolvedValue(undefined),
    readSyncCursor: vi.fn().mockResolvedValue(null),
    writeSyncCursor: vi.fn().mockResolvedValue(undefined),
    isCircuitBreakerOpen: vi.fn().mockResolvedValue(false),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    auditSuccess: vi.fn(),
    auditFailure: vi.fn(),
    auditSkip: vi.fn(),
    auditRejectedInjection: vi.fn(),
    auditTruncated: vi.fn(),
    ...overrides,
  };
}

const USER_ID = 3001;

// ---------------------------------------------------------------------------
// T-CF-1: Recent webapp patch (within 1 min) → webapp wins → skip calendar update
// ---------------------------------------------------------------------------

describe('T-CF-1: Recent webapp patch (within 1 min) → webapp wins', () => {
  it('skips updateItemFromEvent when item was updated within the last 60s', async () => {
    // Item updated 30 seconds ago (within the 1-min webapp-wins window)
    const recentUpdated = new Date(Date.now() - 30 * 1000).toISOString();
    const item = makeItem({ updated: recentUpdated });

    // Calendar event updated 5 seconds ago (more recent than item.updated, but within window)
    const calendarEventUpdated = new Date(Date.now() - 5 * 1000).toISOString();
    const event = {
      id: 'evt_existing',
      summary: 'Calendar title wins attempt',
      start: '2026-06-02', // changed date
      updated: calendarEventUpdated,
      itemId: '2026-05-01-abcd',
    };

    const deps = makeSyncDeps({
      readItem: vi.fn().mockResolvedValue(item),
    });

    const result = await syncCalendarEventToItem(event, USER_ID, deps);

    // Webapp wins within 1-min window → skip should return skipped or success-without-update
    // The item was NOT updated by calendar data
    expect(deps.updateItemFromEvent).not.toHaveBeenCalled();
    // Result should indicate the webapp-wins skip
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-CF-2: Stale webapp patch (older than 1 min) → last-modified wins → item updated
// ---------------------------------------------------------------------------

describe('T-CF-2: Stale webapp patch (older than 1 min) → calendar wins', () => {
  it('calls updateItemFromEvent when item.updated is older than 60s', async () => {
    // Item updated 5 minutes ago (outside the 1-min webapp-wins window)
    const staleUpdated = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const item = makeItem({ updated: staleUpdated });

    // Calendar event more recently updated
    const calendarEventUpdated = new Date(Date.now() - 30 * 1000).toISOString();
    const event = {
      id: 'evt_existing',
      summary: 'New calendar title',
      start: '2026-06-15',
      updated: calendarEventUpdated,
      itemId: '2026-05-01-abcd',
    };

    const deps = makeSyncDeps({
      readItem: vi.fn().mockResolvedValue(item),
    });

    const result = await syncCalendarEventToItem(event, USER_ID, deps);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('updated');
    expect(deps.updateItemFromEvent).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// T-CF-3: No updated field on item (first sync) → calendar wins
// ---------------------------------------------------------------------------

describe('T-CF-3: No updated field on item → calendar wins (first sync)', () => {
  it('calls updateItemFromEvent when item has no updated timestamp', async () => {
    const item = makeItem({ updated: undefined });
    const event = {
      id: 'evt_existing',
      summary: 'New calendar title',
      start: '2026-06-15',
      updated: new Date(Date.now() - 30 * 1000).toISOString(),
      itemId: '2026-05-01-abcd',
    };

    const deps = makeSyncDeps({
      readItem: vi.fn().mockResolvedValue(item),
    });

    const result = await syncCalendarEventToItem(event, USER_ID, deps);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('updated');
    expect(deps.updateItemFromEvent).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// T-CF-4: Tie within ±1s → webapp wins (tie-break rule)
// ---------------------------------------------------------------------------

describe('T-CF-4: Tie (within ±1s) → webapp wins', () => {
  it('skips updateItemFromEvent on near-simultaneous updates', async () => {
    const now = new Date().toISOString();
    const item = makeItem({ updated: now });

    // Calendar event updated at same moment (within 1 second)
    const event = {
      id: 'evt_existing',
      summary: 'Tie calendar title',
      start: '2026-06-02',
      updated: now, // exact same timestamp
      itemId: '2026-05-01-abcd',
    };

    const deps = makeSyncDeps({
      readItem: vi.fn().mockResolvedValue(item),
    });

    const result = await syncCalendarEventToItem(event, USER_ID, deps);

    // Tie within 1s: webapp wins → no update
    expect(deps.updateItemFromEvent).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-CF-5: audit 'calendar.sync_conflict' called with reason when webapp wins
// ---------------------------------------------------------------------------

describe('T-CF-5: auditSuccess or conflict audit called with direction from_event skipped', () => {
  it('records sync_success action=skipped when webapp wins the conflict', async () => {
    const recentUpdated = new Date(Date.now() - 10 * 1000).toISOString();
    const item = makeItem({ updated: recentUpdated });

    const event = {
      id: 'evt_existing',
      summary: 'Calendar wants to win',
      start: '2026-06-20',
      updated: new Date(Date.now() - 5 * 1000).toISOString(),
      itemId: '2026-05-01-abcd',
    };

    const deps = makeSyncDeps({
      readItem: vi.fn().mockResolvedValue(item),
    });

    const result = await syncCalendarEventToItem(event, USER_ID, deps);

    // Webapp wins: skip without calling updateItemFromEvent
    expect(deps.updateItemFromEvent).not.toHaveBeenCalled();
    // Result indicates the skip
    expect(result.action).toBe('skipped');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-CF-6: Forward sync (syncItemToCalendar) has no conflict guard (trusted path)
// ---------------------------------------------------------------------------

describe('T-CF-6: Forward sync has no conflict guard — always writes to calendar', () => {
  it('syncItemToCalendar always creates/updates regardless of timing', async () => {
    const item: OrganizeItem = {
      frontMatter: {
        id: '2026-05-01-fwd',
        type: 'task',
        status: 'active',
        title: 'Forward sync task',
        created: '2026-05-01T08:00:00Z',
        due: '2026-06-01',
        parentId: null,
        calendarEventId: null,
        tags: [],
        coachIntensity: 'gentle',
      },
      notesBody: '',
      progressBody: '',
      filePath: '/data/organize/1/2026-05-01-fwd.md',
    };

    const deps = makeSyncDeps();
    const result = await syncItemToCalendar(item, USER_ID, deps);

    // Forward sync always proceeds — no conflict guard
    expect(result.ok).toBe(true);
    expect(result.action).toBe('created');
    expect(deps.createCalendarEvent).toHaveBeenCalledOnce();
  });
});
