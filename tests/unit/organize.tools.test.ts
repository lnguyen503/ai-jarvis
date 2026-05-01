/**
 * Unit tests for organize_* tools (ARCHITECTURE.md §16.11.4).
 *
 * Uses a mock ToolContext with in-memory auditLog spy, tmp dataDir for real
 * file I/O, and a stubbed CalendarApi injected via vi.mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';

// Mock CalendarApi BEFORE importing tools that use it.
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

// These must be declared BEFORE any describe blocks so the vi.mock factory can reference them
const mockCreateEvent = vi.fn();
const mockUpdateEvent = vi.fn();
const mockDeleteEvent = vi.fn();

// Partial mock for storage — only override specific functions in tests that need it.
// We use vi.mock with passthrough by default; individual tests call vi.mocked().mockResolvedValueOnce().
vi.mock('../../src/organize/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/organize/storage.js')>();
  return {
    ...actual,
    // Pass through all real implementations; tests override per-test as needed.
  };
});

import * as calendarModule from '../../src/google/calendar.js';
import * as oauthModule from '../../src/google/oauth.js';
import * as storageModule from '../../src/organize/storage.js';

import { buildOrganizeCreateTool } from '../../src/tools/organize_create.js';
import { buildOrganizeUpdateTool } from '../../src/tools/organize_update.js';
import { organizeCompleteTool } from '../../src/tools/organize_complete.js';
import { organizeListTool } from '../../src/tools/organize_list.js';
import { organizeLogProgressTool } from '../../src/tools/organize_log_progress.js';
import { buildOrganizeDeleteTool } from '../../src/tools/organize_delete.js';

import { createItem } from '../../src/organize/storage.js';
import type { ToolContext, ToolDeps } from '../../src/tools/types.js';
import type { InsertAuditParams } from '../../src/memory/auditLog.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });
const USER_ID = 555999;
const CHAT_ID = 1234;
const SESSION_ID = 1;

let dataDir: string;
let auditRows: InsertAuditParams[];
let ctx: ToolContext;
let deps: ToolDeps;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-tools-test-'));
  auditRows = [];

  const cfg = makeTestConfig();
  // Point dataDir so tools compute the right path
  cfg.memory.dbPath = path.join(dataDir, 'test.db');

  deps = {
    config: cfg,
    logger: silentLogger,
    safety: {} as ToolDeps['safety'],
    memory: {} as ToolDeps['memory'],
  };

  ctx = {
    sessionId: SESSION_ID,
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

  // Reset all mocks to defaults
  vi.clearAllMocks();

  // Default: calendar enabled
  vi.mocked(calendarModule.isCalendarEnabledForChat).mockReturnValue(true);

  // Default CalendarApi mock implementations
  mockCreateEvent.mockResolvedValue({ id: 'gcal-event-123', summary: 'Test', start: '2026-05-01T10:00:00Z', end: '2026-05-01T11:00:00Z', allDay: false, htmlLink: 'https://calendar.google.com/event/123' });
  mockUpdateEvent.mockResolvedValue({ id: 'gcal-event-123', summary: 'Updated', start: '2026-05-01T10:00:00Z', end: '2026-05-01T11:00:00Z', allDay: false });
  mockDeleteEvent.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// organize_create
// ---------------------------------------------------------------------------

describe('organize_create', () => {
  it('creates a task — writes file, inserts audit row, returns ok:true with id', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'Buy groceries' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Created task');
    expect(result.output).toContain('Buy groceries');
    expect(result.data?.type).toBe('task');
    expect(result.data?.id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/);

    const audit = auditRows.find((r) => r.category === 'organize.create');
    expect(audit).toBeDefined();
    expect(audit?.detail.result).toBe('ok');
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('creates a goal with tags', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'goal', title: 'Lose 10 lbs by summer', tags: ['fitness'] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data?.type).toBe('goal');
  });

  it('creates an event — calls CalendarApi.createEvent first; created file has calendarEventId', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
    }, ctx);

    expect(result.ok).toBe(true);
    expect(mockCreateEvent).toHaveBeenCalledOnce();
    expect(result.output).toContain('synced to Calendar');
    expect(result.data?.calendarEventId).toBe('gcal-event-123');
  });

  it('create event — CALENDAR_CREATE_FAILED when CalendarApi throws; no file written', async () => {
    mockCreateEvent.mockRejectedValueOnce(new Error('API quota exceeded'));
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CALENDAR_CREATE_FAILED');
    // Verify no file was written by checking audit row
    const audit = auditRows.find((r) => r.category === 'organize.create');
    expect(audit?.detail.result).toBe('failed');
  });

  it('create event file-write failure after GCal success — compensation delete called → FILE_WRITE_FAILED_EVENT_ROLLED_BACK', async () => {
    vi.spyOn(storageModule, 'createItem').mockRejectedValueOnce(new Error('disk full'));
    const tool = buildOrganizeCreateTool(deps);

    const result = await tool.execute({
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FILE_WRITE_FAILED_EVENT_ROLLED_BACK');
    expect(mockDeleteEvent).toHaveBeenCalledOnce(); // compensation called
  });

  it('create event file-write failure + compensating delete also fails → FILE_WRITE_FAILED_EVENT_ORPHANED + organize.inconsistency audit row', async () => {
    mockDeleteEvent.mockRejectedValueOnce(new Error('network flap'));
    vi.spyOn(storageModule, 'createItem').mockRejectedValueOnce(new Error('disk full'));

    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FILE_WRITE_FAILED_EVENT_ORPHANED');
    expect(result.output).toContain('gcal-event-123'); // eventId surfaced

    const inconsistencyRow = auditRows.find((r) => r.category === 'organize.inconsistency');
    expect(inconsistencyRow).toBeDefined();
    expect(inconsistencyRow?.detail.kind).toBe('orphan-gcal');
  });

  it('/calendar off → CALENDAR_DISABLED_FOR_CHAT; CalendarApi.createEvent NOT called; no file written', async () => {
    vi.mocked(calendarModule.isCalendarEnabledForChat).mockReturnValue(false);

    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
    }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CALENDAR_DISABLED_FOR_CHAT');
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('MISSING_EVENT_FIELDS — timed event without endTime', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      // no endTime
    }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('MISSING_EVENT_FIELDS');
  });

  it('ACTIVE_CAP_EXCEEDED at 200 items', async () => {
    // v1.10.0 R4: isBelowActiveCap fails closed (returns false on both real cap AND
    // readdir error). organize_create now calls countActiveItems to distinguish:
    // mock it to return 200 so we confirm this is a real cap breach.
    vi.spyOn(storageModule, 'isBelowActiveCap').mockResolvedValueOnce(false);
    vi.spyOn(storageModule, 'countActiveItems').mockResolvedValueOnce(200);

    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'Over the cap' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACTIVE_CAP_EXCEEDED');
  });

  it('R4: readdir error + countActiveItems also throws → ACTIVE_CAP_CHECK_FAILED with actionable message', async () => {
    // Simulate fail-closed: isBelowActiveCap returns false (readdir error path).
    // countActiveItems also throws (e.g. same directory issue).
    vi.spyOn(storageModule, 'isBelowActiveCap').mockResolvedValueOnce(false);
    vi.spyOn(storageModule, 'countActiveItems').mockRejectedValueOnce(new Error('EACCES'));

    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'Check cap' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACTIVE_CAP_CHECK_FAILED');
    expect(result.output).toContain("Couldn't verify your item cap right now");
  });

  it('R4: readdir error but countActiveItems returns 201 → ACTIVE_CAP_EXCEEDED (real cap breach confirmed)', async () => {
    // isBelowActiveCap returns false (fail-closed due to readdir error or actual cap).
    // countActiveItems confirms 201 active items → real cap breach, not a FS error.
    vi.spyOn(storageModule, 'isBelowActiveCap').mockResolvedValueOnce(false);
    vi.spyOn(storageModule, 'countActiveItems').mockResolvedValueOnce(201);

    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'Check cap' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACTIVE_CAP_EXCEEDED');
  });

  it('PRIVACY_FILTER_REJECTED for health term in title; audit row has category-only reason (no matched substring)', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'schedule chemo appointment' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PRIVACY_FILTER_REJECTED');

    const audit = auditRows.find((r) => r.category === 'organize.create');
    expect(audit).toBeDefined();
    expect(audit?.detail.result).toBe('rejected');
    // Reason must NOT echo the matched word
    const reason = audit?.detail.reason as string;
    expect(reason).not.toContain('chemo');
    expect(reason).toContain('disease');
  });

  it('NO_USER_ID when userId missing', async () => {
    const noUserCtx = { ...ctx, userId: undefined };
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'Test' }, noUserCtx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(result.output).toContain('/organize requires a DM');
  });
});

// ---------------------------------------------------------------------------
// organize_update
// ---------------------------------------------------------------------------

describe('organize_update', () => {
  let itemId: string;

  beforeEach(async () => {
    // Create a base item to update
    const item = await createItem(USER_ID, dataDir, {
      type: 'task',
      title: 'Original title',
      due: '2026-05-01',
    });
    itemId = item.frontMatter.id;
  });

  it('non-event update — single file write, no calendar call', async () => {
    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: itemId, title: 'Updated title' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain(itemId);
    expect(result.data?.changedFields).toContain('title');
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('NO_CHANGES when no fields differ — returns ok:true (spec §16.3.3)', async () => {
    const tool = buildOrganizeUpdateTool(deps);
    // status=active is the same as existing; no other field supplied
    const result = await tool.execute({ id: itemId, status: 'active' }, ctx);
    // NO_CHANGES is an informational outcome, not an error — ok:true per ARCHITECTURE §16.3.3
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No changes needed');
    expect(result.data?.changedFields).toEqual([]);
  });

  it('ITEM_NOT_FOUND for unknown id', async () => {
    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: '2020-01-01-zzzz', title: 'Whatever' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
  });

  it('PRIVACY_FILTER_REJECTED for health term in notes; reason names category only', async () => {
    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: itemId, notes: 'My xanax prescription refill' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PRIVACY_FILTER_REJECTED');
    const audit = auditRows.find((r) => r.category === 'organize.update');
    const reason = audit?.detail.reason as string;
    expect(reason).not.toContain('xanax');
  });

  it('event update with synced fields — calls CalendarApi.updateEvent', async () => {
    // Create an event item with calendarEventId
    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-event-abc',
    });

    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: eventItem.frontMatter.id, title: 'Dentist Checkup' }, ctx);

    expect(result.ok).toBe(true);
    expect(mockUpdateEvent).toHaveBeenCalledOnce();
    expect(result.data?.calendarSynced).toBe(true);
  });

  it('event update — GCal fails → ok:true, code CALENDAR_SYNC_FAILED_SOFT, local IS updated', async () => {
    mockUpdateEvent.mockRejectedValueOnce(new Error('GCal error'));
    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-event-abc',
    });

    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: eventItem.frontMatter.id, title: 'Dentist Checkup' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.error?.code).toBe('CALENDAR_SYNC_FAILED_SOFT');
    expect(result.data?.calendarSynced).toBe(false);
  });

  it('/calendar off on event update → CALENDAR_DISABLED_FOR_CHAT_SOFT; local updated; CalendarApi.updateEvent NOT called', async () => {
    vi.mocked(calendarModule.isCalendarEnabledForChat).mockReturnValue(false);

    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-event-abc',
    });

    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: eventItem.frontMatter.id, title: 'Dentist Checkup' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.error?.code).toBe('CALENDAR_DISABLED_FOR_CHAT_SOFT');
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it('NO_USER_ID when userId missing', async () => {
    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: itemId, title: 'New title' }, { ...ctx, userId: undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(result.output).toContain('/organize requires a DM');
  });
});

// ---------------------------------------------------------------------------
// organize_complete
// ---------------------------------------------------------------------------

describe('organize_complete', () => {
  let itemId: string;

  beforeEach(async () => {
    const item = await createItem(USER_ID, dataDir, {
      type: 'task',
      title: 'Walk the dog',
    });
    itemId = item.frontMatter.id;
  });

  it('happy path — marks item done, inserts audit row', async () => {
    const result = await organizeCompleteTool.execute({ id: itemId }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('done');

    const audit = auditRows.find((r) => r.category === 'organize.complete');
    expect(audit?.detail.result).toBe('ok');
  });

  it('with completionNote — appends note, note appears in output', async () => {
    const result = await organizeCompleteTool.execute({ id: itemId, completionNote: 'Did 30 min' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Did 30 min');
  });

  it('ALREADY_COMPLETE when item is already done', async () => {
    await organizeCompleteTool.execute({ id: itemId }, ctx);
    const result = await organizeCompleteTool.execute({ id: itemId }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ALREADY_COMPLETE');
  });

  it('ITEM_NOT_FOUND for unknown id', async () => {
    const result = await organizeCompleteTool.execute({ id: '2020-01-01-zzzz' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
  });

  it('NEVER touches CalendarApi even on event items', async () => {
    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-event-abc',
    });
    const result = await organizeCompleteTool.execute({ id: eventItem.frontMatter.id }, ctx);
    expect(result.ok).toBe(true);
    expect(mockUpdateEvent).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it('PRIVACY_FILTER_REJECTED for health term in completionNote', async () => {
    const result = await organizeCompleteTool.execute({ id: itemId, completionNote: 'Took my adderall' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PRIVACY_FILTER_REJECTED');
  });

  it('NO_USER_ID when userId missing', async () => {
    const result = await organizeCompleteTool.execute({ id: itemId }, { ...ctx, userId: undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(result.output).toContain('/organize requires a DM');
  });
});

// ---------------------------------------------------------------------------
// organize_list
// ---------------------------------------------------------------------------

describe('organize_list', () => {
  beforeEach(async () => {
    await createItem(USER_ID, dataDir, { type: 'task', title: 'Task A', due: '2026-06-01' });
    await createItem(USER_ID, dataDir, { type: 'goal', title: 'Goal B' });
    await createItem(USER_ID, dataDir, { type: 'event', title: 'Event C', due: '2026-05-01' });
  });

  it('returns active items sorted by due asc (undated last)', async () => {
    const result = await organizeListTool.execute({ filter: 'active', limit: 50 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Event C');
    expect(result.output).toContain('Task A');
    expect(result.output).toContain('Goal B');
    // Event C (due 2026-05-01) should appear before Task A (due 2026-06-01)
    const ecIdx = result.output.indexOf('Event C');
    const taIdx = result.output.indexOf('Task A');
    const gbIdx = result.output.indexOf('Goal B');
    expect(ecIdx).toBeLessThan(taIdx); // earlier due first
    expect(gbIdx).toBeGreaterThan(taIdx); // undated last
  });

  it('returns "No matching items." when filter yields nothing', async () => {
    const result = await organizeListTool.execute({ filter: 'done', limit: 50 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No matching items.');
  });

  it('filter by type', async () => {
    const result = await organizeListTool.execute({ filter: 'active', type: 'goal', limit: 50 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Goal B');
    expect(result.output).not.toContain('Task A');
  });

  it('LIST_READ_FAILED on catastrophic readdir failure', async () => {
    vi.spyOn(storageModule, 'listItems').mockRejectedValueOnce(new Error('EACCES'));
    const result = await organizeListTool.execute({ filter: 'active', limit: 50 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('LIST_READ_FAILED');
  });

  it('NO_USER_ID when userId missing', async () => {
    const result = await organizeListTool.execute({ filter: 'active', limit: 50 }, { ...ctx, userId: undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(result.output).toContain('/organize requires a DM');
  });
});

// ---------------------------------------------------------------------------
// organize_log_progress
// ---------------------------------------------------------------------------

describe('organize_log_progress', () => {
  let itemId: string;

  beforeEach(async () => {
    const item = await createItem(USER_ID, dataDir, { type: 'goal', title: 'Run a 5K' });
    itemId = item.frontMatter.id;
  });

  it('happy path — appends progress entry, returns ok:true', async () => {
    const result = await organizeLogProgressTool.execute({ id: itemId, entry: 'Ran 2km today' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Ran 2km today');

    const audit = auditRows.find((r) => r.category === 'organize.progress');
    expect(audit?.detail.result).toBe('ok');
  });

  it('ITEM_NOT_FOUND for unknown id', async () => {
    const result = await organizeLogProgressTool.execute({ id: '2020-01-01-zzzz', entry: 'Note' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
  });

  it('PRIVACY_FILTER_REJECTED before read; audit row has category-only reason', async () => {
    const result = await organizeLogProgressTool.execute({ id: itemId, entry: 'Taking Prozac today' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PRIVACY_FILTER_REJECTED');

    const audit = auditRows.find((r) => r.category === 'organize.progress');
    const reason = audit?.detail.reason as string;
    expect(reason).not.toContain('Prozac');
    expect(reason).not.toContain('prozac');
  });

  it('NEVER changes status', async () => {
    const readItemFn = storageModule.readItem;
    await organizeLogProgressTool.execute({ id: itemId, entry: 'Ran 1km' }, ctx);
    const item = await readItemFn(USER_ID, dataDir, itemId);
    expect(item?.frontMatter.status).toBe('active'); // unchanged
  });

  it('NO_USER_ID when userId missing', async () => {
    const result = await organizeLogProgressTool.execute({ id: itemId, entry: 'Note' }, { ...ctx, userId: undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(result.output).toContain('/organize requires a DM');
  });
});

// ---------------------------------------------------------------------------
// organize_delete
// ---------------------------------------------------------------------------

describe('organize_delete', () => {
  let taskItemId: string;
  let eventItemId: string;

  beforeEach(async () => {
    const taskItem = await createItem(USER_ID, dataDir, { type: 'task', title: 'Clean desk' });
    taskItemId = taskItem.frontMatter.id;

    const eventItem = await createItem(USER_ID, dataDir, {
      type: 'event',
      title: 'Dentist',
      due: '2026-05-01T10:00:00Z',
      calendarEventId: 'gcal-event-xyz',
    });
    eventItemId = eventItem.frontMatter.id;
  });

  it('non-event soft-delete — no GCal call, local file moved to trash', async () => {
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: taskItemId }, ctx);
    expect(result.ok).toBe(true);
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  it('event delete — CalendarApi.deleteEvent called; on success, local soft-delete proceeds', async () => {
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventItemId }, ctx);
    expect(result.ok).toBe(true);
    expect(mockDeleteEvent).toHaveBeenCalledOnce();
    expect(result.output).toContain('removed from Calendar');
  });

  it('event delete — GCal 404 treated as success; local soft-delete proceeds', async () => {
    // Use a GaxiosError-shaped error with numeric status code (Fix #5 numeric-first detection).
    const gcal404Err = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockDeleteEvent.mockRejectedValueOnce(gcal404Err);
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventItemId }, ctx);
    expect(result.ok).toBe(true);
  });

  it('event delete — GCal 500 → CALENDAR_DELETE_FAILED; local NOT soft-deleted', async () => {
    mockDeleteEvent.mockRejectedValueOnce(new Error('Internal Server Error 500'));
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventItemId }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CALENDAR_DELETE_FAILED');

    // Verify item still exists (not soft-deleted)
    const readItemFn = storageModule.readItem;
    const item = await readItemFn(USER_ID, dataDir, eventItemId);
    expect(item).not.toBeNull();
  });

  it('event delete — GCal 429 (rate-limit) → CALENDAR_DELETE_FAILED; local NOT soft-deleted', async () => {
    mockDeleteEvent.mockRejectedValueOnce(new Error('Too Many Requests 429'));
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventItemId }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CALENDAR_DELETE_FAILED');
  });

  it('event delete — GCal success + local rename fails → FILE_DELETE_FAILED + organize.inconsistency orphan-local row', async () => {
    vi.spyOn(storageModule, 'softDeleteItem').mockRejectedValueOnce(new Error('EACCES'));
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventItemId }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FILE_DELETE_FAILED');

    const inconsistencyRow = auditRows.find((r) => r.category === 'organize.inconsistency');
    expect(inconsistencyRow?.detail.kind).toBe('orphan-local');
  });

  it('/calendar off on event → CALENDAR_DISABLED_FOR_CHAT_SOFT; soft-deleted locally; CalendarApi.deleteEvent NOT called; organize.inconsistency deferred-orphan-gcal inserted', async () => {
    vi.mocked(calendarModule.isCalendarEnabledForChat).mockReturnValue(false);

    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: eventItemId }, ctx);

    expect(result.ok).toBe(true);
    expect(result.error?.code).toBe('CALENDAR_DISABLED_FOR_CHAT_SOFT');
    expect(mockDeleteEvent).not.toHaveBeenCalled();

    const inconsistencyRow = auditRows.find((r) => r.category === 'organize.inconsistency');
    expect(inconsistencyRow?.detail.kind).toBe('deferred-orphan-gcal');
    expect(inconsistencyRow?.detail.eventId).toBe('gcal-event-xyz');
  });

  it('ITEM_NOT_FOUND for unknown id', async () => {
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: '2020-01-01-zzzz' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ITEM_NOT_FOUND');
  });

  it('NO_USER_ID when userId missing', async () => {
    const tool = buildOrganizeDeleteTool(deps);
    const result = await tool.execute({ id: taskItemId }, { ...ctx, userId: undefined });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(result.output).toContain('/organize requires a DM');
  });
});

// ---------------------------------------------------------------------------
// Fix #7 — QA-MED-03: R5 "NEW-content-only filter" inverse case
// Status-only update on item with notes that would fail the current filter succeeds.
// ---------------------------------------------------------------------------

describe('organize_update — R5 NEW-content-only filter (inverse case)', () => {
  it('status-only update succeeds even when existing notes contain a health term', async () => {
    // Create an item with clean notes (filter passes at create time).
    const cleanItem = await createItem(USER_ID, dataDir, {
      type: 'task',
      title: 'Track my workouts',
    });

    // Bypass the privacy filter to write notes with a health term directly to storage.
    // This simulates a filter tightening: the notes were accepted under old rules,
    // but under stricter rules they would now be rejected.
    const { updateItem: storageUpdate } = await import('../../src/organize/storage.js');
    // The storage updateItem has no privacy filter — write health-term notes directly.
    await storageUpdate(USER_ID, dataDir, cleanItem.frontMatter.id, {
      notes: 'I need to refill my Adderall prescription',
    });

    // Now call organize_update with status ONLY — no notes field.
    // Per R5, the privacy filter ONLY runs on fields explicitly supplied.
    // The existing dirty notes must NOT be re-validated.
    const tool = buildOrganizeUpdateTool(deps);
    const result = await tool.execute({ id: cleanItem.frontMatter.id, status: 'done' }, ctx);

    // Must succeed: status changed, notes NOT re-filtered.
    expect(result.ok).toBe(true);
    expect(result.data?.changedFields).toContain('status');
    expect(result.data?.changedFields).not.toContain('notes');
  });
});

// ---------------------------------------------------------------------------
// Fix #8 — QA-MED-04: non-ISO due sort order in organize_list
// ISO-dated items must sort before non-ISO and undated items.
// ---------------------------------------------------------------------------

describe('organize_list — non-ISO due sorts last (Fix #8)', () => {
  it('ISO-dated item appears first, non-ISO and undated appear last', async () => {
    // Create an ISO-dated item.
    await createItem(USER_ID, dataDir, {
      type: 'task',
      title: 'ISO dated',
      due: '2026-05-01',
    });
    // Create an undated item.
    await createItem(USER_ID, dataDir, {
      type: 'task',
      title: 'No due date',
    });

    // Write a non-ISO due item directly to disk (storage layer accepts tolerant parse;
    // the tool's zod schema doesn't validate due format, but we write directly to be
    // explicit about the non-ISO value).
    const { ensureUserDir: ensureDir } = await import('../../src/organize/storage.js');
    const { writeFile: writeFs } = await import('node:fs/promises');
    const dir = await ensureDir(USER_ID, dataDir);
    const nonIsoId = '2026-04-24-nixx';
    await writeFs(
      `${dir}/${nonIsoId}.md`,
      `---\nid: ${nonIsoId}\ntype: task\nstatus: active\ntitle: Non-ISO due\ncreated: 2026-04-24T10:00:00Z\ndue: next Tuesday\nparentId: \ncalendarEventId: \ntags: []\n---\n\n## Notes\n\n## Progress\n`,
      'utf8',
    );

    const result = await organizeListTool.execute({ filter: 'active' }, ctx);
    expect(result.ok).toBe(true);

    // The output is a formatted string. Verify ISO-dated item appears before non-ISO and undated.
    const output = result.output ?? '';
    const isoPos = output.indexOf('ISO dated');
    const nonIsoPos = output.indexOf('Non-ISO due');
    const noDuePos = output.indexOf('No due date');

    expect(isoPos).toBeGreaterThanOrEqual(0);
    expect(nonIsoPos).toBeGreaterThanOrEqual(0);
    expect(noDuePos).toBeGreaterThanOrEqual(0);
    // ISO dated must appear before non-ISO and undated.
    expect(isoPos).toBeLessThan(nonIsoPos);
    expect(isoPos).toBeLessThan(noDuePos);
  });
});

// ---------------------------------------------------------------------------
// Fix #9 — QA-LOW-01: 200-cap boundary positive side
// The 200th create should succeed (cap not exceeded until 201st).
// ---------------------------------------------------------------------------

describe('organize_create — 200-item cap positive boundary (Fix #9)', () => {
  it('199th item succeeds (below cap)', async () => {
    // v1.9.1: organize_create now calls isBelowActiveCap (returns true = below cap).
    vi.spyOn(storageModule, 'isBelowActiveCap').mockResolvedValueOnce(true);

    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute({ type: 'task', title: 'Item at 199 count' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.error?.code).not.toBe('ACTIVE_CAP_EXCEEDED');
  });
});
