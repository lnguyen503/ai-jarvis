/**
 * Static gate: enforce one-way edge `organize/ → calendar/` (v1.19.0 ADR 019 D14).
 *
 * BINDING: ADR 019 D14 + 019-revisions RA1 invariant. Calendar is downstream;
 * organize is foundational.
 *
 * `src/organize/**` MUST NOT import from `src/calendar/**`.
 * The post-write hook is registered in src/index.ts (boot) via a callback
 * pointer — organize knows nothing about calendar (same pattern as v1.18.0
 * coach trash-evictor). The callback registration itself lives in
 * src/index.ts; organize only has a generic `_calendarSyncCallback` slot.
 *
 * Exception: calendar CAN import organize TYPES from a shared types file.
 * That direction is OK (calendar is downstream of organize).
 * This test only checks the FORBIDDEN direction: organize → calendar.
 *
 * Mirrors: tests/static/coach-no-reverse-import.test.ts shape.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORGANIZE_DIR = path.join(PROJECT_ROOT, 'src/organize');
const CALENDAR_SEGMENT = '/calendar/';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
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

describe('Static gate — calendar has no reverse import from organize/ (ADR 019 D14)', () => {
  it('src/organize/ directory exists', () => {
    expect(fs.existsSync(ORGANIZE_DIR)).toBe(true);
  });

  it('no file under src/organize/** imports from src/calendar/**', () => {
    const files = listTsFiles(ORGANIZE_DIR);
    expect(files.length).toBeGreaterThan(0);

    // Match `from 'X/calendar/Y'` and `from "X/calendar/Y"` (ESM .js suffix or bare)
    const importRe = /from\s+['"]([^'"]*\/calendar\/[^'"]+)['"]/g;

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
          // Reject any import that goes through /calendar/
          if (importPath.includes(CALENDAR_SEGMENT)) {
            const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, '/');
            violations.push(`${rel}:${i + 1}: forbidden reverse import "${importPath}"`);
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        'ADR 019 D14 invariant violation: src/organize/ imports from src/calendar/.',
        'Calendar is downstream of organize; the dependency must only flow one way.',
        'If organize needs to notify calendar, register a callback in src/index.ts at boot.',
        '',
        ...violations,
      ].join('\n');
      expect(violations.length, msg).toBe(0);
    }
  });
});
