/**
 * Static test - ADR 020 R2 cross-file reachability for prompt-builder surfaces.
 *
 * Asserts that the two key coach prompt-builder functions are NOT dead code:
 *   1. expandCoachPromptToken - must have >=1 call site in src/star-star/star.ts
 *      outside its own definition file AND outside test files.
 *   2. buildCoachActiveItemsBlock - must have >=1 call site in src/star-star/star.ts
 *      outside its own definition file AND outside test files.
 *
 * Background (T-R2-3, ADR 020 revisions R2 commit 11.5):
 *   v1.18.0/v1.19.0 trap class: interface declared, wiring stubbed or absent
 *   ("shape-without-wiring"). Two new functions introduced in v1.20.0 extend
 *   the coach prompt-builder surface. Cross-file reachability asserts they are
 *   actually called, not just declared.
 *
 * The check errs on the side of false positives (per ADR 020 R2 binding).
 * Call sites in test files do NOT count - only src/star-star/star.ts (non-self, non-test).
 *
 * ADR 020 R2 (CP1 revisions doc) + commit 11.5.
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
 * Count non-self, non-test call sites for a function name.
 * A "call site" is any line in src/star-star/star.ts (excluding selfFile) that contains
 * the function name followed by '(' (direct call pattern).
 */
function countCallSites(fnName: string, selfFile: string): { count: number; sites: string[] } {
  const srcDir = path.join(ROOT, 'src');
  const files = collectSrcFiles(srcDir);
  const sites: string[] = [];

  for (const file of files) {
    if (file === selfFile) continue; // skip self
    const src = readFileSync(file, 'utf8');
    // Match function calls (not definitions): fnName followed by ( on same line
    const callPattern = new RegExp(`\\b${fnName}\\s*\\(`);
    if (callPattern.test(src)) {
      sites.push(path.relative(ROOT, file));
    }
  }

  return { count: sites.length, sites };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ADR 020 R2: cross-file reachability - prompt-builder functions', () => {
  it('T-R2-3a: expandCoachPromptToken has >=1 non-self call site in src/star-star/star.ts', () => {
    const selfFile = path.join(ROOT, 'src', 'coach', 'index.ts');
    const { count, sites } = countCallSites('expandCoachPromptToken', selfFile);

    if (count === 0) {
      throw new Error(
        'T-R2-3a FAIL: expandCoachPromptToken has zero non-self call sites in src/star-star/star.ts. ' +
        'This function must be called by at least one production file (gateway or scheduler). ' +
        'This is the "shape-without-wiring" trap (ADR 020 R2).',
      );
    }

    // Pass: at least one call site exists
    expect(count).toBeGreaterThanOrEqual(1);
    // Informational: which files call it
    expect(sites.length).toBeGreaterThanOrEqual(1);
  });

  it('T-R2-3b: buildCoachActiveItemsBlock has >=1 non-self call site in src/star-star/star.ts', () => {
    const selfFile = path.join(ROOT, 'src', 'coach', 'coachPromptInjection.ts');
    const { count, sites } = countCallSites('buildCoachActiveItemsBlock', selfFile);

    if (count === 0) {
      throw new Error(
        'T-R2-3b FAIL: buildCoachActiveItemsBlock has zero non-self call sites in src/star-star/star.ts. ' +
        'This function must be called by at least one production file (agent/index.ts). ' +
        'This is the "shape-without-wiring" trap (ADR 020 R2).',
      );
    }

    expect(count).toBeGreaterThanOrEqual(1);
    expect(sites.length).toBeGreaterThanOrEqual(1);
  });

  it('T-R2-3c: expandCoachPromptToken is NOT defined in multiple files (SSOT check)', () => {
    const srcDir = path.join(ROOT, 'src');
    const files = collectSrcFiles(srcDir);

    const definitionSites = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /export function expandCoachPromptToken/.test(src);
    });

    expect(definitionSites).toHaveLength(1);
    expect(path.relative(ROOT, definitionSites[0]!)).toMatch(/coach.index\.ts$/);
  });

  it('T-R2-3d: buildCoachActiveItemsBlock is NOT defined in multiple files (SSOT check)', () => {
    const srcDir = path.join(ROOT, 'src');
    const files = collectSrcFiles(srcDir);

    const definitionSites = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /export\s+(?:async\s+)?function buildCoachActiveItemsBlock/.test(src);
    });

    expect(definitionSites).toHaveLength(1);
    expect(path.relative(ROOT, definitionSites[0]!)).toMatch(/coachPromptInjection\.ts$/);
  });
});
