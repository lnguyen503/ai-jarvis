/**
 * Integration tests: scheduler ${coach_prompt} expansion + load-fail DM (ADR 018 commit 6).
 *
 * Tests:
 *   1. Coach task with ${coach_prompt} fires → expanded → agent turn enqueued with full prompt + coachTurnCounters
 *   2. Non-coach task without placeholder → unchanged input (no-op expansion)
 *   3. Coach task fires when coachPrompt.md is missing → audit row emitted + DM sent
 *   4. Second failure within 24h → audit row emitted but NO DM (dedup)
 *   5. Audit row category is coach.prompt_load_failed
 *   6. Non-coach task (no placeholder) → no coachTurnCounters in enqueue
 *   7. _fireTaskForTests returns false for unknown taskId
 *   8. Coach task with coachTurnCounters: {nudges:0, writes:0} populated
 *   9. Owner not in allowlist still blocks fire (existing R2 behavior preserved)
 *  10. Non-coach task with non-placeholder command → unchanged command in enqueue
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initScheduler } from '../../src/scheduler/index.js';
import { getLogger } from '../../src/logger/index.js';
import { COACH_TASK_DESCRIPTION, COACH_PROMPT_PLACEHOLDER } from '../../src/coach/index.js';
import * as coachIndex from '../../src/coach/index.js';

function freshDb(): MemoryApi {
  _resetDb();
  const dbPath = path.join(
    os.tmpdir(),
    `jarvis-coach-sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  return initMemory(makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } }));
}

function makeMessagingAdapter() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 999 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ messageId: 999 }),
    sendPhoto: vi.fn().mockResolvedValue({ messageId: 999 }),
    sendVoice: vi.fn().mockResolvedValue({ messageId: 999 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    resolveDmChatId: vi.fn().mockReturnValue(12345),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    sendWebAppButton: vi.fn().mockResolvedValue({ messageId: 999 }),
  };
}

describe('scheduler: ${coach_prompt} expansion + load-fail DM (commit 6)', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = freshDb();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. coach task with ${coach_prompt} fires → expanded command + coachTurnCounters in enqueue', () => {
    const cfg = makeTestConfig();
    const capturedParams: Parameters<Parameters<typeof initScheduler>[0]['enqueueSchedulerTurn']>[0][] = [];
    const enqueue = vi.fn((params) => { capturedParams.push(params); });

    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: COACH_PROMPT_PLACEHOLDER,
      chat_id: 12345,
      owner_user_id: 12345,
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

    expect(enqueue).toHaveBeenCalledOnce();
    const p = capturedParams[0]!;
    // Command must be expanded (not the raw placeholder)
    expect(p.command).not.toBe(COACH_PROMPT_PLACEHOLDER);
    expect(p.command.length).toBeGreaterThan(0);
    // coachTurnCounters must be present for coach tasks
    expect(p.coachTurnCounters).toEqual({ nudges: 0, writes: 0 });
  });

  it('2. non-coach task without placeholder → unchanged command, no coachTurnCounters', () => {
    const cfg = makeTestConfig();
    const capturedParams: Parameters<Parameters<typeof initScheduler>[0]['enqueueSchedulerTurn']>[0][] = [];
    const enqueue = vi.fn((params) => { capturedParams.push(params); });

    const taskId = mem.scheduledTasks.insert({
      description: 'check email',
      cron_expression: '0 9 * * *',
      command: 'show me my emails',
      chat_id: 12345,
      owner_user_id: 12345,
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

    expect(enqueue).toHaveBeenCalledOnce();
    const p = capturedParams[0]!;
    expect(p.command).toBe('show me my emails');
    // Non-coach task: no coachTurnCounters
    expect(p.coachTurnCounters).toBeUndefined();
  });

  it('3. coach task fires when coachPrompt.md is missing → audit row + DM sent', async () => {
    // Mock expandCoachPromptToken to throw (simulates missing dist/coach/coachPrompt.md)
    vi.spyOn(coachIndex, 'expandCoachPromptToken').mockImplementation((cmd: string) => {
      if (cmd.includes(COACH_PROMPT_PLACEHOLDER)) {
        throw new Error('ENOENT: no such file or directory');
      }
      return cmd;
    });

    const cfg = makeTestConfig();
    const adapter = makeMessagingAdapter();
    const enqueue = vi.fn();

    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: COACH_PROMPT_PLACEHOLDER,
      chat_id: 12345,
      owner_user_id: 12345,
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
    sched.stop();

    // Turn must NOT be enqueued
    expect(enqueue).not.toHaveBeenCalled();

    // Audit row must be emitted with correct category
    const auditRows = mem.auditLog.listByCategory('coach.prompt_load_failed');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.category).toBe('coach.prompt_load_failed');

    // Allow async DM send to settle
    await vi.runAllTimersAsync().catch(() => {});
    // DM must have been sent
    expect(adapter.sendMessage).toHaveBeenCalled();
  });

  it('4. second failure within 24h → audit row emitted but NO second DM (dedup)', async () => {
    vi.spyOn(coachIndex, 'expandCoachPromptToken').mockImplementation((cmd: string) => {
      if (cmd.includes(COACH_PROMPT_PLACEHOLDER)) {
        throw new Error('ENOENT: no such file or directory');
      }
      return cmd;
    });

    const cfg = makeTestConfig();
    const adapter = makeMessagingAdapter();
    const enqueue = vi.fn();

    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: COACH_PROMPT_PLACEHOLDER,
      chat_id: 12345,
      owner_user_id: 12345,
    });

    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
      messagingAdapter: adapter,
    });
    sched.start();
    // First fire: DM sent
    sched._fireTaskForTests(taskId);
    await vi.runAllTimersAsync().catch(() => {});

    // Second fire within 24h: audit row but no second DM
    sched._fireTaskForTests(taskId);
    await vi.runAllTimersAsync().catch(() => {});
    sched.stop();

    // Both fires audit
    const auditRows = mem.auditLog.listByCategory('coach.prompt_load_failed');
    expect(auditRows.length).toBeGreaterThanOrEqual(2);

    // DM sent only once (dedup)
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('5. audit row category is coach.prompt_load_failed', () => {
    vi.spyOn(coachIndex, 'expandCoachPromptToken').mockImplementation((cmd: string) => {
      if (cmd.includes(COACH_PROMPT_PLACEHOLDER)) {
        throw new Error('ENOENT: missing');
      }
      return cmd;
    });

    const cfg = makeTestConfig();
    const enqueue = vi.fn();

    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: COACH_PROMPT_PLACEHOLDER,
      chat_id: 12345,
      owner_user_id: 12345,
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

    const auditRows = mem.auditLog.listByCategory('coach.prompt_load_failed');
    expect(auditRows[0]!.category).toBe('coach.prompt_load_failed');
    const detail = JSON.parse(auditRows[0]!.detail_json);
    expect(detail).toMatchObject({ taskId, ownerUserId: 12345 });
  });

  it('6. coach task → coachTurnCounters has nudges:0 and writes:0', () => {
    const cfg = makeTestConfig();
    const capturedParams: Parameters<Parameters<typeof initScheduler>[0]['enqueueSchedulerTurn']>[0][] = [];
    const enqueue = vi.fn((params) => { capturedParams.push(params); });

    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: COACH_PROMPT_PLACEHOLDER,
      chat_id: 12345,
      owner_user_id: 12345,
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

    expect(capturedParams[0]!.coachTurnCounters).toEqual({ nudges: 0, writes: 0 });
  });

  it('7. _fireTaskForTests returns false for unknown taskId', () => {
    const cfg = makeTestConfig();
    const enqueue = vi.fn();

    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
    });
    sched.start();
    const result = sched._fireTaskForTests(999999);
    sched.stop();

    expect(result).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('8. non-coach task with description matching __coach__ still gets coachTurnCounters', () => {
    // Verify description sentinel drives the coachTurnCounters flag
    const cfg = makeTestConfig();
    const capturedParams: Parameters<Parameters<typeof initScheduler>[0]['enqueueSchedulerTurn']>[0][] = [];
    const enqueue = vi.fn((params) => { capturedParams.push(params); });

    // This task has COACH_TASK_DESCRIPTION but a different command (no placeholder)
    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: 'some other command',
      chat_id: 12345,
      owner_user_id: 12345,
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

    expect(enqueue).toHaveBeenCalledOnce();
    // description === COACH_TASK_DESCRIPTION → coachTurnCounters present
    expect(capturedParams[0]!.coachTurnCounters).toEqual({ nudges: 0, writes: 0 });
  });

  it('9. owner not in allowlist → fire blocked (existing R2 behavior preserved)', () => {
    const cfg = makeTestConfig(); // allowedUserIds: [12345]
    const enqueue = vi.fn();

    // Insert coach task for a user NOT in the allowlist
    const taskId = mem.scheduledTasks.insert({
      description: COACH_TASK_DESCRIPTION,
      cron_expression: '0 8 * * *',
      command: COACH_PROMPT_PLACEHOLDER,
      chat_id: 99999,
      owner_user_id: 99999, // not in allowedUserIds
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

    // R2 allowlist check should block before expansion
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('10. non-coach task with literal command → command unchanged in enqueue', () => {
    const cfg = makeTestConfig();
    const capturedParams: Parameters<Parameters<typeof initScheduler>[0]['enqueueSchedulerTurn']>[0][] = [];
    const enqueue = vi.fn((params) => { capturedParams.push(params); });

    const taskId = mem.scheduledTasks.insert({
      description: 'morning brief',
      cron_expression: '0 7 * * *',
      command: 'give me a morning summary',
      chat_id: 12345,
      owner_user_id: 12345,
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

    expect(capturedParams[0]!.command).toBe('give me a morning summary');
  });
});
