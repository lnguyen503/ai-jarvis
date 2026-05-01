import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';
import { runMigrations } from './migrations/index.js';
import { openDriver, type DbHandle } from './dbDriver.js';

const log = child({ component: 'memory.db' });

let _db: DbHandle | null = null;

/**
 * Open the SQLite database, enable WAL + foreign keys, run migrations.
 * Uses better-sqlite3 when available, falls back to node:sqlite.
 */
export function openDb(cfg: AppConfig): DbHandle {
  if (_db) {
    return _db;
  }

  const dbPath = path.resolve(process.cwd(), cfg.memory.dbPath);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = openDriver(dbPath);

  try { db.pragma('journal_mode = WAL'); } catch (err) {
    log.warn({ err }, 'db: PRAGMA journal_mode=WAL failed — continuing without WAL');
  }
  try {
    db.pragma('foreign_keys = ON');
  } catch (err) {
    // We'll verify below — a thrown exception here is also fatal.
    log.warn({ err }, 'db: PRAGMA foreign_keys=ON threw — referential integrity likely NOT enforced');
  }

  // F-02: verify foreign_keys actually took effect. Some drivers (node:sqlite)
  // silently ignore PRAGMAs. A silent downgrade is a data-safety hazard.
  const fkResult = db.pragma('foreign_keys');
  // better-sqlite3 returns an array of row objects; node:sqlite shim returns an array or null.
  // The FK value is either 1 (number) or { foreign_keys: 1 }.
  const fkValue = Array.isArray(fkResult)
    ? ((fkResult[0] as Record<string, unknown>)?.['foreign_keys'] ?? fkResult[0])
    : fkResult;
  if (fkValue !== 1 && fkValue !== 1n) {
    throw new Error(
      `db: PRAGMA foreign_keys=ON did not take effect (got ${JSON.stringify(fkValue)}). ` +
        'Referential integrity is NOT enforced — refusing to continue.',
    );
  }

  try { db.pragma('busy_timeout = 5000'); } catch (err) {
    log.warn({ err }, 'db: PRAGMA busy_timeout=5000 failed — concurrent access may error immediately');
  }

  runMigrations(db);

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getDb(): DbHandle {
  if (!_db) {
    throw new Error('Database not opened. Call openDb() first.');
  }
  return _db;
}

export function _resetDb(): void {
  _db = null;
}

export type { DbHandle };
