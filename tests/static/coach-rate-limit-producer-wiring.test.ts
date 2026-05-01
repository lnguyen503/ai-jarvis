/**
 * Static test - v1.20.0 Scalability CRITICAL-1.20.0.A producer-side wiring lint.
 *
 * Asserts that the two rate-limit recorder helpers are NOT shape-without-wiring:
 *   1. recordCoachDM       - must have >=1 PRODUCTION call site outside its own
 *                            definition file AND outside test files. Producer is
 *                            the gateway coach send paths (scheduler-coach + spontaneous).
 *   2. recordUserMessage   - must have >=1 PRODUCTION call site outside its own
 *                            definition file AND outside test files. Producer is
 *                            the agent post-turn DM site.
 *
 * Background (Scalability CRITICAL-1.20.0.A):
 *   v1.18.0/v1.19.0 trap class moved to producer side - exists, imported, never
 *   invoked. The 30-min coach-DM cooldown (D10) and 60s user-message debounce
 *   (D12) checks always pass because the timestamp keys are never written.
 *   These two static asserts close that loophole.
 *
 * The check errs on the side of false positives. Call sites in test files do
 * NOT count - only production src/star-star/star.ts files (non-self, non-test).
 *
 * Same pattern as tests/static/coach-prompt-builder-reachable.test.ts (commit 11.5).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect .ts source files, excluding dist/node_modules/tests. */
function collectSrcFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'tests'].includes(entry)) continue;
      results.push(...collectSrcFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Count non-self call sites for a function name across src/star-star/star.ts.
 * A "call site" is any file (excluding selfFile) that contains the function name
 * followed by '(' on a non-comment line. Import lines are also excluded.
 */
function countCallSites(fnName: string, selfFile: string): { count: number; sites: string[] } {
  const srcDir = path.join(ROOT, 'src');
  const files = collectSrcFiles(srcDir);
  const sites: string[] = [];

  // Match function calls (not definitions, not imports): fnName followed by '('.
  const callPattern = new RegExp(`\\b${fnName}\\s*\\(`);

  for (const file of files) {
    if (file === selfFile) continue; // skip self
    const src = readFileSync(file, 'utf8');
    // Walk lines so we can skip comment lines and import statements.
    const lines = src.split(/\r?\n/);
    let foundInFile = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      if (line.startsWith('import ') || line.startsWith('} from ')) continue;
      if (callPattern.test(line)) {
        foundInFile = true;
        break;
      }
    }
    if (foundInFile) {
      sites.push(path.relative(ROOT, file));
    }
  }

  return { count: sites.length, sites };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scalability CRIT-1.20.0.A: rate-limit producer-side wiring', () => {
  const selfFile = path.join(ROOT, 'src', 'coach', 'rateLimits.ts');

  it('T-CRIT-A-1: recordCoachDM has >=1 non-self production call site', () => {
    const { count, sites } = countCallSites('recordCoachDM', selfFile);

    if (count === 0) {
      throw new Error(
        'T-CRIT-A-1 FAIL: recordCoachDM has zero non-self production call sites. ' +
        'This function must be called from gateway coach send paths (scheduler-coach + spontaneous) ' +
        'so the D10 30-min cooldown ledger (coach.global.lastCoachDmAt) is actually written. ' +
        'Without a production call site, checkCoachDMCooldown ALWAYS returns allowed=true. ' +
        'Trap class: shape-without-wiring on the producer side (Scalability CRIT-1.20.0.A).',
      );
    }

    expect(count).toBeGreaterThanOrEqual(1);
    // Sanity: at least one of the sites should be in the gateway (where coach DMs originate).
    expect(sites.some((s) => s.includes('gateway'))).toBe(true);
  });

  it('T-CRIT-A-2: recordUserMessage has >=1 non-self production call site', () => {
    const { count, sites } = countCallSites('recordUserMessage', selfFile);

    if (count === 0) {
      throw new Error(
        'T-CRIT-A-2 FAIL: recordUserMessage has zero non-self production call sites. ' +
        'This function must be called from the agent post-turn site for private DMs ' +
        'so the D12 60s debounce ledger (coach.global.lastUserMessageAt) is actually written. ' +
        'Without a production call site, checkUserMessageDebounce ALWAYS returns allowed=true ' +
        'and event-trigger fires can race with active user conversations. ' +
        'Trap class: shape-without-wiring on the producer side (Scalability CRIT-1.20.0.A).',
      );
    }

    expect(count).toBeGreaterThanOrEqual(1);
    // Sanity: at least one of the sites should be in the agent (where user DMs are observed).
    expect(sites.some((s) => s.includes('agent'))).toBe(true);
  });

  it('T-CRIT-A-3: recordCoachDM is defined exactly once (SSOT check)', () => {
    const srcDir = path.join(ROOT, 'src');
    const files = collectSrcFiles(srcDir);

    const definitionSites = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /export\s+(?:async\s+)?function recordCoachDM/.test(src);
    });

    expect(definitionSites).toHaveLength(1);
    expect(path.relative(ROOT, definitionSites[0]!)).toMatch(/rateLimits\.ts$/);
  });

  it('T-CRIT-A-4: recordUserMessage is defined exactly once (SSOT check)', () => {
    const srcDir = path.join(ROOT, 'src');
    const files = collectSrcFiles(srcDir);

    const definitionSites = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /export\s+(?:async\s+)?function recordUserMessage/.test(src);
    });

    expect(definitionSites).toHaveLength(1);
    expect(path.relative(ROOT, definitionSites[0]!)).toMatch(/rateLimits\.ts$/);
  });
});
