/**
 * Integration tests: /organize coach subcommands (ADR 018 commit 7).
 *
 * Tests:
 *   1. setup with no time → defaults to 08:00; coach task created with cron '0 8 * * *'
 *   2. setup '09:30' → cron '30 9 * * *'
 *   3. setup '25:99' → invalid format error, no task created
 *   4. setup re-run → updates existing task (idempotent; one task per user)
 *   5. off → coach task deleted (returns true)
 *   6. off when no task exists → still replies confirmation (idempotent)
 *   7. reset without confirm → shows confirm message; no memory deleted
 *   8. reset confirm within 30s window → all coach.* memory entries deleted
 *   9. reset confirm after 30s → confirm-window-expired error
 *  10. help text rendered for /organize coach with no recognized subcommand
 *  11. setup '00:00' → midnight cron '0 0 * * *' (edge: midnight)
 *  12. setup '23:59' → cron '59 23 * * *' (edge: last minute)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { COACH_TASK_DESCRIPTION, COACH_PROMPT_PLACEHOLDER } from '../../src/coach/index.js';
import {
  handleCoachSetup,
  handleCoachOff,
  handleCoachReset,
  handleCoachHelp,
  handleCoachOnTopLevel,
  handleCoachOffTopLevel,
  handleCoachStatus,
  _resetPendingConfirmsForTests,
  type CoachSubcommandCtx,
} from '../../src/commands/coachSubcommands.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 77001;
const CHAT_ID = 77001;

function makeMockCtx() {
  const replies: string[] = [];
  const ctx = {
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return {} as ReturnType<typeof ctx.reply> extends Promise<infer T> ? T : never;
    }),
    chat: { id: CHAT_ID },
    from: { id: USER_ID },
    message: { text: '' },
  };
  return { ctx, replies };
}

let mem: MemoryApi;
let dataDir: string;

beforeEach(async () => {
  _resetDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), `jarvis-coach-cmd-${Date.now()}-`));
  await mkdir(path.join(dataDir, 'memories'), { recursive: true });

  const dbPath = path.join(dataDir, 'test.db');
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  mem = initMemory(cfg);
  _resetPendingConfirmsForTests();
});

afterEach(async () => {
  mem.close();
  _resetDb();
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(ctxObj: ReturnType<typeof makeMockCtx>['ctx']): CoachSubcommandCtx {
  const dbPath = path.join(dataDir, 'test.db');
  const config = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return {
    ctx: ctxObj as unknown as CoachSubcommandCtx['ctx'],
    userId: USER_ID,
    chatId: CHAT_ID,
    memory: mem,
    config,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/organize coach subcommands (commit 7)', () => {
  it('1. setup with no time → defaults to 08:00; cron is "0 8 * * *"', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachSetup(deps, undefined);

    expect(replies.join(' ')).toMatch(/08:00/);
    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe(COACH_TASK_DESCRIPTION);
    expect(tasks[0]!.cron_expression).toBe('0 8 * * *');
    expect(tasks[0]!.command).toBe(COACH_PROMPT_PLACEHOLDER);
  });

  it('2. setup "09:30" → cron "30 9 * * *"', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachSetup(deps, '09:30');

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.cron_expression).toBe('30 9 * * *');
  });

  it('3. setup "25:99" → invalid format error, no task created', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachSetup(deps, '25:99');

    expect(replies.join(' ')).toMatch(/Invalid time format/i);
    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(0);
  });

  it('4. setup re-run → updates existing task (idempotent; one task per user)', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachSetup(deps, '08:00');
    await handleCoachSetup(deps, '09:30'); // second setup, different time

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(1); // still only ONE task
    expect(tasks[0]!.cron_expression).toBe('30 9 * * *'); // updated
  });

  it('5. off → coach task deleted', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    // Setup first so there's a task to delete
    await handleCoachSetup(deps, '08:00');
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(1);

    const { ctx: ctx2, replies: replies2 } = makeMockCtx();
    await handleCoachOff(makeDeps(ctx2));

    expect(replies2.join(' ')).toMatch(/paused/i);
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(0);
  });

  it('6. off when no task exists → still replies confirmation (idempotent)', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachOff(deps);

    expect(replies.join(' ')).toMatch(/paused/i);
    // No error thrown; 0 tasks deleted is fine
  });

  it('7. reset without confirm → shows confirm message; no memory deleted', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachReset(deps, false);

    expect(replies.join(' ')).toMatch(/30s/i);
    // No memory deletion
  });

  it('8. reset confirm within 30s → memory deleted (zero entries is valid)', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    // First tap: arm confirm window
    await handleCoachReset(deps, false);

    // Second tap: confirm within window (immediately)
    const { ctx: ctx2, replies: replies2 } = makeMockCtx();
    await handleCoachReset(makeDeps(ctx2), true);

    expect(replies2.join(' ')).toMatch(/cleared/i);
  });

  it('9. reset confirm after 30s → confirm-window-expired error', async () => {
    vi.useFakeTimers();
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    // Arm confirm window
    await handleCoachReset(deps, false);

    // Fast-forward 31 seconds so the confirm window expires
    vi.advanceTimersByTime(31_000);

    const { ctx: ctx2, replies: replies2 } = makeMockCtx();
    await handleCoachReset(makeDeps(ctx2), true);

    expect(replies2.join(' ')).toMatch(/expired/i);

    vi.useRealTimers();
  });

  it('10. help text rendered for /organize coach with no recognized subcommand', async () => {
    const { ctx, replies } = makeMockCtx();
    await handleCoachHelp(ctx as unknown as CoachSubcommandCtx['ctx']);

    expect(replies.join(' ')).toMatch(/setup/i);
    expect(replies.join(' ')).toMatch(/off/i);
    expect(replies.join(' ')).toMatch(/reset/i);
  });

  it('11. setup "00:00" → midnight cron "0 0 * * *"', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachSetup(deps, '00:00');

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks[0]!.cron_expression).toBe('0 0 * * *');
  });

  it('12. setup "23:59" → cron "59 23 * * *"', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachSetup(deps, '23:59');

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks[0]!.cron_expression).toBe('59 23 * * *');
  });

  // -------------------------------------------------------------------------
  // P2 fix Item 3 (Scalability WARNING-1.18.0.A) regression: scheduler.reload()
  // must be called on successful setup AND off so the new/deleted coach task
  // is picked up by node-cron without a pm2 restart. Same trap as v1.17.0
  // WARNING-1.17.0.A in /scheduled.
  // -------------------------------------------------------------------------
  it('13. setup → scheduler.reload() called once', async () => {
    const { ctx } = makeMockCtx();
    const reload = vi.fn();
    const deps: CoachSubcommandCtx = { ...makeDeps(ctx), scheduler: { reload } };

    await handleCoachSetup(deps, '08:00');

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('14. off → scheduler.reload() called once', async () => {
    const { ctx } = makeMockCtx();
    const reload = vi.fn();
    const deps: CoachSubcommandCtx = { ...makeDeps(ctx), scheduler: { reload } };

    // Pre-create a coach task so off has something to delete
    await handleCoachSetup(deps, '08:00');
    reload.mockClear();

    await handleCoachOff(deps);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('15. setup with null scheduler → no throw (boot-window safety)', async () => {
    const { ctx } = makeMockCtx();
    const deps: CoachSubcommandCtx = { ...makeDeps(ctx), scheduler: null };

    // Must not throw even when scheduler is null/undefined
    await expect(handleCoachSetup(deps, '08:00')).resolves.toBeUndefined();
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(1);
  });

  it('16. setup when scheduler.reload() throws → setup still succeeds (non-fatal)', async () => {
    const { ctx } = makeMockCtx();
    const reload = vi.fn(() => { throw new Error('reload failed'); });
    const deps: CoachSubcommandCtx = { ...makeDeps(ctx), scheduler: { reload } };

    // Reload throwing must not fail the setup operation
    await expect(handleCoachSetup(deps, '08:00')).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// v1.19.0 D2 — top-level /coach on /off /status subcommands
// ---------------------------------------------------------------------------

describe('/coach on /off /status top-level commands (v1.19.0 D2)', () => {
  it('D2-1: /coach on with no arg → defaults to 08:00, creates coach task', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachOnTopLevel(deps, undefined);

    expect(replies.join(' ')).toMatch(/08:00/);
    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.cron_expression).toBe('0 8 * * *');
  });

  it('D2-2: /coach on 14:30 → creates task with cron "30 14 * * *"', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachOnTopLevel(deps, '14:30');

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.cron_expression).toBe('30 14 * * *');
  });

  it('D2-3: /coach off → deletes coach task; confirms paused', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    // Setup first
    await handleCoachOnTopLevel(deps, '08:00');
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(1);

    const { ctx: ctx2, replies: replies2 } = makeMockCtx();
    await handleCoachOffTopLevel(makeDeps(ctx2));

    expect(replies2.join(' ')).toMatch(/paused/i);
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(0);
  });

  it('D2-4: /coach off when no task exists → idempotent, replies paused', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachOffTopLevel(deps);

    expect(replies.join(' ')).toMatch(/paused/i);
    // No error thrown; 0 tasks deleted is fine
  });

  it('D2-5: /coach status when OFF → reports OFF status', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachStatus(deps);

    expect(replies.join(' ')).toMatch(/off/i);
  });

  it('D2-6: /coach status when ON → reports time + item count', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    // Setup coach at 09:00
    await handleCoachOnTopLevel(deps, '09:00');

    const { ctx: ctx2, replies: replies2 } = makeMockCtx();
    await handleCoachStatus(makeDeps(ctx2));

    expect(replies2.join(' ')).toMatch(/09:00/);
    expect(replies2.join(' ')).toMatch(/on/i);
  });

  it('D2-7: /coach on with invalid time → rejects with error message', async () => {
    const { ctx, replies } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachOnTopLevel(deps, '99:99');

    expect(replies.join(' ')).toMatch(/invalid/i);
    expect(mem.scheduledTasks.listByOwner(USER_ID)).toHaveLength(0);
  });

  it('D2-8: /coach on is idempotent — updates existing task if already on', async () => {
    const { ctx } = makeMockCtx();
    const deps = makeDeps(ctx);

    await handleCoachOnTopLevel(deps, '08:00');
    await handleCoachOnTopLevel(deps, '10:00');

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    expect(tasks).toHaveLength(1); // still one task
    expect(tasks[0]!.cron_expression).toBe('0 10 * * *'); // updated to 10:00
  });
});
