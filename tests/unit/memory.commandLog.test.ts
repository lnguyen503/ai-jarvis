import { describe, it, expect, beforeEach } from 'vitest';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'path';
import os from 'os';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-cl-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

describe('memory.commandLog', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = fresh();
  });

  it('inserts a row and returns its rowid', () => {
    const id = mem.commandLog.insert({
      command: 'git status',
      working_dir: 'D:\\projects',
      exit_code: 0,
      stdout_preview: 'nothing to commit',
      stderr_preview: '',
      duration_ms: 42,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('listRecent returns rows in DESC order by created_at', () => {
    mem.commandLog.insert({ command: 'a', working_dir: '/' });
    mem.commandLog.insert({ command: 'b', working_dir: '/' });
    mem.commandLog.insert({ command: 'c', working_dir: '/' });
    const rows = mem.commandLog.listRecent(10);
    expect(rows.length).toBe(3);
    // Most recent first
    expect(rows[0]?.command).toBe('c');
  });

  it('killed flag stored as 1 when true', () => {
    mem.commandLog.insert({ command: 'x', working_dir: '/', killed: true });
    const rows = mem.commandLog.listRecent(1);
    expect(rows[0]?.killed).toBe(1);
  });
});
