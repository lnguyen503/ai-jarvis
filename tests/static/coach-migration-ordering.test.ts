/**
 * Static test: coach migration MUST run before scheduler.start() (T-R3-4).
 *
 * ADR 020 R3.a (CP1 revisions BINDING) — boot ordering invariant.
 *
 * Parses src/index.ts source and asserts:
 *   1. migrateLegacyCoachTasks( appears in the file.
 *   2. The line number of the migrateLegacyCoachTasks call is STRICTLY LESS THAN
 *      the line number of scheduler.start().
 *   3. Both calls appear (not in commented-out lines).
 *
 * If migration is omitted, deferred, or moved after scheduler.start(), this test fails.
 *
 * ADR 020 D2 + R3.a.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX_PATH = path.resolve(__dirname, '../../src/index.ts');

function getLineNumber(lines: string[], pattern: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip commented-out lines (single-line // comments)
    const stripped = line.trimStart();
    if (stripped.startsWith('//')) continue;
    if (pattern.test(line)) {
      return i + 1; // 1-based line number
    }
  }
  return null;
}

describe('coach-migration-ordering (T-R3-4)', () => {
  let src: string;
  let lines: string[];

  try {
    src = readFileSync(SRC_INDEX_PATH, 'utf8');
    lines = src.split('\n');
  } catch (err) {
    throw new Error(`Cannot read src/index.ts: ${err instanceof Error ? err.message : String(err)}`);
  }

  it('migrateLegacyCoachTasks is imported in src/index.ts', () => {
    expect(src).toContain('migrateLegacyCoachTasks');
  });

  it('migrateLegacyCoachTasks() call appears in src/index.ts (not just import)', () => {
    const callLine = getLineNumber(lines, /migrateLegacyCoachTasks\s*\(/);
    expect(callLine).not.toBeNull();
    if (callLine !== null) {
      // Verify it's a CALL not just the import line
      const line = lines[callLine - 1]!;
      expect(line).toMatch(/migrateLegacyCoachTasks\s*\(/);
      // The import line would have 'from' after the function name; the call would not
      const isImportLine = /^\s*import\s/.test(line) || /^\s*\}\s*from\s/.test(line);
      expect(isImportLine).toBe(false);
    }
  });

  it('scheduler.start() call appears in src/index.ts', () => {
    const startLine = getLineNumber(lines, /scheduler\.start\s*\(\s*\)/);
    expect(startLine).not.toBeNull();
  });

  it('migrateLegacyCoachTasks() STRICTLY precedes scheduler.start() (T-R3-4 binding)', () => {
    // Find the call line (not the import line)
    let migrationLine: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const stripped = line.trimStart();
      if (stripped.startsWith('//')) continue;
      // Must be a call (has opening paren) and not an import
      if (/migrateLegacyCoachTasks\s*\(/.test(line) && !/^\s*import\s/.test(line) && !/from\s+['"]/.test(line)) {
        migrationLine = i + 1;
        break;
      }
    }

    const schedulerStartLine = getLineNumber(lines, /\bscheduler\.start\s*\(\s*\)/);

    expect(migrationLine).not.toBeNull();
    expect(schedulerStartLine).not.toBeNull();

    if (migrationLine !== null && schedulerStartLine !== null) {
      expect(migrationLine).toBeLessThan(schedulerStartLine);
    }
  });
});
