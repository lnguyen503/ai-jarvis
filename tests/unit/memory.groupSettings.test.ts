/**
 * Unit tests for src/memory/groupSettings.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'path';
import os from 'os';

function fresh(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-gs-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

describe('memory.groupSettings', () => {
  let mem: MemoryApi;
  const GROUP_A = -100001;
  const GROUP_B = -100002;

  beforeEach(() => {
    mem = fresh();
  });

  describe('isEnabled()', () => {
    it('defaults to true when no row exists', () => {
      expect(mem.groupSettings.isEnabled(GROUP_A)).toBe(true);
    });

    it('returns true after setEnabled(true)', () => {
      mem.groupSettings.setEnabled(GROUP_A, true);
      expect(mem.groupSettings.isEnabled(GROUP_A)).toBe(true);
    });

    it('returns false after setEnabled(false)', () => {
      mem.groupSettings.setEnabled(GROUP_A, false);
      expect(mem.groupSettings.isEnabled(GROUP_A)).toBe(false);
    });

    it('can be toggled back to enabled', () => {
      mem.groupSettings.setEnabled(GROUP_A, false);
      mem.groupSettings.setEnabled(GROUP_A, true);
      expect(mem.groupSettings.isEnabled(GROUP_A)).toBe(true);
    });

    it('groups are independent', () => {
      mem.groupSettings.setEnabled(GROUP_A, false);
      expect(mem.groupSettings.isEnabled(GROUP_B)).toBe(true); // default
    });
  });

  describe('get()', () => {
    it('returns undefined when no row exists', () => {
      expect(mem.groupSettings.get(GROUP_A)).toBeUndefined();
    });

    it('returns the setting row after setEnabled', () => {
      mem.groupSettings.setEnabled(GROUP_A, false);
      const setting = mem.groupSettings.get(GROUP_A);
      expect(setting).toBeDefined();
      expect(setting?.chat_id).toBe(GROUP_A);
      expect(setting?.enabled).toBe(false);
      expect(setting?.updated_at).toBeTruthy();
    });
  });
});
