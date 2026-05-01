/**
 * DB driver shim. Provides a minimal better-sqlite3-compatible API
 * backed by either better-sqlite3 (preferred) or node:sqlite (fallback).
 *
 * DEVIATION from ARCH/STRUCTURE: when better-sqlite3 is unavailable
 * (e.g., Node version without prebuilds, missing VS Studio on Windows),
 * we fall back to the built-in node:sqlite module (stable in Node 22+,
 * experimental on some earlier 22.x). All prepared-statement + transaction
 * semantics are preserved.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Transaction<F extends (...args: unknown[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F>;
}

export interface DbHandle {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(pragma: string): unknown;
  close(): void;
  transaction<F extends (...args: unknown[]) => unknown>(fn: F): Transaction<F>;
}

/**
 * Try to load better-sqlite3; fall back to node:sqlite shim.
 */
export function openDriver(filename: string): DbHandle {
  // Attempt better-sqlite3 first
  try {
    const Database = require('better-sqlite3') as new (
      filename: string,
    ) => DbHandle;
    return new Database(filename);
  } catch {
    // Fall back to node:sqlite shim
    return openNodeSqlite(filename);
  }
}

function openNodeSqlite(filename: string): DbHandle {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (filename: string) => any;
  };
  const db = new DatabaseSync(filename);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  function makeStatement(sql: string): Statement {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stmt: any = db.prepare(sql);
    // node:sqlite prepared statements return arrays/objects directly
    return {
      run(...params: unknown[]): RunResult {
        // node:sqlite supports both positional and named-object params
        const [first, ...rest] = params;
        const res =
          first !== undefined && rest.length === 0 && typeof first === 'object' && first !== null && !Array.isArray(first)
            ? stmt.run(first)
            : stmt.run(...params);
        return {
          changes: Number(res?.changes ?? 0),
          lastInsertRowid: res?.lastInsertRowid ?? 0,
        };
      },
      get(...params: unknown[]): unknown {
        const [first, ...rest] = params;
        return first !== undefined && rest.length === 0 && typeof first === 'object' && first !== null && !Array.isArray(first)
          ? stmt.get(first)
          : stmt.get(...params);
      },
      all(...params: unknown[]): unknown[] {
        const [first, ...rest] = params;
        const result =
          first !== undefined && rest.length === 0 && typeof first === 'object' && first !== null && !Array.isArray(first)
            ? stmt.all(first)
            : stmt.all(...params);
        return result as unknown[];
      },
    };
  }

  return {
    prepare(sql: string): Statement {
      return makeStatement(sql);
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    pragma(pragma: string): unknown {
      // node:sqlite has no pragma() shorthand — run via exec
      try {
        // Try to get result via prepare
        const s = db.prepare(`PRAGMA ${pragma}`);
        return s.all();
      } catch {
        db.exec(`PRAGMA ${pragma}`);
        return null;
      }
    },
    close(): void {
      db.close();
    },
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): Transaction<F> {
      return ((...args: Parameters<F>) => {
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result as ReturnType<F>;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }) as Transaction<F>;
    },
  };
}
