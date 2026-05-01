/**
 * F-05: Integration tests for gateway/commands.ts
 * Uses hand-rolled minimal grammY Context mocks — no real bot token needed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleStart,
  handleStatus,
  handleStop,
  handleHelp,
  handleProjects,
  handleHistory,
  handleClear,
  type CommandDeps,
} from '../../src/gateway/commands.js';
import type { Context } from 'grammy';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { ChatQueueManager } from '../../src/gateway/chatQueue.js';
import { getLogger } from '../../src/logger/index.js';

function makeMockCtx(overrides: Partial<{
  chatId: number;
  text: string;
  fromId: number;
}> = {}): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const chatId = overrides.chatId ?? 42;
  const text = overrides.text ?? '';

  const ctx = {
    chat: { id: chatId },
    from: { id: overrides.fromId ?? 12345 },
    message: { text, voice: undefined, audio: undefined },
    reply: vi.fn(async (msg: string) => {
      replies.push(msg);
    }),
  } as unknown as Context;

  return { ctx, replies };
}

function makeDeps(chatId = 42) {
  _resetDb();
  const cfg = makeTestConfig();
  const mem = initMemory(cfg);
  const queueManager = new ChatQueueManager(cfg, getLogger());
  const deps: CommandDeps = {
    config: cfg,
    memory: mem,
    queueManager,
    processStart: Date.now() - 5000,
    version: '1.0.0',
  };
  return { deps, mem, queueManager, cfg };
}

describe('gateway/commands.ts', () => {
  it('handleStart replies with Jarvis online message', async () => {
    const { deps } = makeDeps();
    const { ctx, replies } = makeMockCtx();
    await handleStart(ctx, deps);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/Jarvis online/i);
    expect(replies[0]).toMatch(/run_command/);
  });

  it('handleHelp replies with command list', async () => {
    const { deps } = makeDeps();
    const { ctx, replies } = makeMockCtx();
    await handleHelp(ctx, deps);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/\/status/);
    expect(replies[0]).toMatch(/\/stop/);
    expect(replies[0]).toMatch(/\/projects/);
  });

  it('handleStatus replies with uptime and memory info', async () => {
    const { deps } = makeDeps();
    const { ctx, replies } = makeMockCtx();
    await handleStatus(ctx, deps);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/uptime/i);
    expect(replies[0]).toMatch(/memory/i);
  });

  it('handleStop replies with stopped count and preserves scheduler queue', async () => {
    const { deps, queueManager } = makeDeps();
    const chatId = 42;
    // Add two pending scheduler jobs — the first will start running (drains immediately),
    // the second stays in the queue so we can verify it is preserved.
    queueManager.enqueueScheduler(chatId, {
      id: 'sched-1',
      description: 'running task',
      run: async () => { await new Promise(() => {}); }, // never resolves (stays active)
    });
    queueManager.enqueueScheduler(chatId, {
      id: 'sched-2',
      description: 'queued task',
      run: async () => { await new Promise(() => {}); },
    });
    const { ctx, replies } = makeMockCtx({ chatId, text: '/stop' });
    await handleStop(ctx, deps);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/stopped/i);
    expect(replies[0]).toMatch(/scheduled tasks preserved/i);
    // Scheduler queue should still have the second job
    expect(queueManager.snapshot(chatId).schedulerQueueLen).toBe(1);
  });

  it('handleStop all clears both queues', async () => {
    const { deps, queueManager } = makeDeps();
    const chatId = 42;
    queueManager.enqueueScheduler(chatId, {
      id: 'sched-1',
      description: 'test task',
      run: async () => { await new Promise(() => {}); },
    });
    const { ctx, replies } = makeMockCtx({ chatId, text: '/stop all' });
    await handleStop(ctx, deps);
    expect(replies[0]).toMatch(/both queues cleared/i);
    expect(queueManager.snapshot(chatId).schedulerQueueLen).toBe(0);
  });

  it('handleProjects replies with "No projects" when none configured', async () => {
    const { deps } = makeDeps();
    const { ctx, replies } = makeMockCtx();
    await handleProjects(ctx, deps);
    expect(replies[0]).toMatch(/no projects/i);
  });

  it('handleHistory replies with "No command history" when empty', async () => {
    const { deps } = makeDeps();
    const { ctx, replies } = makeMockCtx();
    await handleHistory(ctx, deps);
    expect(replies[0]).toMatch(/no command history/i);
  });

  it('handleClear archives the session and replies', async () => {
    const { deps, mem } = makeDeps();
    const chatId = 42;
    // Create a session first
    const session = mem.sessions.getOrCreate(chatId);
    expect(session.status).toBe('active');

    const { ctx, replies } = makeMockCtx({ chatId });
    await handleClear(ctx, deps);
    expect(replies[0]).toMatch(/session cleared/i);
    // Attempting getOrCreate again creates a NEW session (old one is archived)
    const newSession = mem.sessions.getOrCreate(chatId);
    expect(newSession.id).not.toBe(session.id);
  });
});
