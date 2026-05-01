/**
 * Static gate: `src/calendar/**` MUST NOT import from `src/coach/**`.
 *
 * BINDING: ADR 020 D16 + 020-revisions W2 + KNOWN_ISSUES v1.20.0.
 *
 * v1.19.0 introduced calendar two-way sync. v1.20.0 wires a calendar →
 * coach event-trigger callback (`registerCalendarEventMonitorCallback` in
 * src/calendar/sync.ts; consumed by coach/calendarMonitor.ts). The wiring
 * direction is one-way: calendar/ exposes a callback REGISTRATION; coach/
 * registers ITS callback at boot. calendar/ never imports coach/ directly.
 *
 * Failure mode this catches: a future refactor that "shortcuts" the callback
 * indirection by having calendar/sync.ts directly import + call coach/
 * dispatchTrigger. That couples the two modules statically and breaks the
 * boot-wiring discipline that lets us swap coach implementations.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbiddenImports } from './_helpers/import-edges.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CALENDAR_DIR = path.join(PROJECT_ROOT, 'src/calendar');

describe('calendar/ does not import coach/', () => {
  it('no file in src/calendar/** imports from src/coach/**', () => {
    const violations = findForbiddenImports(
      CALENDAR_DIR,
      /\/coach\//,
      [], // no allowed exceptions
    );
    expect(
      violations,
      `Forbidden calendar → coach imports detected:\n` +
        violations.map((v) => `  ${v.file} imports ${v.specifier}`).join('\n') +
        `\n\nCalendar exposes callback registration via registerCalendarEventMonitorCallback. ` +
        `Coach registers its callback at boot in src/index.ts. Calendar must never ` +
        `import coach modules directly — that would couple the two and prevent ` +
        `swapping the coach implementation. See ADR 020 D16.`,
    ).toEqual([]);
  });
});
