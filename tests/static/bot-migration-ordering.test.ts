/**
 * Static test: bot data migration MUST run BEFORE initMemory() in src/index.ts.
 *
 * ADR 021 D3 + CP1 R1 (BINDING):
 *   runBotDataMigration Phase A (WAL checkpoint + rename) must precede
 *   initMemory which opens the SQLite DB. If migration runs after, it would
 *   either move an already-open file or initMemory would open the DB at the
 *   new path while the legacy DB sits stale — silently losing WAL writes.
 *
 * Mirrors v1.20.0 tests/static/coach-migration-ordering.test.ts pattern
 * (line-ordering assertion on src/index.ts).
 *
 * Assertions:
 *   1. runBotDataMigration is imported in src/index.ts.
 *   2. runBotDataMigration( call appears (not just the import).
 *   3. initMemory( call appears.
 *   4. runBotDataMigration call line < initMemory call line.
 *
 * ADR 021 D3 + CP1 R1.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX_PATH = path.resolve(__dirname, '../../src/index.ts');

function getCallLineNumber(lines: string[], pattern: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = line.trimStart();
    // Skip commented-out lines
    if (stripped.startsWith('//')) continue;
    // Must be a call (not an import or type declaration)
    if (pattern.test(line) && !/^\s*import\s/.test(line) && !/from\s+['"]/.test(line)) {
      return i + 1; // 1-based
    }
  }
  return null;
}

describe('bot-migration-ordering (ADR 021 D3 + CP1 R1)', () => {
  let src: string;
  let lines: string[];

  try {
    src = readFileSync(SRC_INDEX_PATH, 'utf8');
    lines = src.split('\n');
  } catch (err) {
    throw new Error(`Cannot read src/index.ts: ${err instanceof Error ? err.message : String(err)}`);
  }

  it('runBotDataMigration is imported in src/index.ts', () => {
    expect(src).toContain('runBotDataMigration');
  });

  it('runBotDataMigration( call appears in src/index.ts (not just import)', () => {
    const callLine = getCallLineNumber(lines, /runBotDataMigration\s*\(/);
    expect(callLine).not.toBeNull();
    if (callLine !== null) {
      const line = lines[callLine - 1]!;
      expect(line).toMatch(/runBotDataMigration\s*\(/);
      // Not just the import
      const isImport = /^\s*import\s/.test(line) || /from\s+['"]/.test(line);
      expect(isImport).toBe(false);
    }
  });

  it('initMemory( call appears in src/index.ts', () => {
    const initLine = getCallLineNumber(lines, /\binitMemory\s*\(/);
    expect(initLine).not.toBeNull();
  });

  it('runBotDataMigration() call STRICTLY precedes initMemory() call (D3 BINDING)', () => {
    const migrationLine = getCallLineNumber(lines, /runBotDataMigration\s*\(/);
    const initMemoryLine = getCallLineNumber(lines, /\binitMemory\s*\(/);

    expect(migrationLine).not.toBeNull();
    expect(initMemoryLine).not.toBeNull();

    if (migrationLine !== null && initMemoryLine !== null) {
      expect(
        migrationLine,
        `runBotDataMigration (line ${migrationLine}) must appear BEFORE initMemory (line ${initMemoryLine})`,
      ).toBeLessThan(initMemoryLine);
    }
  });
});
