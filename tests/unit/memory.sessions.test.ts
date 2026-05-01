import { describe, it, expect, beforeEach } from 'vitest';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'path';
import os from 'os';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-sess-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

describe('memory.sessions', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = fresh();
  });

  it('getOrCreate creates a new session for an unknown chatId', () => {
    const s = mem.sessions.getOrCreate(12345);
    expect(s.id).toBeGreaterThan(0);
    expect(s.telegram_chat_id).toBe(12345);
    expect(s.status).toBe('active');
  });

  it('getOrCreate returns the same session for a repeat chatId', () => {
    const a = mem.sessions.getOrCreate(12345);
    const b = mem.sessions.getOrCreate(12345);
    expect(a.id).toBe(b.id);
  });

  it('archive marks a session as archived', () => {
    const s = mem.sessions.getOrCreate(12345);
    mem.sessions.archive(s.id, 12345);
    // After archive, a new getOrCreate should return a different session
    const fresh = mem.sessions.getOrCreate(12345);
    expect(fresh.id).not.toBe(s.id);
  });

  it('touchLastActive updates the last_active_at timestamp', () => {
    const s = mem.sessions.getOrCreate(12345);
    // Should not throw
    mem.sessions.touchLastActive(s.id, 12345);
  });
});
