/**
 * Tests for v1.10.0 Item 3 — scheduler owner_user_id plumbing.
 *
 * Covers:
 *   - Migration 009 idempotency (run twice → no error, column present)
 *   - ScheduledTasksRepo: insert with owner, listByOwner, listAll, get
 *   - Fire-time allowlist re-check: owner ∈ allowlist → enqueue called
 *   - Fire-time allowlist re-check: owner ∉ allowlist → skip + audit + DM
 *   - NULL owner (legacy) → enqueue called, no allowlist check
 *   - resolveDmChatId returns null → DM skipped, warn, audit still fires
 *   - AuditCategory type includes all 5 new scheduler.* values
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initScheduler } from '../../src/scheduler/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AuditCategory } from '../../src/memory/auditLog.js';
import type { MessagingAdapter } from '../../src/messaging/adapter.js';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function freshDb(): MemoryApi {
  _resetDb();
  const dbPath = path.join(
    os.tmpdir(),
    `jarvis-ownertest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  return initMemory(makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } }));
}

/** Minimal mock MessagingAdapter for DM delivery assertions. */
function makeMockAdapter(dmChatId: number | null): MessagingAdapter & {
  sendMessageMock: ReturnType<typeof vi.fn>;
  resolveDmMock: ReturnType<typeof vi.fn>;
} {
  const sendMessageMock = vi.fn().mockResolvedValue({ messageId: 1 });
  const resolveDmMock = vi.fn().mockReturnValue(dmChatId);
  return {
    sendMessage: sendMessageMock,
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ messageId: 2 }),
    sendPhoto: vi.fn().mockResolvedValue({ messageId: 3 }),
    sendVoice: vi.fn().mockResolvedValue({ messageId: 4 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    resolveDmChatId: resolveDmMock,
    sendMessageMock,
    resolveDmMock,
  };
}

// ────────────────────────────────────────────────────────────────────
// Migration idempotency
// ────────────────────────────────────────────────────────────────────

