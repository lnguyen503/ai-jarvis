/**
 * Static test: WAL checkpoint ordering in botMigration.ts (CP1 R1 BINDING).
 *
 * ADR 021 CP1 R1 + R5 — SQLite WAL sidecar discipline.
 *
 * The migration helper MUST:
 *   1. Call lstatSync + isSymbolicLink() BEFORE the WAL checkpoint.
 *   2. Call pragma('wal_checkpoint(TRUNCATE)') BEFORE any fs.renameSync.
 *
 * Violation: renaming jarvis.db without flushing the WAL first discards every
 * uncommitted write at the boundary (v1.21.0 CP1 R1 trap class).
 *
 * Detection: parse src/config/botMigration.ts source, find token positions,
 * assert ordering invariants. Same shape as v1.20.0 D2 + R3.a static tests.
 *
 * Assertions:
 *   1. 'isSymbolicLink' appears in source.
 *   2. 'wal_checkpoint(TRUNCATE)' appears in source.
 *   3. 'renameSync' appears in source.
 *   4. isSymbolicLink line < wal_checkpoint line.
 *   5. wal_checkpoint line < first renameSync line.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_MIGRATION_SRC = path.resolve(__dirname, '../../src/config/botMigration.ts');

function findFirstLineNumber(lines: string[], pattern: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = line.trimStart();
    // Skip single-line comments
    if (stripped.startsWith('//')) continue;
    // Skip block comment lines (lines that are part of /* ... */ or JSDoc)
    if (stripped.startsWith('*') || stripped.startsWith('/*')) continue;
    if (pattern.test(line)) {
      return i + 1; // 1-based
    }
  }
  return null;
}

describe('bot-migration-wal-checkpoint (CP1 R1 BINDING)', () => {
  let src: string;
  let lines: string[];

  try {
    src = readFileSync(BOT_MIGRATION_SRC, 'utf8');
    lines = src.split('\n');
  } catch (err) {
    throw new Error(
      `Cannot read src/config/botMigration.ts: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  it('source contains isSymbolicLink check (symlink rejection)', () => {
    expect(src).toContain('isSymbolicLink');
  });

  it('source contains wal_checkpoint(TRUNCATE)', () => {
    expect(src).toContain('wal_checkpoint(TRUNCATE)');
  });

  it('source contains renameSync (file rename)', () => {
    expect(src).toContain('renameSync');
  });

  it('isSymbolicLink check appears BEFORE wal_checkpoint (R1.a before R1.b)', () => {
    const symlinkLine = findFirstLineNumber(lines, /isSymbolicLink/);
    const walLine = findFirstLineNumber(lines, /wal_checkpoint/);

    expect(symlinkLine).not.toBeNull();
    expect(walLine).not.toBeNull();

    if (symlinkLine !== null && walLine !== null) {
      expect(
        symlinkLine,
        `isSymbolicLink (line ${symlinkLine}) must appear BEFORE wal_checkpoint (line ${walLine})`,
      ).toBeLessThan(walLine);
    }
  });

  it('wal_checkpoint appears BEFORE first renameSync (R1.b before R1.d)', () => {
    const walLine = findFirstLineNumber(lines, /wal_checkpoint/);
    const renameLine = findFirstLineNumber(lines, /renameSync/);

    expect(walLine).not.toBeNull();
    expect(renameLine).not.toBeNull();

    if (walLine !== null && renameLine !== null) {
      expect(
        walLine,
        `wal_checkpoint (line ${walLine}) must appear BEFORE renameSync (line ${renameLine})`,
      ).toBeLessThan(renameLine);
    }
  });

  it('source contains bot.migration_failed audit category (CP1 R1 new category)', () => {
    expect(src).toContain('bot.migration_failed');
  });

  it('source contains SYMLINK_REJECTED reason string', () => {
    expect(src).toContain('SYMLINK_REJECTED');
  });

  it('source contains WAL_CHECKPOINT_FAILED reason string', () => {
    expect(src).toContain('WAL_CHECKPOINT_FAILED');
  });

  it('source contains RENAME_FAILED reason string', () => {
    expect(src).toContain('RENAME_FAILED');
  });
});
