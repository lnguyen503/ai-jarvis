/**
 * Sub-Phase C / N8 — scheduled_tasks chat_id scoping.
 * Ensures listActive() returns all active rows (needed for scheduler boot),
 * but per-task fields never leak the wrong chat_id under normal repo use.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-sched-${Date.now()}-${Math.random()}.db`);
  return initMemory(makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } }));
}

describe('memory.scheduledTasks (N8 scoping)', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = fresh();
  });

  it('listActive returns tasks keyed by their own chat_id (no cross-chat field mutation)', () => {
    const idA = mem.scheduledTasks.insert({
      description: 'task A',
      cron_expression: '* * * * *',
      command: 'echo A',
      chat_id: 111,
    });
    const idB = mem.scheduledTasks.insert({
      description: 'task B',
      cron_expression: '* * * * *',
      command: 'echo B',
      chat_id: 222,
    });

    const all = mem.scheduledTasks.listActive();
    const a = all.find((t) => t.id === idA);
    const b = all.find((t) => t.id === idB);
    expect(a?.chat_id).toBe(111);
    expect(b?.chat_id).toBe(222);
    expect(a?.command).toBe('echo A');
    expect(b?.command).toBe('echo B');
  });

  it('setStatus(paused) removes the task from listActive results', () => {
    const id = mem.scheduledTasks.insert({
      description: 'x',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 42,
    });
    mem.scheduledTasks.setStatus(id, 'paused');
    const all = mem.scheduledTasks.listActive();
    expect(all.find((t) => t.id === id)).toBeUndefined();
  });

  it('markRan updates last_run_at', () => {
    const id = mem.scheduledTasks.insert({
      description: 'x',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 42,
    });
    mem.scheduledTasks.markRan(id);
    const all = mem.scheduledTasks.listActive();
    const row = all.find((t) => t.id === id);
    expect(row?.last_run_at).not.toBeNull();
  });

  it('remove() deletes the row', () => {
    const id = mem.scheduledTasks.insert({
      description: 'x',
      cron_expression: '* * * * *',
      command: 'echo',
      chat_id: 42,
    });
    mem.scheduledTasks.remove(id);
    expect(mem.scheduledTasks.listActive().find((t) => t.id === id)).toBeUndefined();
  });
});
