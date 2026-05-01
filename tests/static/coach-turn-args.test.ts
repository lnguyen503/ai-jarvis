/**
 * Static test — ADR 020 R1: buildCoachTurnArgs is the sole source of truth
 * for the three load-bearing coach-turn flags.
 *
 * Binding assertions:
 *   T-R1-1: buildCoachTurnArgs() (no args) returns the correct default shape.
 *   T-R1-2: buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext: 'foo' }) works.
 *   T-R1-3: Static lint — no coach-relevant call site inlines isCoachRun: true literally.
 *           Fixture file demonstrates that inline construction → FAIL detection.
 *   T-R1-4: buildCoachTurnArgs is exported from src/coach/index.ts.
 *   T-R1-5: buildCoachTurnArgs is ONLY defined in src/coach/index.ts (not duplicated).
 *
 * ADR 020 CP1 revisions R1 + commit 9.5 binding.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildCoachTurnArgs } from '../../src/coach/index.js';

const ROOT = path.resolve(import.meta.dirname, '../../');
const COACH_INDEX_PATH = path.join(ROOT, 'src', 'coach', 'index.ts');
const coachIndexSrc = readFileSync(COACH_INDEX_PATH, 'utf8');

// ---------------------------------------------------------------------------
// T-R1-1, T-R1-2: buildCoachTurnArgs functional tests
// ---------------------------------------------------------------------------

describe('ADR 020 R1: buildCoachTurnArgs functional tests', () => {
  it('T-R1-1: buildCoachTurnArgs() returns correct default shape', () => {
    const result = buildCoachTurnArgs();
    expect(result).toEqual({
      isCoachRun: true,
      coachTurnCounters: { nudges: 0, writes: 0 },
      isSpontaneousTrigger: false,
      triggerContext: '',
    });
  });

  it('T-R1-2: buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext: "foo" }) works', () => {
    const result = buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext: 'foo' });
    expect(result.isCoachRun).toBe(true);
    expect(result.isSpontaneousTrigger).toBe(true);
    expect(result.triggerContext).toBe('foo');
    expect(result.coachTurnCounters).toEqual({ nudges: 0, writes: 0 });
  });

  it('T-R1-4: buildCoachTurnArgs is exported from src/coach/index.ts', () => {
    expect(coachIndexSrc).toMatch(/export function buildCoachTurnArgs/);
  });
});

// ---------------------------------------------------------------------------
// T-R1-3: Static lint — inline isCoachRun: true detection
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts files under srcDir.
 * Excludes node_modules, dist, tests.
 */
function collectSrcFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry)) continue;
      results.push(...collectSrcFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('ADR 020 R1: static lint — no inline coach-turn flag construction', () => {
  it('T-R1-3: src/**/*.ts contains no literal "isCoachRun: true" outside src/agent/index.ts', () => {
    // The only ALLOWED site is src/agent/index.ts (TurnParams interface definition).
    // All other files must use buildCoachTurnArgs() or derive the value via the gateway helper.
    const srcDir = path.join(ROOT, 'src');
    const files = collectSrcFiles(srcDir);

    const violations: string[] = [];
    for (const file of files) {
      // Allow the agent's TurnParams interface definition and the post-turn callback
      if (file.endsWith(path.join('src', 'agent', 'index.ts'))) continue;
      // Allow the coach/index.ts definition of buildCoachTurnArgs itself
      if (file.endsWith(path.join('src', 'coach', 'index.ts'))) continue;

      const src = readFileSync(file, 'utf8');
      // Check for inline literal construction: isCoachRun: true (as an object key assignment)
      // Filter out comments (lines starting with // or inside /* */ blocks) by checking
      // non-comment lines only.
      const nonCommentLines = src
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith('//') && !trimmed.startsWith('*');
        })
        .join('\n');
      if (/isCoachRun\s*:\s*true/.test(nonCommentLines)) {
        violations.push(path.relative(ROOT, file));
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `T-R1-3 FAIL: Found inline isCoachRun: true construction (must use buildCoachTurnArgs) in:\n` +
        violations.map((v) => `  ${v}`).join('\n'),
      );
    }
  });

  it('T-R1-5: buildCoachTurnArgs is defined exactly once in src/**/*.ts', () => {
    const srcDir = path.join(ROOT, 'src');
    const files = collectSrcFiles(srcDir);

    const definitionSites: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (/export function buildCoachTurnArgs/.test(src)) {
        definitionSites.push(path.relative(ROOT, file));
      }
    }

    expect(definitionSites).toHaveLength(1);
    expect(definitionSites[0]).toMatch(/coach.index\.ts$/);
  });
});
