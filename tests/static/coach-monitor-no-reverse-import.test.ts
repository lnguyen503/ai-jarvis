/**
 * Static gate: coach event monitors don't reach back into the modules that
 * trigger them.
 *
 * BINDING: ADR 020 D16 + 020-revisions W2 + KNOWN_ISSUES v1.20.0.
 *
 * The 3 monitor modules (itemStateMonitor, chatMonitor, calendarMonitor) are
 * registered as CALLBACKS via `register*Callback` at boot. They MUST stay
 * pure detectors — they consume the event payload, run regex/heuristic
 * detection, and either suppress or invoke `dispatchTrigger`. They MUST NOT
 * import from:
 *  - `src/organize/storage` (their producer; would create a cycle)
 *  - `src/agent/index` (also their producer for chat trigger)
 *  - `src/gateway/index` (downstream of trigger firing; coach goes through
 *    `triggerFiring.ts` which wraps `gateway.fireSpontaneousCoachTurn` —
 *    monitors must call dispatchTrigger, not gateway directly)
 *  - `src/calendar/sync` (calendar monitor is a callback registered at
 *    src/index.ts; it receives event payloads from sync.ts; it must not
 *    import sync.ts)
 *
 * Allowed: monitors may import from `src/coach/triggerFiring`, `rateLimits`,
 * `textPatternMatcher`, types. Allowed: import from `src/organize/types` only
 * (types-only edges; no runtime cycle).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractImportSpecifiers } from './_helpers/import-edges.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MONITOR_FILES = [
  'src/coach/itemStateMonitor.ts',
  'src/coach/chatMonitor.ts',
  'src/coach/calendarMonitor.ts',
];

const FORBIDDEN_SPECIFIER_PATTERNS = [
  { pattern: /\/organize\/storage/, label: 'organize/storage' },
  { pattern: /\/agent\/index/, label: 'agent/index' },
  { pattern: /\/gateway\/index/, label: 'gateway/index' },
  { pattern: /\/calendar\/sync/, label: 'calendar/sync' },
];

describe('coach monitors don\'t reverse-import their producers', () => {
  for (const relPath of MONITOR_FILES) {
    const absPath = path.join(PROJECT_ROOT, relPath);
    for (const { pattern, label } of FORBIDDEN_SPECIFIER_PATTERNS) {
      it(`${relPath} does not import from ${label}`, () => {
        const specs = extractImportSpecifiers(absPath);
        const offenders = specs.filter((s) => pattern.test(s));
        expect(
          offenders,
          `${relPath} imports from ${label} (${offenders.join(', ')}). ` +
            `Coach monitors must stay pure detectors. They receive event payloads ` +
            `via callbacks registered at boot in src/index.ts. To call into the ` +
            `producer module would create a runtime cycle. If you need data from ` +
            `the producer, plumb it through the callback's deps object instead.`,
        ).toEqual([]);
      });
    }
  }
});
