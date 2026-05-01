/**
 * Unit tests for src/memory/groupActivity.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'path';
import os from 'os';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-gua-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

describe('memory.groupActivity', () => {
  let mem: MemoryApi;
  const GROUP_ID = -100001;
  const USER_A = 1001;
  const USER_B = 1002;

  beforeEach(() => {
    mem = fresh();
  });

  describe('checkAndIncrement()', () => {
    it('allows first message within limit', () => {
      const result = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 10, 60);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('allows messages up to the limit', () => {
      for (let i = 0; i < 5; i++) {
        const r = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 5, 60);
        expect(r.allowed).toBe(true);
      }
    });

    it('blocks when limit is reached', () => {
      for (let i = 0; i < 5; i++) {
        mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 5, 60);
      }
      const result = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 5, 60);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(5);
    });

    it('users are tracked independently', () => {
      // Fill user A's limit
      for (let i = 0; i < 5; i++) {
        mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 5, 60);
      }
      // User B should still be allowed
      const result = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_B, 'Bob', 5, 60);
      expect(result.allowed).toBe(true);
    });

    it('groups are tracked independently', () => {
      // Fill GROUP 1 for user A
      for (let i = 0; i < 5; i++) {
        mem.groupActivity.checkAndIncrement(-100001, USER_A, 'Alice', 5, 60);
      }
      // User A in GROUP 2 should be allowed
      const result = mem.groupActivity.checkAndIncrement(-100002, USER_A, 'Alice', 5, 60);
      expect(result.allowed).toBe(true);
    });

    it('window resets when window has expired', async () => {
      // Fill the limit
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 2, 60);
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 2, 60);
      const blocked = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 2, 60);
      expect(blocked.allowed).toBe(false);

      // Set window_start_at to 2 hours in the past using an absolute ISO string.
      // This avoids relying on SQLite modifier support in node:sqlite.
      const { getDb } = await import('../../src/memory/db.js');
      const db = getDb();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''); // 'YYYY-MM-DD HH:MM:SS' — SQLite format

      db.prepare(
        `UPDATE group_user_activity SET window_start_at = ? WHERE group_id = ? AND user_id = ?`
      ).run(twoHoursAgo, GROUP_ID, USER_A);

      // Now the window is expired — next check should reset and allow
      const result = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 2, 60);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1); // reset to 1
    });

    it('respects per-user override rate limit', () => {
      // Set override of 2 for USER_A
      mem.groupActivity.setRateLimitOverride(GROUP_ID, USER_A, 2);
      // Fill up
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 100, 60);
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 100, 60);
      // Should be blocked (override of 2)
      const result = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 100, 60);
      expect(result.allowed).toBe(false);
    });

    it('override of 0 falls back to default limit', () => {
      mem.groupActivity.setRateLimitOverride(GROUP_ID, USER_A, 0); // 0 = use default
      const result = mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 3, 60);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(3); // uses the passed-in default
    });
  });

  describe('addTokens()', () => {
    it('accumulates token counts', () => {
      // Create the row first
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 10, 60);
      mem.groupActivity.addTokens(GROUP_ID, USER_A, 100, 50);
      mem.groupActivity.addTokens(GROUP_ID, USER_A, 200, 75);

      const rows = mem.groupActivity.listForGroup(GROUP_ID);
      const userRow = rows.find((r) => r.user_id === USER_A);
      expect(userRow?.input_tokens).toBe(300);
      expect(userRow?.output_tokens).toBe(125);
    });
  });

  describe('listForGroup()', () => {
    it('returns empty array when no activity', () => {
      const rows = mem.groupActivity.listForGroup(GROUP_ID);
      expect(rows).toEqual([]);
    });

    it('returns all users in a group', () => {
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_A, 'Alice', 10, 60);
      mem.groupActivity.checkAndIncrement(GROUP_ID, USER_B, 'Bob', 10, 60);
      const rows = mem.groupActivity.listForGroup(GROUP_ID);
      expect(rows).toHaveLength(2);
    });

    it('does not return users from other groups', () => {
      mem.groupActivity.checkAndIncrement(-999999, USER_A, 'Alice', 10, 60);
      const rows = mem.groupActivity.listForGroup(GROUP_ID);
      expect(rows).toHaveLength(0);
    });
  });
});
