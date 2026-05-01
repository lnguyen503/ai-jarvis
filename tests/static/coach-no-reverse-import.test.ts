/**
 * Static gate: enforce one-way edge `organize/ → coach/` (v1.18.0 ADR 018).
 *
 * BINDING: ADR 018-revisions + CLAUDE.md v1.18.0 invariant 1 + KNOWN_ISSUES
 * v1.18.0 entry 1. The dependency direction is one-way: coach/ may import
 * from organize/, but organize/ MUST NOT import from coach/, with one
 * exception — `coach/intensityTypes.ts` is a pure leaf type module that
 * organize/ owns the schema for and is allowed to import.
 *
 * Why this matters: a future agent who reaches into coach/ from organize/
 * (for a "shared helper") creates a circular dependency that breaks the
 * module graph and silently invalidates the audit privacy posture (the
 * organize tools and coach tools share no state by design — they cross
 * only via the SQLite memory layer).
 *
 * Failure mode this catches: someone adds
 *   `import { upsertCoachTask } from '../coach/index.js';`  inside `src/organize/`
 * which would let the organize side mutate scheduled coach tasks directly,
 * undocumented, bypassing the webapp/ + commands/ choke points.
 *
 * Mirrors: tests/static/no-zombie-detail-panel-symbols.test.ts shape.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORGANIZE_DIR = path.join(PROJECT_ROOT, 'src/organize');

/**
 * The single allowed `from '...coach...'` import path inside src/organize/**.
 * intensityTypes.ts is a pure leaf type module — no imports of its own — so
 * it cannot create a cycle. organize/ depends on the CoachIntensity type
 * definition; promoting it to a shared/types module would be cleaner but is
 * deferred (v1.18.x).
 */
const ALLOWED_IMPORT_SUFFIX = '/coach/intensityTypes.js';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Static gate — coach has no reverse import from organize/ (ADR 018)', () => {
  it('src/organize/ exists', () => {
    expect(fs.existsSync(ORGANIZE_DIR)).toBe(true);
  });

  it('no file under src/organize/** imports from src/coach/ except the allowed leaf', () => {
    const files = listTsFiles(ORGANIZE_DIR);
    expect(files.length).toBeGreaterThan(0);

    // Match `from 'X/coach/Y'` and `from "X/coach/Y"` — covers ESM .js suffix
    // and any subpath. Both single + double quotes; deliberately permissive
    // on the path prefix so it catches `../coach/...`, `../../coach/...`, and
    // any future path-shape changes.
    const importRe = /from\s+['"]([^'"]*\/coach\/[^'"]+)['"]/g;

    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        importRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(line)) !== null) {
          const importPath = match[1] ?? '';
          if (importPath.endsWith(ALLOWED_IMPORT_SUFFIX)) continue;
          const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
          violations.push(`${rel}:${i + 1}: forbidden reverse import "${importPath}"`);
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        'ADR 018 invariant 1 violation: src/organize/ imports from src/coach/.',
        `The only allowed import path is "${ALLOWED_IMPORT_SUFFIX}" (pure leaf type module).`,
        'If you need shared logic, promote it to src/shared/ or pass through a function parameter.',
        '',
        ...violations,
      ].join('\n');
      expect(violations.length, msg).toBe(0);
    }
  });
});
