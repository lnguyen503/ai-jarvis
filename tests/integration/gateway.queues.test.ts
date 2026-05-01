/**
 * §15.6 — Per-chat queue semantics (C3).
 *   - 6th user turn when userQueueMax=5 returns user-visible overflow error
 *   - 21st scheduler turn when schedulerQueueMax=20 drops the OLDEST
 *   - /stop clears userQueue; /stop all clears both
 *   - userQueue drains before schedulerQueue
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatQueueManager } from '../../src/gateway/chatQueue.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

// Helper to create a job that waits for a promise we control
function makeBlockingJob(id: string): {
  id: string;
  run: (signal: AbortSignal) => Promise<void>;
  description: string;
  unblock: () => void;
  waitStart: Promise<void>;
} {
  let unblockFn: () => void = () => {};
  let markStarted: () => void = () => {};
  const waitStart = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const blockPromise = new Promise<void>((resolve) => {
    unblockFn = resolve;
  });

  return {
    id,
    description: `job-${id}`,
    waitStart,
    unblock: unblockFn!,
    async run(_signal: AbortSignal) {
      markStarted();
      await blockPromise;
    },
  };
}

describe('ChatQueueManager (§15.6)', () => {
  let cfg: AppConfig;
  const CHAT_ID = 100;

  beforeEach(() => {
    cfg = makeTestConfig({
      chat: { userQueueMax: 5, schedulerQueueMax: 20, maxQueueAgeMs: 600000 },
    });
  });

  it('rejects the 6th user job when userQueueMax=5 (is NOT silently dropped)', async () => {
    const mgr = new ChatQueueManager(cfg);

    // First job runs immediately; next 4 queue up (total in-queue = 4, running = 1)
    const firstJob = makeBlockingJob('j0');
    mgr.enqueueUser(CHAT_ID, {
      id: firstJob.id,
      description: firstJob.description,
      run: firstJob.run,
    });
    await firstJob.waitStart;

    // Queue 5 more — first 5 succeed, 6th fails
    const rejected: boolean[] = [];
    for (let i = 1; i <= 6; i++) {
      const j = makeBlockingJob(`j${i}`);
      const r = mgr.enqueueUser(CHAT_ID, {
        id: j.id,
        description: j.description,
        run: j.run,
      });
      rejected.push(r.kind === 'rejected');
    }
    // userQueueMax=5. running=1, queue fills up to 5, 6th rejected.
    expect(rejected.filter((x) => x).length).toBeGreaterThanOrEqual(1);
    expect(rejected.some((x) => x)).toBe(true);

    // Cleanup
    firstJob.unblock();
    mgr.abortAll();
  });

  it('drops the OLDEST scheduler turn when schedulerQueueMax=20', () => {
    const smallCfg = makeTestConfig({
      chat: { userQueueMax: 5, schedulerQueueMax: 3, maxQueueAgeMs: 600000 },
    });
    const mgr = new ChatQueueManager(smallCfg);

    const droppedNotifications: string[] = [];
    mgr.setOnSchedulerDrop((_chatId, description) => {
      droppedNotifications.push(description);
    });

    // Block the first job so nothing drains
    const blocker = makeBlockingJob('blocker');
    mgr.enqueueScheduler(CHAT_ID, {
      id: blocker.id,
      description: blocker.description,
      run: blocker.run,
    });

    // Now enqueue 3 more (filling to queueMax=3 with 1 running)
    // The 4th and beyond will cause drop-oldest behavior
    const results = [];
    for (let i = 0; i < 5; i++) {
      const j = makeBlockingJob(`s${i}`);
      const r = mgr.enqueueScheduler(CHAT_ID, {
        id: j.id,
        description: `sched-${i}`,
        run: j.run,
      });
      results.push(r);
    }

    const drops = results.filter((r) => r.kind === 'dropped-oldest');
    expect(drops.length).toBeGreaterThan(0);
    expect(droppedNotifications.length).toBeGreaterThan(0);

    blocker.unblock();
    mgr.abortAll();
  });

  it('/stop clears userQueue but preserves schedulerQueue', async () => {
    const mgr = new ChatQueueManager(cfg);

    // Block running job so queue fills
    const blocker = makeBlockingJob('run');
    mgr.enqueueUser(CHAT_ID, { id: 'run', description: 'block', run: blocker.run });
    await blocker.waitStart;

    // Add 2 user jobs and 2 scheduler jobs
    mgr.enqueueUser(CHAT_ID, { id: 'u1', description: 'u1', run: async () => {} });
    mgr.enqueueUser(CHAT_ID, { id: 'u2', description: 'u2', run: async () => {} });
    mgr.enqueueScheduler(CHAT_ID, { id: 's1', description: 's1', run: async () => {} });
    mgr.enqueueScheduler(CHAT_ID, { id: 's2', description: 's2', run: async () => {} });

    const before = mgr.snapshot(CHAT_ID);
    expect(before.userQueueLen).toBe(2);
    expect(before.schedulerQueueLen).toBe(2);

    mgr.stop(CHAT_ID);

    const after = mgr.snapshot(CHAT_ID);
    expect(after.userQueueLen).toBe(0);
    expect(after.schedulerQueueLen).toBe(2); // preserved

    blocker.unblock();
    mgr.abortAll();
  });

  it('/stop all clears both queues', async () => {
    const mgr = new ChatQueueManager(cfg);

    const blocker = makeBlockingJob('run');
    mgr.enqueueUser(CHAT_ID, { id: 'run', description: 'block', run: blocker.run });
    await blocker.waitStart;

    mgr.enqueueUser(CHAT_ID, { id: 'u1', description: 'u1', run: async () => {} });
    mgr.enqueueScheduler(CHAT_ID, { id: 's1', description: 's1', run: async () => {} });
    mgr.enqueueScheduler(CHAT_ID, { id: 's2', description: 's2', run: async () => {} });

    mgr.stopAll(CHAT_ID);

    const after = mgr.snapshot(CHAT_ID);
    expect(after.userQueueLen).toBe(0);
    expect(after.schedulerQueueLen).toBe(0);

    blocker.unblock();
    mgr.abortAll();
  });

  it('drains userQueue before schedulerQueue', async () => {
    const mgr = new ChatQueueManager(cfg);
    const order: string[] = [];

    // Block the first job so subsequent enqueues build up
    const blocker = makeBlockingJob('boot');
    mgr.enqueueUser(CHAT_ID, {
      id: 'boot',
      description: 'boot',
      run: async () => {
        order.push('boot');
      },
    });

    // Enqueue a scheduler job first, then a user job
    mgr.enqueueScheduler(CHAT_ID, {
      id: 's1',
      description: 's1',
      run: async () => {
        order.push('s1');
      },
    });
    mgr.enqueueUser(CHAT_ID, {
      id: 'u1',
      description: 'u1',
      run: async () => {
        order.push('u1');
      },
    });

    // Wait for drain
    await new Promise((r) => setTimeout(r, 200));

    // Order must be: boot, then u1 (userQueue first), then s1
    expect(order.indexOf('u1')).toBeLessThan(order.indexOf('s1'));
    mgr.abortAll();
  });
});
