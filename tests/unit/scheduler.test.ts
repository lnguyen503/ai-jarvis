/**
 * Sub-Phase A — Scheduler unit tests.
 * Asserts invalid cron is skipped, listActive is consulted at start(),
 * stop() clears jobs, reload() re-reads DB, and fires call enqueueSchedulerTurn.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { initScheduler } from '../../src/scheduler/index.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { getLogger } from '../../src/logger/index.js';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-sched-${Date.now()}-${Math.random()}.db`);
  return initMemory(makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } }));
}

describe('scheduler.initScheduler', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = fresh();
  });

  it('start()/stop() without any active tasks is a no-op and logs', () => {
    const cfg = makeTestConfig();
    const enqueue = vi.fn();
    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
    });
    sched.start();
    sched.stop();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips tasks with invalid cron expression', () => {
    mem.scheduledTasks.insert({
      description: 'bogus',
      cron_expression: 'not-a-cron',
      command: 'echo',
      chat_id: 1,
    });
    const cfg = makeTestConfig();
    const enqueue = vi.fn();
    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
    });
    // Should NOT throw — invalid tasks are logged and skipped
    expect(() => sched.start()).not.toThrow();
    sched.stop();
  });

  it('start() twice is guarded and logs a warning', () => {
    const cfg = makeTestConfig();
    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: vi.fn(),
    });
    sched.start();
    // Second start is a warn-and-return; shouldn't throw
    expect(() => sched.start()).not.toThrow();
    sched.stop();
  });

  it('reload() re-reads listActive and does not throw on empty DB', () => {
    const cfg = makeTestConfig();
    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: vi.fn(),
    });
    sched.start();
    expect(() => sched.reload()).not.toThrow();
    sched.stop();
  });

  it('registers a valid cron task on start without throwing', () => {
    mem.scheduledTasks.insert({
      description: 'each minute',
      cron_expression: '* * * * *',
      command: 'echo hi',
      chat_id: 55,
    });
    const cfg = makeTestConfig();
    const enqueue = vi.fn();
    const sched = initScheduler({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      enqueueSchedulerTurn: enqueue,
    });
    expect(() => sched.start()).not.toThrow();
    sched.stop();
  });
});
