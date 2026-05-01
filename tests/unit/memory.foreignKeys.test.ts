/**
 * F-02 Regression: PRAGMA foreign_keys=ON must actually take effect.
 * openDb() must throw (not just log a warning) when FK enforcement fails.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { openDb, _resetDb } from '../../src/memory/db.js';

afterEach(() => {
  _resetDb();
  vi.restoreAllMocks();
});

describe('F-02 regression: PRAGMA foreign_keys verification', () => {
  it('openDb succeeds and foreign_keys reports 1 on a fresh database', () => {
    const cfg = makeTestConfig();
    try {
      const db = openDb(cfg);

      // Verify FK is ON via the pragma API
      const result = db.pragma('foreign_keys');
      // better-sqlite3: returns [{foreign_keys: 1}]; node:sqlite shim may return array or number
      const fkValue = Array.isArray(result)
        ? ((result[0] as Record<string, unknown>)?.['foreign_keys'] ?? result[0])
        : result;
      expect(fkValue === 1 || fkValue === 1n).toBe(true);
    } finally {
      _resetDb();
      cleanupTmpRoot(cfg);
    }
  });

  it('openDb throws when a mock driver reports foreign_keys=0', async () => {
    // We spy on the openDriver export from dbDriver.ts to return a handle that
    // reports FK=0 so we can verify the fatal-throw path.
    const dbDriverModule = await import('../../src/memory/dbDriver.js');
    vi.spyOn(dbDriverModule, 'openDriver').mockReturnValue({
      pragma(name: string) {
        if (name === 'journal_mode = WAL') return 'wal';
        if (name === 'foreign_keys = ON') return null;
        // Simulate FK not enforced: return array of row with 0
        if (name === 'foreign_keys') return [{ foreign_keys: 0 }];
        if (name === 'busy_timeout = 5000') return null;
        return null;
      },
      exec() {},
      prepare() {
        return {
          run() { return { changes: 0, lastInsertRowid: 0 }; },
          get() { return undefined; },
          all() { return []; },
        };
      },
      close() {},
      transaction(fn: (...args: unknown[]) => unknown) {
        return (...args: unknown[]) => fn(...args);
      },
    });

    const cfg = makeTestConfig();
    try {
      expect(() => openDb(cfg)).toThrow(/foreign_keys.*did not take effect/i);
    } finally {
      cleanupTmpRoot(cfg);
    }
  });
});