describe('migration 009 — owner_user_id idempotency', () => {
  it('running migrations twice on a fresh DB does not throw', () => {
    // initMemory() runs all migrations internally; calling it twice on the
    // same file path exercises the schema_migrations guard.
    _resetDb();
    const dbPath = path.join(
      os.tmpdir(),
      `jarvis-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });

    // First open: runs all migrations including 009
    const mem1 = initMemory(cfg);
    mem1.close();
    _resetDb();

    // Second open: should detect 009 as already applied and skip it
    expect(() => {
      const mem2 = initMemory(cfg);
      mem2.close();
    }).not.toThrow();
  });

  it('owner_user_id column exists and accepts NULL after migration', () => {
    const mem = freshDb();
    const id = mem.scheduledTasks.insert({
      description: 'no owner',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 99,
      // intentionally omit owner_user_id → defaults NULL
    });
    const row = mem.scheduledTasks.get(id);
    expect(row).not.toBeNull();
    expect(row?.owner_user_id).toBeNull();
    mem.close();
    _resetDb();
  });
});

// ────────────────────────────────────────────────────────────────────
// ScheduledTasksRepo API
// ────────────────────────────────────────────────────────────────────

describe('scheduledTasksRepo — owner_user_id plumbing', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = freshDb();
  });

  it('insert with owner_user_id → get() returns the row with owner set', () => {
    const id = mem.scheduledTasks.insert({
      description: 'owned task',
      cron_expression: '0 8 * * *',
      command: 'echo hi',
      chat_id: 111,
      owner_user_id: 12345,
    });
    const row = mem.scheduledTasks.get(id);
    expect(row).not.toBeNull();
    expect(row?.owner_user_id).toBe(12345);
    expect(row?.chat_id).toBe(111);
    expect(row?.command).toBe('echo hi');
  });

  it('listByOwner returns only tasks belonging to that owner', () => {
    const idA = mem.scheduledTasks.insert({
      description: 'task for user 12345',
      cron_expression: '* * * * *',
      command: 'echo A',
      chat_id: 111,
      owner_user_id: 12345,
    });
    const idB = mem.scheduledTasks.insert({
      description: 'task for user 99999',
      cron_expression: '* * * * *',
      command: 'echo B',
      chat_id: 222,
      owner_user_id: 99999,
    });
    // deliberately suppress unused-var lint — we need idB for the setup
    void idB;

    const owned = mem.scheduledTasks.listByOwner(12345);
    expect(owned.length).toBe(1);
    expect(owned[0]!.id).toBe(idA);
  });

  it('listByOwner does NOT return NULL-owner tasks', () => {
    mem.scheduledTasks.insert({
      description: 'legacy task',
      cron_expression: '* * * * *',
      command: 'echo legacy',
      chat_id: 333,
      // no owner_user_id → NULL
    });
    const owned = mem.scheduledTasks.listByOwner(12345);
    expect(owned.length).toBe(0);
  });

  it('listAll returns ALL tasks including NULL-owner (orphan) rows', () => {
    mem.scheduledTasks.insert({
      description: 'owned',
      cron_expression: '* * * * *',
      command: 'echo owned',
      chat_id: 111,
      owner_user_id: 12345,
    });
    mem.scheduledTasks.insert({
      description: 'orphan',
      cron_expression: '* * * * *',
      command: 'echo orphan',
      chat_id: 222,
      // no owner → NULL
    });

    const all = mem.scheduledTasks.listAll();
    expect(all.length).toBe(2);
    expect(all.some((r) => r.owner_user_id === 12345)).toBe(true);
    expect(all.some((r) => r.owner_user_id === null)).toBe(true);
  });

  it('get(id) returns null for a non-existent id', () => {
    const row = mem.scheduledTasks.get(999999);
    expect(row).toBeNull();
  });

  it('insert without owner_user_id → listByOwner(any) does NOT return the row', () => {
    mem.scheduledTasks.insert({
      description: 'no owner',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 42,
    });
    expect(mem.scheduledTasks.listByOwner(12345)).toHaveLength(0);
    expect(mem.scheduledTasks.listByOwner(0)).toHaveLength(0);
  });

  it('listActive() includes owner_user_id in returned rows', () => {
    mem.scheduledTasks.insert({
      description: 'active owned',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 10,
      owner_user_id: 77777,
    });
    const active = mem.scheduledTasks.listActive();
    expect(active.length).toBe(1);
    // owner_user_id is returned because SELECT * includes the new column
    expect(active[0]!.owner_user_id).toBe(77777);
  });
});

// ────────────────────────────────────────────────────────────────────
// Fire-time allowlist re-check
// ────────────────────────────────────────────────────────────────────

describe('scheduler fire-time allowlist re-check', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = freshDb();
  });

  it('owner IN allowlist → enqueueSchedulerTurn called with ownerUserId populated, no audit row', () => {
    // v1.10.0 Phase-2 fix: these tests now use the REAL scheduler fire path
    // via `_fireTaskForTests`, not an inline re-implementation. Previous
    // version was false-green.
    const cfg = makeTestConfig(); // allowedUserIds: [12345]
    const enqueue = vi.fn();

    const taskId = mem.scheduledTasks.insert({
      description: 'owned active task',
      cron_expression: '* * * * *',
      command: 'echo hello',
      chat_id: 12345,
      owner_user_id: 12345, // in allowlist
    });

    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
    });
    sched.start();

    const fired = sched._fireTaskForTests(taskId);
    expect(fired).toBe(true);

    sched.stop();

    // enqueue was called with ownerUserId populated
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 12345,
        taskId,
        description: 'owned active task',
        command: 'echo hello',
        ownerUserId: 12345,
      }),
    );

    // No scheduler.policy audit rows (nothing was dropped)
    const auditRows = mem.auditLog.listRecent(50);
    expect(auditRows.filter((r) => r.category === 'scheduler.policy')).toHaveLength(0);
  });

  it('owner NOT IN allowlist → enqueue NOT called, scheduler.policy audit emitted, DM sent via resolveDmChatId', async () => {
    const DROPPED_OWNER = 99999; // NOT in default allowedUserIds [12345]
    const cfg = makeTestConfig(); // allowedUserIds: [12345]
    const enqueue = vi.fn();
    const adapter = makeMockAdapter(DROPPED_OWNER); // resolveDmChatId returns DROPPED_OWNER

    const taskId = mem.scheduledTasks.insert({
      description: 'task by dropped user',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 9000, // group chat (where the task was originally scheduled)
      owner_user_id: DROPPED_OWNER,
    });

    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
      messagingAdapter: adapter,
    });
    sched.start();

    const fired = sched._fireTaskForTests(taskId);
    expect(fired).toBe(true);

    // Wait a tick for the fire-and-forget DM promise to resolve
    await new Promise((r) => setImmediate(r));

    sched.stop();

    // Enqueue was NOT called — task was dropped before enqueue
    expect(enqueue).not.toHaveBeenCalled();

    // Audit row emitted with correct shape
    const auditRows = mem.auditLog.listRecent(50);
    const policyRows = auditRows.filter((r) => r.category === 'scheduler.policy');
    expect(policyRows).toHaveLength(1);

    const policyRow = policyRows[0]!;
    expect(policyRow.actor_user_id).toBeNull(); // system-originated, NOT the dropped user
    const detail = JSON.parse(policyRow.detail_json) as Record<string, unknown>;
    expect(detail['event']).toBe('drop_unauthorized_owner');
    expect(detail['ownerUserId']).toBe(DROPPED_OWNER);
    expect(detail['taskId']).toBe(taskId);
    expect(detail['reason']).toBe('owner_not_in_allowlist');

    // DM was routed via resolveDmChatId(DROPPED_OWNER) — NOT to task.chat_id (9000 group)
    expect(adapter.resolveDmMock).toHaveBeenCalledWith(DROPPED_OWNER);
    expect(adapter.sendMessageMock).toHaveBeenCalledTimes(1);
    const [dmChatId, dmBody] = adapter.sendMessageMock.mock.calls[0]!;
    expect(dmChatId).toBe(DROPPED_OWNER); // DM id, not the group id 9000
    expect(dmBody).toContain('skipped');
    // CRITICAL: DM must NEVER go to the task's chat_id if it's a group.
    expect(adapter.sendMessageMock).not.toHaveBeenCalledWith(9000, expect.anything());
  });

  it('NULL owner (legacy task) → enqueue fires normally, no allowlist check, no audit row', () => {
    const cfg = makeTestConfig();
    const enqueue = vi.fn();

    const taskId = mem.scheduledTasks.insert({
      description: 'legacy no-owner task',
      cron_expression: '* * * * *',
      command: 'echo legacy',
      chat_id: 5555,
      owner_user_id: null,
    });

    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
    });
    sched.start();
    sched._fireTaskForTests(taskId);
    sched.stop();

    // Normal fire — enqueue called with ownerUserId: null (legacy pass-through)
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 5555,
        ownerUserId: null,
      }),
    );

    // No scheduler.policy rows (NULL owner skips the allowlist check entirely)
    const auditRows = mem.auditLog.listRecent(50);
    expect(auditRows.filter((r) => r.category === 'scheduler.policy')).toHaveLength(0);
  });

  it('resolveDmChatId returns null → DM skipped but audit row still emitted', async () => {
    const DROPPED_OWNER = 88888;
    const cfg = makeTestConfig(); // allowedUserIds: [12345]
    const enqueue = vi.fn();
    const adapter = makeMockAdapter(null); // resolveDmChatId returns null — no DM surface

    const taskId = mem.scheduledTasks.insert({
      description: 'orphan dm task',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 8888,
      owner_user_id: DROPPED_OWNER,
    });

    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
      messagingAdapter: adapter,
    });
    sched.start();
    sched._fireTaskForTests(taskId);
    await new Promise((r) => setImmediate(r));
    sched.stop();

    // Audit row still emitted
    const auditRows = mem.auditLog.listRecent(50);
    expect(auditRows.filter((r) => r.category === 'scheduler.policy')).toHaveLength(1);

    // DM NOT sent because resolveDmChatId returned null
    expect(adapter.sendMessageMock).not.toHaveBeenCalled();
    // Still no enqueue (dropped path)
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// AuditCategory type-level check (compile-time + runtime)
// ────────────────────────────────────────────────────────────────────

describe('AuditCategory — scheduler.* values present', () => {
  it('all 5 new scheduler audit categories are valid AuditCategory values', () => {
    // Type-level: if these assignments compile, the union includes the values.
    const _policy: AuditCategory = 'scheduler.policy';
    const _create: AuditCategory = 'scheduler.create';
    const _pause: AuditCategory = 'scheduler.pause';
    const _resume: AuditCategory = 'scheduler.resume';
    const _delete: AuditCategory = 'scheduler.delete';

    // Runtime check: insert a row for each to confirm the DB CHECK constraint accepts them.
    const mem = freshDb();
    const categories: AuditCategory[] = [
      'scheduler.policy',
      'scheduler.create',
      'scheduler.pause',
      'scheduler.resume',
      'scheduler.delete',
    ];
    for (const category of categories) {
      expect(() =>
        mem.auditLog.insert({
          category,
          actor_user_id: null,
          detail: { test: category },
        }),
      ).not.toThrow();
    }
    mem.close();
    _resetDb();

    // Use variables to satisfy no-unused-vars (assignments are the test)
    void _policy; void _create; void _pause; void _resume; void _delete;
  });
});
