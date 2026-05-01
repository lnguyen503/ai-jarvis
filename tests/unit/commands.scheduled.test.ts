/**
 * Unit tests for the /scheduled command (v1.10.0).
 *
 * Coverage:
 *   - /scheduled bare → list (no tasks, with tasks, pagination)
 *   - /scheduled list all → admin-only
 *   - /scheduled show → ownership check
 *   - /scheduled pause → own task ok; not-your-task rejected
 *   - /scheduled delete → preview without CONFIRM; execute with CONFIRM
 *   - /scheduled claim → admin-only; already-owned → rejected
 *   - Group chat → DM-only redirect
 *   - Pagination: 25 tasks, page 1 shows 20; page 2 shows 5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { Context } from 'grammy';
import { handleScheduled, type ScheduledCommandDeps } from '../../src/commands/scheduled.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { ScheduledTask } from '../../src/memory/scheduledTasks.js';
import type { InsertAuditParams } from '../../src/memory/auditLog.js';
import type { MemoryApi } from '../../src/memory/index.js';

const silentLogger = pino({ level: 'silent' });

const ADMIN_USER_ID = 1001;
const OWNER_USER_ID = 2002;
const OTHER_USER_ID = 3003;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  userId: number,
  text: string,
  chatType: 'private' | 'group' | 'supergroup' = 'private',
): Context {
  const chatId = chatType === 'private' ? userId : -100000001;
  return {
    from: { id: userId, is_bot: false, first_name: 'TestUser' },
    chat: { id: chatId, type: chatType, title: chatType !== 'private' ? 'TestGroup' : undefined },
    message: { text },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 1,
    description: 'morning goals',
    cron_expression: '0 8 * * *',
    command: 'list my active organize items',
    chat_id: OWNER_USER_ID,
    owner_user_id: OWNER_USER_ID,
    last_run_at: null,
    next_run_at: null,
    status: 'active',
    created_at: '2026-04-24T00:00:00.000Z',
    updated_at: '2026-04-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeMem(tasks: ScheduledTask[] = []): {
  memory: MemoryApi;
  auditRows: InsertAuditParams[];
} {
  const auditRows: InsertAuditParams[] = [];
  const memory = {
    scheduledTasks: {
      listByOwner: vi.fn((ownerId: number) => tasks.filter((t) => t.owner_user_id === ownerId)),
      listAll: vi.fn(() => tasks),
      get: vi.fn((id: number) => tasks.find((t) => t.id === id) ?? null),
      setStatus: vi.fn((id: number, status: 'active' | 'paused') => {
        const task = tasks.find((t) => t.id === id);
        if (task) task.status = status;
      }),
      remove: vi.fn((id: number) => {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx >= 0) tasks.splice(idx, 1);
      }),
      insert: vi.fn((_params: unknown) => {
        const newId = Math.max(0, ...tasks.map((t) => t.id)) + 1;
        return newId;
      }),
    },
    auditLog: {
      insert: (p: InsertAuditParams) => { auditRows.push(p); },
    },
  } as unknown as MemoryApi;

  return { memory, auditRows };
}

function makeDeps(
  tasks: ScheduledTask[] = [],
  {
    adminUserIds = [ADMIN_USER_ID],
    schedulerReload = vi.fn(),
  }: {
    adminUserIds?: number[];
    schedulerReload?: ReturnType<typeof vi.fn>;
  } = {},
): { deps: ScheduledCommandDeps; auditRows: InsertAuditParams[]; reloadFn: ReturnType<typeof vi.fn> } {
  const cfg = makeTestConfig({
    groups: {
      enabled: false,
      allowedGroupIds: [],
      adminUserIds,
      developerUserIds: [],
      groupRoles: {},
      rateLimitPerUser: 10,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: [],
      intentDetection: {
        enabled: false,
        provider: 'ollama-cloud',
        model: 'gemma4:cloud',
        followUpWindowSeconds: 120,
        confirmationTtlSeconds: 120,
        rateLimitPerMinute: 30,
        recentMessageContext: 4,
      },
    },
  });
  const { memory, auditRows } = makeMem(tasks);
  const reloadFn = schedulerReload;
  const deps: ScheduledCommandDeps = {
    config: cfg,
    memory,
    schedulerApi: { reload: reloadFn },
  };
  return { deps, auditRows, reloadFn };
}

function getReply(ctx: Context): string {
  const mock = (ctx.reply as ReturnType<typeof vi.fn>);
  return (mock.mock.calls[0]?.[0] as string) ?? '';
}

// ---------------------------------------------------------------------------
// Tests: group chat redirect
// ---------------------------------------------------------------------------

describe('/scheduled in group chat → DM-only redirect', () => {
  it('replies with DM redirect and returns', async () => {
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled', 'supergroup');
    const { deps } = makeDeps();
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('DM');
  });
});

// ---------------------------------------------------------------------------
// Tests: bare /scheduled (list own tasks)
// ---------------------------------------------------------------------------

describe('/scheduled bare — list own tasks', () => {
  it('no tasks → "no scheduled tasks yet" message', async () => {
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled');
    const { deps } = makeDeps();
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('no scheduled tasks');
  });

  it('3 tasks owned by caller → renders list with all 3', async () => {
    const tasks = [
      makeTask({ id: 1, description: 'task one', owner_user_id: OWNER_USER_ID }),
      makeTask({ id: 2, description: 'task two', owner_user_id: OWNER_USER_ID }),
      makeTask({ id: 3, description: 'task three', owner_user_id: OWNER_USER_ID }),
    ];
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled');
    const { deps } = makeDeps(tasks);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    expect(reply).toContain('task one');
    expect(reply).toContain('task two');
    expect(reply).toContain('task three');
  });

  it('tasks owned by other user not included in bare listing', async () => {
    const tasks = [
      makeTask({ id: 1, description: 'my task', owner_user_id: OWNER_USER_ID }),
      makeTask({ id: 2, description: 'their task', owner_user_id: OTHER_USER_ID }),
    ];
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled');
    const { deps } = makeDeps(tasks);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    expect(reply).toContain('my task');
    expect(reply).not.toContain('their task');
  });
});

// ---------------------------------------------------------------------------
// Tests: pagination
// ---------------------------------------------------------------------------

describe('/scheduled list pagination', () => {
  it('25 tasks: page 1 shows 20, page hint shown', async () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      makeTask({ id: i + 1, description: `task ${i + 1}`, owner_user_id: OWNER_USER_ID }),
    );
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled');
    const { deps } = makeDeps(tasks);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    // Page 1 of 2, total 25
    expect(reply).toContain('page 1 of 2');
    expect(reply).toContain('total 25');
  });

  it('25 tasks: page 2 shows remaining 5', async () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      makeTask({ id: i + 1, description: `task ${i + 1}`, owner_user_id: OWNER_USER_ID }),
    );
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled list page 2');
    const { deps } = makeDeps(tasks);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    // task 21 through 25 should appear; task 1 should not
    expect(reply).toContain('task 21');
    expect(reply).toContain('task 25');
    expect(reply).not.toContain('task 1</');
  });
});

// ---------------------------------------------------------------------------
// Tests: /scheduled list all (admin-only)
// ---------------------------------------------------------------------------

describe('/scheduled list all', () => {
  it('admin → shows all tasks including orphans', async () => {
    const tasks = [
      makeTask({ id: 1, description: 'owned', owner_user_id: OWNER_USER_ID }),
      makeTask({ id: 2, description: 'orphan', owner_user_id: null }),
    ];
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled list all');
    const { deps } = makeDeps(tasks);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    expect(reply).toContain('owned');
    expect(reply).toContain('orphan');
    // Orphan should be labeled
    expect(reply).toContain('[orphan]');
  });

  it('non-admin → "Admin only."', async () => {
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled list all');
    const { deps } = makeDeps();
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toBe('Admin only.');
  });
});

// ---------------------------------------------------------------------------
// Tests: /scheduled show
// ---------------------------------------------------------------------------

describe('/scheduled show', () => {
  it('owner can view own task', async () => {
    const task = makeTask({ id: 5, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled show 5');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    expect(reply).toContain('morning goals');
    expect(reply).toContain('0 8 * * *');
  });

  it('admin can view any task', async () => {
    const task = makeTask({ id: 5, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled show 5');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('morning goals');
  });

  it('non-owner non-admin → "not your task"', async () => {
    const task = makeTask({ id: 5, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OTHER_USER_ID, '/scheduled show 5');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('You can only manage tasks');
  });

  it('NULL-owner task → admin can view', async () => {
    const task = makeTask({ id: 7, owner_user_id: null });
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled show 7');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('[orphan');
  });

  it('NULL-owner task → non-admin cannot view', async () => {
    const task = makeTask({ id: 7, owner_user_id: null });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled show 7');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('no owner');
  });

  it('task not found → "No task with id"', async () => {
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled show 999');
    const { deps } = makeDeps([]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('No task with id 999');
  });
});

// ---------------------------------------------------------------------------
// Tests: /scheduled pause
// ---------------------------------------------------------------------------

describe('/scheduled pause', () => {
  it('owner can pause own task → setStatus called, audit emitted, reload called', async () => {
    const task = makeTask({ id: 10, owner_user_id: OWNER_USER_ID, status: 'active' });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled pause 10');
    const { deps, auditRows, reloadFn } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    expect(getReply(ctx)).toContain('Paused');
    const pauseAudit = auditRows.find((r) => r.category === 'scheduler.pause');
    expect(pauseAudit).toBeDefined();
    expect(pauseAudit?.actor_user_id).toBe(OWNER_USER_ID);
    expect(reloadFn).toHaveBeenCalledOnce();
  });

  it('non-owner non-admin → rejected', async () => {
    const task = makeTask({ id: 10, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OTHER_USER_ID, '/scheduled pause 10');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('You can only manage tasks');
  });

  it('admin can pause any task', async () => {
    const task = makeTask({ id: 10, owner_user_id: OWNER_USER_ID, status: 'active' });
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled pause 10');
    const { deps, auditRows } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    const audit = auditRows.find((r) => r.category === 'scheduler.pause');
    expect(audit?.detail.adminOverride).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: /scheduled resume
// ---------------------------------------------------------------------------

describe('/scheduled resume', () => {
  it('owner resumes own paused task', async () => {
    const task = makeTask({ id: 20, owner_user_id: OWNER_USER_ID, status: 'paused' });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled resume 20');
    const { deps, auditRows, reloadFn } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    expect(getReply(ctx)).toContain('Resumed');
    const resumeAudit = auditRows.find((r) => r.category === 'scheduler.resume');
    expect(resumeAudit).toBeDefined();
    expect(reloadFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests: /scheduled delete
// ---------------------------------------------------------------------------

describe('/scheduled delete', () => {
  it('without CONFIRM → shows preview with CONFIRM instructions', async () => {
    const task = makeTask({ id: 30, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled delete 30');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    const reply = getReply(ctx);
    expect(reply).toContain('Delete scheduled task 30');
    expect(reply).toContain('CONFIRM');
    // Should NOT have deleted
    expect((deps.memory.scheduledTasks.remove as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('with CONFIRM by owner → removes task, emits audit, calls reload', async () => {
    const task = makeTask({ id: 30, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled delete 30 CONFIRM');
    const { deps, auditRows, reloadFn } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    expect(getReply(ctx)).toContain('Deleted task 30');
    expect((deps.memory.scheduledTasks.remove as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(30);

    const deleteAudit = auditRows.find((r) => r.category === 'scheduler.delete');
    expect(deleteAudit).toBeDefined();
    expect(deleteAudit?.actor_user_id).toBe(OWNER_USER_ID);
    expect(reloadFn).toHaveBeenCalledOnce();
  });

  it('non-owner cannot delete another users task', async () => {
    const task = makeTask({ id: 30, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OTHER_USER_ID, '/scheduled delete 30 CONFIRM');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('You can only manage tasks');
    expect((deps.memory.scheduledTasks.remove as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('admin can delete any task with CONFIRM → adminOverride:true in audit', async () => {
    const task = makeTask({ id: 30, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled delete 30 CONFIRM');
    const { deps, auditRows } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    const audit = auditRows.find((r) => r.category === 'scheduler.delete');
    expect(audit?.detail.adminOverride).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: /scheduled claim
// ---------------------------------------------------------------------------

describe('/scheduled claim', () => {
  it('admin claims NULL-owner task → new task inserted, old removed', async () => {
    const task = makeTask({ id: 50, owner_user_id: null });
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled claim 50');
    const { deps, auditRows } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    const reply = getReply(ctx);
    expect(reply).toContain('Claimed');
    expect(reply).toContain('50');
    expect((deps.memory.scheduledTasks.remove as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(50);
    expect((deps.memory.scheduledTasks.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ owner_user_id: ADMIN_USER_ID }),
    );

    const audit = auditRows.find((r) => r.category === 'scheduler.policy');
    expect(audit).toBeDefined();
    expect(audit?.detail.event).toBe('claim_orphan');
  });

  it('admin claims already-owned task → rejected', async () => {
    const task = makeTask({ id: 51, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(ADMIN_USER_ID, '/scheduled claim 51');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);

    const reply = getReply(ctx);
    expect(reply).toContain('already has an owner');
    expect((deps.memory.scheduledTasks.remove as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('non-admin cannot claim → Admin only.', async () => {
    const task = makeTask({ id: 52, owner_user_id: null });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled claim 52');
    const { deps } = makeDeps([task]);
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toBe('Admin only.');
  });
});

// ---------------------------------------------------------------------------
// Tests: edge cases
// ---------------------------------------------------------------------------

describe('/scheduled edge cases', () => {
  it('unknown subcommand → usage message', async () => {
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled frobble');
    const { deps } = makeDeps();
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('Usage:');
  });

  it('schedulerApi null → pause works without crash', async () => {
    const task = makeTask({ id: 60, owner_user_id: OWNER_USER_ID });
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled pause 60');
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [ADMIN_USER_ID] } });
    const { memory } = makeMem([task]);
    const deps: ScheduledCommandDeps = { config: cfg, memory, schedulerApi: null };
    await handleScheduled(ctx, deps);
    expect(getReply(ctx)).toContain('Paused');
  });

  it('status emoji: active=🟢, paused=⏸️', async () => {
    const tasks = [
      makeTask({ id: 1, description: 'active task', owner_user_id: OWNER_USER_ID, status: 'active' }),
      makeTask({ id: 2, description: 'paused task', owner_user_id: OWNER_USER_ID, status: 'paused' }),
    ];
    const ctx = makeCtx(OWNER_USER_ID, '/scheduled');
    const { deps } = makeDeps(tasks);
    await handleScheduled(ctx, deps);
    const reply = getReply(ctx);
    expect(reply).toContain('🟢');
    expect(reply).toContain('⏸️');
  });
});
