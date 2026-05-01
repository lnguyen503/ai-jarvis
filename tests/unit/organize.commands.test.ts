/**
 * Unit tests for organize_create tool — R13 BLOCKING guard (v1.14.3) +
 * restore command parsing (v1.14.3 D9).
 *
 * R13: goal-with-parentId must be rejected at create time.
 * Tests:
 *   create-1: goal + parentId → GOAL_CANNOT_HAVE_PARENT; no file; audit row
 *   create-2: task + parentId → succeeds (non-goal types still accept parentId)
 *   create-3: event + parentId → succeeds (regression guard)
 *
 * Restore command parsing tests:
 *   restore-1: valid id format accepted
 *   restore-2: missing id → usage error
 *   restore-3: malformed id → usage error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';

// Mock CalendarApi and oauth before importing tools
vi.mock('../../src/google/calendar.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/google/calendar.js')>();
  return {
    ...original,
    CalendarApi: vi.fn().mockImplementation(function (this: unknown) {
      (this as Record<string, unknown>).createEvent = vi.fn().mockResolvedValue({
        id: 'gcal-event-r13',
        summary: 'Test event',
        start: '2026-05-01T10:00:00Z',
        end: '2026-05-01T11:00:00Z',
        allDay: false,
        htmlLink: 'https://calendar.google.com/event/r13',
      });
      (this as Record<string, unknown>).deleteEvent = vi.fn().mockResolvedValue(undefined);
    }),
    isCalendarEnabledForChat: vi.fn(() => true),
  };
});

vi.mock('../../src/google/oauth.js', () => ({
  loadGoogleAuth: vi.fn().mockResolvedValue({}),
}));

import { buildOrganizeCreateTool } from '../../src/tools/organize_create.js';
import type { ToolContext, ToolDeps } from '../../src/tools/types.js';
import type { InsertAuditParams } from '../../src/memory/auditLog.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { existsSync } from 'node:fs';
import { organizeUserDir } from '../../src/organize/storage.js';

import {
  handleOrganize,
  _resetOrganizeToggleForTests,
  type OrganizeCommandDeps,
} from '../../src/commands/organize.js';

vi.mock('../../src/gateway/groupGate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway/groupGate.js')>();
  return { ...original, isGroupChat: vi.fn(() => false) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });
const USER_ID = 444001;
const CHAT_ID = 1111;
const SESSION_ID = 1;

let dataDir: string;
let auditRows: InsertAuditParams[];
let ctx: ToolContext;
let deps: ToolDeps;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-commands-test-'));
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

  _resetOrganizeToggleForTests();
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R13 BLOCKING — goal-with-parent guard at create time
// ---------------------------------------------------------------------------

describe('organize_create — R13 BLOCKING: goal-with-parent rejected', () => {
  it('create-1: goal + parentId → GOAL_CANNOT_HAVE_PARENT; no file written; audit row', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute(
      { type: 'goal', title: 'Child goal', parentId: '2026-04-01-abcd' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOAL_CANNOT_HAVE_PARENT');
    expect(result.output).toMatch(/Goals are top-level/);

    // No file written
    const userDir = organizeUserDir(USER_ID, dataDir);
    const mdFiles = existsSync(userDir)
      ? (await import('node:fs/promises')).then((m) => m.readdir(userDir)).then((entries) =>
          entries.filter((e) => e.endsWith('.md')))
      : Promise.resolve([]);
    expect(await mdFiles).toHaveLength(0);

    // Audit row emitted with correct reason
    const audit = auditRows.find(
      (r) => r.category === 'organize.create' && r.detail.reason === 'GOAL_CANNOT_HAVE_PARENT',
    );
    expect(audit).toBeDefined();
    expect(audit?.detail.result).toBe('rejected');
  });

  it('create-2: task + parentId → succeeds (non-goal types still accept parentId)', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute(
      { type: 'task', title: 'Child task', parentId: '2026-04-01-abcd' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.type).toBe('task');
  });

  it('create-3: event + parentId → succeeds (events with parentId are valid)', async () => {
    const tool = buildOrganizeCreateTool(deps);
    const result = await tool.execute(
      {
        type: 'event',
        title: 'Event under goal',
        due: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T11:00:00Z',
        parentId: '2026-04-01-abcd',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.type).toBe('event');
  });
});

// ---------------------------------------------------------------------------
// /organize restore command parsing
// ---------------------------------------------------------------------------

function makeOrganizeCtx(userId: number | undefined, text: string) {
  const replies: string[] = [];
  return {
    ctx: {
      chat: { type: 'private', id: userId ?? 0 },
      from: userId !== undefined ? { id: userId } : undefined,
      message: { text },
      replies,
      reply: async (msg: string) => { replies.push(msg); },
    } as unknown as Parameters<typeof handleOrganize>[0],
    replies,
  };
}

describe('/organize restore command parsing', () => {
  it('restore-1: /organize restore with valid id → calls handleRestoreItem path (no crash)', async () => {
    const cfg = makeTestConfig();
    const cmdDeps: OrganizeCommandDeps = {
      config: cfg,
      memory: null,
    };

    const { ctx: organizeCtx, replies } = makeOrganizeCtx(USER_ID, '/organize restore 2026-04-25-abcd');
    // restoreItem will throw ITEM_NOT_FOUND_IN_TRASH since no actual file exists —
    // we just verify the command routes to the restore handler (no crash, and a reply is sent)
    await handleOrganize(organizeCtx, cmdDeps);
    // Should produce some reply (error or result)
    expect(replies.length).toBeGreaterThan(0);
  });

  it('restore-2: /organize restore with no id → usage error reply', async () => {
    const cfg = makeTestConfig();
    const cmdDeps: OrganizeCommandDeps = { config: cfg, memory: null };

    const { ctx: organizeCtx, replies } = makeOrganizeCtx(USER_ID, '/organize restore');
    await handleOrganize(organizeCtx, cmdDeps);
    expect(replies[0]).toMatch(/Usage.*restore/i);
  });

  it('restore-3: /organize restore with malformed id → usage error reply', async () => {
    const cfg = makeTestConfig();
    const cmdDeps: OrganizeCommandDeps = { config: cfg, memory: null };

    const { ctx: organizeCtx, replies } = makeOrganizeCtx(USER_ID, '/organize restore not-an-id');
    await handleOrganize(organizeCtx, cmdDeps);
    expect(replies[0]).toMatch(/Usage.*restore/i);
  });
});
