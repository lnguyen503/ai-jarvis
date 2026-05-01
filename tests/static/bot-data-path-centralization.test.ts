/**
 * Static gate: per-bot data-path SSOT discipline.
 *
 * BINDING: ADR 021 D17 + 021-revisions + CLAUDE.md v1.21.0 invariant 2 +
 * KNOWN_ISSUES v1.21.0 entry 2.
 *
 * v1.21.0 introduces per-bot data isolation: each bot's data lives at
 * `data/<botName>/...`. To prevent path drift, ALL `data/` path construction
 * MUST go through ONE helper: `resolveBotDataPath(identity, ...subpath)`
 * (in `src/config/botPaths.ts`).
 *
 * Failure mode this catches: a future refactor that hardcodes `path.join('data',
 * 'organize', userId, ...)` somewhere in src/. The hardcoded path would write
 * to `data/organize/...` regardless of which bot's process is running, breaking
 * per-bot isolation.
 *
 * Allowed: the helper itself in `src/config/botPaths.ts` is the only place
 * that constructs `data/...` paths from raw strings. Migration code in
 * `src/config/botMigration.ts` is also allowed (it READS legacy paths and
 * RENAMES to new paths; both touch `data/`).
 *
 * Pattern matched: `path.join('data'`, `path.resolve('data'`, or `'data/'`
 * literal in src/ files.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTsFiles } from './_helpers/import-edges.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

const ALLOWED_FILES = [
  // The helper itself
  'config/botPaths.ts',
  // Migration code: RENAMES legacy → new paths
  'config/botMigration.ts',
  // Existing legacy data paths from pre-v1.21.0 — these will be migrated by
  // botMigration.ts; once v1.21.x cleanup completes, re-tighten the allowlist.
  'config/index.ts', // current dataDir resolution; will refactor in commit 12
];

/**
 * Patterns that indicate hardcoded `data/` path construction.
 * Allows `'data/'` only inside string literals that are clearly comments
 * or examples (skipped by line-comment + block-comment scrubber).
 */
const FORBIDDEN_PATTERNS: Array<{ name: string; matcher: RegExp }> = [
  { name: 'path.join data string', matcher: /path\.join\(\s*['"]data['"]\s*,/ },
  { name: 'path.resolve data string', matcher: /path\.resolve\(\s*['"]data['"]\s*,/ },
  // Note: 'data/' alone is too noisy (appears in JSDoc / comments / type strings).
  // Catch only the path.* helpers + explicit construction.
];

function readSource(filePath: string): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const source = fs.readFileSync(filePath, 'utf-8');
  // Strip block + line comments to avoid matching specifiers in JSDoc.
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlockComments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('per-bot data path SSOT discipline', () => {
  it('no src/ file (except allowed) constructs data/ paths directly', () => {
    const violations: Array<{ file: string; pattern: string; line: number }> = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/');
      if (ALLOWED_FILES.some((allowed) => rel === allowed)) continue;

      const source = readSource(file);
      const lines = source.split('\n');
      for (const pattern of FORBIDDEN_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          if (pattern.matcher.test(lines[i]!)) {
            violations.push({ file: rel, pattern: pattern.name, line: i + 1 });
          }
        }
      }
    }

    expect(
      violations,
      `Hardcoded data/ path construction detected (${violations.length} violation(s)):\n` +
        violations.map((v) => `  ${v.file}:${v.line} — ${v.pattern}`).join('\n') +
        `\n\nAll data/ path construction MUST go through resolveBotDataPath() ` +
        `from src/config/botPaths.ts (single source of truth per ADR 021 D17). ` +
        `If you need a new path helper for a specific subpath (e.g. logsDir), ` +
        `add it to botPaths.ts as a new export rather than hardcoding here.`,
    ).toEqual([]);
  });
});
