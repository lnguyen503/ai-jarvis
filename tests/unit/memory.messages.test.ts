/**
 * Regression tests for CP3 CRITICAL-1:
 *   listRecent() must return the most-recent N messages in chronological (ASC) order,
 *   not the first N messages.
 *
 * Insert 60 messages into a session, then assert that listRecent(session, 10)
 * returns the IDs corresponding to messages 51..60 (the last 10), in ascending order.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'path';
import os from 'os';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-msgs-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

describe('memory.messages', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = fresh();
  });

  it('listRecent returns the MOST-RECENT N messages, not the first N (CRITICAL-1 regression)', () => {
    const session = mem.sessions.getOrCreate(99999);

    // Insert 60 messages and track their IDs in insertion order
    const ids: number[] = [];
    for (let i = 1; i <= 60; i++) {
      const id = mem.messages.insert({
        session_id: session.id,
        role: 'user',
        content: `message ${i}`,
      });
      ids.push(id);
    }

    // Request the most recent 10
    const recent = mem.messages.listRecent(session.id, 10);

    // Must return exactly 10 rows
    expect(recent.length).toBe(10);

    // Must be in chronological (ASC) order
    const returnedIds = recent.map((m) => m.id);
    const sortedIds = [...returnedIds].sort((a, b) => a - b);
    expect(returnedIds).toEqual(sortedIds);

    // Must correspond to the last 10 messages inserted (ids 51..60, i.e. ids[50]..ids[59])
    const expectedIds = ids.slice(50); // last 10
    expect(returnedIds).toEqual(expectedIds);

    // Sanity: must NOT contain the first message's id
    expect(returnedIds).not.toContain(ids[0]);
  });

  it('listRecent with limit >= total returns all messages in ASC order', () => {
    const session = mem.sessions.getOrCreate(88888);

    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(mem.messages.insert({ session_id: session.id, role: 'user', content: `m${i}` }));
    }

    const all = mem.messages.listRecent(session.id, 50);
    expect(all.length).toBe(5);
    expect(all.map((m) => m.id)).toEqual(ids);
  });

  it('listRecent respects session_id scoping (no cross-session leak)', () => {
    const s1 = mem.sessions.getOrCreate(11111);
    const s2 = mem.sessions.getOrCreate(22222);

    mem.messages.insert({ session_id: s1.id, role: 'user', content: 'from s1' });
    mem.messages.insert({ session_id: s2.id, role: 'user', content: 'from s2' });

    const s1msgs = mem.messages.listRecent(s1.id, 10);
    expect(s1msgs.every((m) => m.session_id === s1.id)).toBe(true);
    expect(s1msgs.some((m) => m.content === 'from s2')).toBe(false);
  });
});
