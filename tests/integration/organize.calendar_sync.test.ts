/**
 * Integration tests for organize tools × CalendarApi (ARCHITECTURE.md §16.11.7).
 *
 * Uses mocked CalendarApi. Tests verify GCal is called with the correct
 * arguments and that local file state matches expectations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';

// Mock CalendarApi BEFORE importing tools.
// Must use function constructor syntax so `new CalendarApi(auth)` works.
vi.mock('../../src/google/calendar.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/google/calendar.js')>();
  return {
    ...original,
    CalendarApi: vi.fn().mockImplementation(function (this: unknown) {
      (this as Record<string, unknown>).createEvent = (...args: unknown[]) => mockCreateEvent(...args);
      (this as Record<string, unknown>).updateEvent = (...args: unknown[]) => mockUpdateEvent(...args);
      (this as Record<string, unknown>).deleteEvent = (...args: unknown[]) => mockDeleteEvent(...args);
      (this as Record<string, unknown>).listEvents = vi.fn();
    }),
    isCalendarEnabledForChat: vi.fn(() => true),
    setCalendarEnabledForChat: vi.fn(),
  };
});

vi.mock('../../src/google/oauth.js', () => ({
  loadGoogleAuth: vi.fn().mockResolvedValue({}),
}));

const mockCreateEvent = vi.fn();
const mockUpdateEvent = vi.fn();
const mockDeleteEvent = vi.fn();

import * as calendarModule from '../../src/google/calendar.js';

import { buildOrganizeCreateTool } from '../../src/tools/organize_create.js';
import { buildOrganizeUpdateTool } from '../../src/tools/organize_update.js';
import { buildOrganizeDeleteTool } from '../../src/tools/organize_delete.js';

import { createItem, readItem } from '../../src/organize/storage.js';
import type { ToolContext, ToolDeps } from '../../src/tools/types.js';
import type { InsertAuditParams } from '../../src/memory/auditLog.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });
const USER_ID = 444888;
const CHAT_ID = 9999;

let dataDir: string;
let auditRows: InsertAuditParams[];
let ctx: ToolContext;
let deps: ToolDeps;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-int-test-'));
  auditRows = [];

  const cfg = makeTestConfig();
  cfg.memory.dbPath = path.join(dataDir, 'test.db');

  deps = {
    config: cfg,
    logger: silentLogger,
    safety: {} as ToolDeps['safety'],
    memory: {} as ToolDeps['memory'],
  };

  ctx = {
    sessionId: 1,
    chatId: CHAT_ID,
    userId: USER_ID,
    userName: 'TestUser',
    logger: silentLogger,
    config: cfg,
    memory: {
      auditLog: {
        insert: (params: InsertAuditParams) => { auditRows.push(params); },
      },
    } as unknown as ToolContext['memory'],
    safety: { scrub: (s: string) => s, scrubRecord: (r: object) => r } as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
  };

  vi.clearAllMocks();
  vi.mocked(calendarModule.isCalendarEnabledForChat).mockReturnValue(true);

  mockCreateEvent.mockResolvedValue({
    id: 'gcal-int-event-001',
    summary: 'Test Event',
    start: '2026-05-01T10:00:00Z',
    end: '2026-05-01T11:00:00Z',
    allDay: false,
    htmlLink: 'https://calendar.google.com/event/001',
  });
  mockUpdateEvent.mockResolvedValue({
    id: 'gcal-int-event-001',
    summary: 'Updated',
    start: '2026-05-01T10:00:00Z',
    end: '2026-05-01T11:00:00Z',
    allDay: false,
  });
  mockDeleteEvent.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('organize × calendar integration', () => {
  it('create event → GCal insert called once; created file has calendarEventId populated', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({
      type: 'event',
      title: 'Team Meeting',
      due: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
      timeZone: 'America/Los_Angeles',
    }, ctx);

    expect(result.ok).toBe(true);
    expect(mockCreateEvent).toHaveBeenCalledOnce();

    // Verify the created file has calendarEventId
    const itemId = result.data?.id as string;
    expect(itemId).toBeDefined();
    const item = await readItem(USER_ID, dataDir, itemId);
    expect(item).not.toBeNull();
    expect(item?.frontMatter.calendarEventId).toBe('gcal-int-event-001');
  });

  it('create event — CalendarApi.createEvent called with correct args', async () => {
    const tool = buildOrganizeCreateTool(deps);
    await tool.execute({
      type: 'event',
      title: 'Board Review',
      due: '2026-06-15T09:00:00Z',
      endTime: '2026-06-15T10:00:00Z',
      location: 'Conference Room A',
      attendees: ['alice@example.com'],
      timeZone: 'America/New_York',
    }, ctx);

    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({
      summary: 'Board Review',
      startTime: '2026-06-15T09:00:00Z',
      endTime: '2026-06-15T10:00:00Z',
      location: 'Conference Room A',
      attendees: ['alice@example.com'],
      timeZone: 'America/New_York',
    }));
  });

  it('update event with title change only → GCal patch called with summary field; no other synced fields set', async () => {
    // Create event item with known calendarEventId
    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Old Title',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-int-event-001',
    });

    const tool = buildOrganizeUpdateTool(deps);
    await tool.execute({ id: eventItem.frontMatter.id, title: 'New Title' }, ctx);

    expect(mockUpdateEvent).toHaveBeenCalledOnce();
    const callArgs = mockUpdateEvent.mock.calls[0][0];

    // summary should be set
    expect(callArgs.summary).toBe('New Title');
    // start/end/location/attendees should be undefined (not supplied)
    expect(callArgs.startTime).toBeUndefined();
    expect(callArgs.endTime).toBeUndefined();
    expect(callArgs.location).toBeUndefined();
    expect(callArgs.attendees).toBeUndefined();
  });

  it('update event with no sync-relevant change (only notes) → GCal patch NOT called', async () => {
    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Team Meeting',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-int-event-001',
    });

    const tool = buildOrganizeUpdateTool(deps);
    await tool.execute({ id: eventItem.frontMatter.id, notes: 'Agenda: Q2 review' }, ctx);

    // notes is not in GCAL_SYNC_FIELDS — patch should NOT be called
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('delete event → GCal delete called; local soft-delete proceeds (item gone from active listing)', async () => {
    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Doctor Appointment',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-int-event-001',
    });
    const eventId = eventItem.frontMatter.id;

    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventId }, ctx);

    expect(result.ok).toBe(true);
    expect(mockDeleteEvent).toHaveBeenCalledOnce();

    // Item should no longer be readable
    const item = await readItem(USER_ID, dataDir, eventId);
    expect(item).toBeNull();
  });

  it('delete event — GCal 404 → local soft-delete proceeds', async () => {
    // Use a GaxiosError-shaped error with numeric status code (matches Fix #5 numeric-first detection).
    mockDeleteEvent.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { response: { status: 404 } }));

    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Doctor Appointment',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-int-event-001',
    });
    const eventId = eventItem.frontMatter.id;

    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventId }, ctx);

    expect(result.ok).toBe(true);
    // Item should be gone
    const item = await readItem(USER_ID, dataDir, eventId);
    expect(item).toBeNull();
  });

  it('delete event — GCal 500 → local soft-delete does NOT run; item still readable', async () => {
    mockDeleteEvent.mockRejectedValueOnce(new Error('Internal Server Error 500'));

    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Doctor Appointment',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-int-event-001',
    });
    const eventId = eventItem.frontMatter.id;

    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventId }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CALENDAR_DELETE_FAILED');

    // Item should still be readable (not soft-deleted)
    const item = await readItem(USER_ID, dataDir, eventId);
    expect(item).not.toBeNull();
  });
});
