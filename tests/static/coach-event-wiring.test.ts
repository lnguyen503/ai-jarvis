/**
 * Static gate: boot-wiring lint for coach event-trigger callbacks.
 *
 * BINDING: ADR 020 D17 + 020-revisions R2 + CLAUDE.md v1.20.0 invariant 3 +
 * KNOWN_ISSUES v1.20.0 entry 3.
 *
 * Pre-empts the v1.18.0/v1.19.0/v1.20.0 trap class — for the 4th iteration —
 * where a callback INTERFACE is correctly declared in module code, but the
 * BOOT-TIME REGISTRATION at src/index.ts wires it as an identity stub
 * (`async () => undefined`, `() => {}`, etc.) that silently disables the
 * downstream behavior in production while unit tests pass.
 *
 * Trap class history:
 *  - v1.18.0 cross-review I2: gateway dropped `coachTurnCounters` in
 *    `enqueueSchedulerTurn` → R6/F1 brake inert in production
 *  - v1.19.0 Scalability CRIT-A: `isCircuitBreakerOpen` stubbed `async () => false`
 *    in `buildCalendarSyncDeps` → 288 silent failures/day
 *  - v1.19.0 Scalability WARN-A: `auditSuccess`/`auditFailure` shims log-only,
 *    never called `memory.auditLog.insert` → audit viewer empty for calendar.*
 *  - v1.20.0 R1: `fireSpontaneousCoachTurn` originally bound only
 *    `isSpontaneousTrigger` (NOT `isCoachRun: true`) — caught at CP1, fixed
 *    via `buildCoachTurnArgs()` SSOT helper
 *
 * What this lint enforces:
 *  Layer 1 — STUB PATTERN DETECTION. For each `register*Callback(...)` call
 *  in src/index.ts that wires a coach event monitor, the callback body must
 *  NOT match any of 12 known stub patterns:
 *    1. `async () => undefined`
 *    2. `async () => null`
 *    3. `async () => false`
 *    4. `() => {}`
 *    5. `() => undefined`
 *    6. `() => null`
 *    7. `() => false`
 *    8. `Promise.resolve()`
 *    9. `Promise.resolve(undefined)`
 *   10. Identity returns: `(x) => x`, single-line returning input
 *   11. Conditional log-only: `if (cfg.disabled) return; ...`
 *   12. TODO bodies: `// TODO: implement` followed by no real call
 *
 *  Layer 2 — REGISTRATION PRESENCE. Each of the expected register* functions
 *  MUST actually be CALLED in src/index.ts. If a registration is removed,
 *  the trigger goes silent — caught here.
 *
 * Failure mode this catches: a refactor that "temporarily" stubs a coach
 * monitor callback (e.g. during local debugging) and is committed without
 * restoring the real implementation. The behavior compiles, the unit tests
 * pass (they exercise the monitor module directly, not via boot wiring),
 * but production loses event-driven coach behavior silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX_PATH = path.join(PROJECT_ROOT, 'src/index.ts');

/**
 * The 5 register* callbacks that wire coach event triggers + monitor chains.
 * Each MUST be called in src/index.ts AND its callback body MUST NOT be a stub.
 *
 * D6.a — itemStateMonitor (storage post-write hook)
 * D6.b — chatMonitor (deps registration + agent post-turn fire chain)
 * D6.c — calendarMonitor (deps registration + calendar/sync post-process fire chain)
 */
const REQUIRED_REGISTRATIONS = [
  'registerItemStateMonitorCallback',
  'registerChatMessageCallback',
  'registerPostTurnChatCallback',
  'registerCalendarEventCallback',
  'registerCalendarEventMonitorCallback',
] as const;

/**
 * Stub patterns that, if found inside ANY register* callback body, indicate
 * the wiring is silently disabled. Patterns are regex-style (escaped where
 * necessary). Matching is case-sensitive.
 */
const STUB_PATTERNS: Array<{ name: string; matcher: RegExp }> = [
  { name: 'async-undefined', matcher: /async\s*\(\s*[^)]*\)\s*=>\s*undefined/ },
  { name: 'async-null', matcher: /async\s*\(\s*[^)]*\)\s*=>\s*null/ },
  { name: 'async-false', matcher: /async\s*\(\s*[^)]*\)\s*=>\s*false/ },
  { name: 'arrow-empty-body', matcher: /\(\s*[^)]*\)\s*=>\s*\{\s*\}/ },
  { name: 'arrow-undefined', matcher: /\(\s*[^)]*\)\s*=>\s*undefined\s*[,)]/ },
  { name: 'arrow-null', matcher: /\(\s*[^)]*\)\s*=>\s*null\s*[,)]/ },
  { name: 'arrow-false', matcher: /\(\s*[^)]*\)\s*=>\s*false\s*[,)]/ },
  { name: 'promise-resolve-empty', matcher: /Promise\.resolve\(\s*\)/ },
  { name: 'promise-resolve-undefined', matcher: /Promise\.resolve\(\s*undefined\s*\)/ },
  { name: 'identity-return', matcher: /\(\s*([a-zA-Z_]\w*)\s*\)\s*=>\s*\1\s*[,)]/ },
  { name: 'todo-implement', matcher: /\/\/\s*TODO[:\s].*implement/i },
  { name: 'todo-not-yet', matcher: /\/\/\s*not[\s_-]?yet|log\.warn\(['"]not\s+(yet\s+)?implement/i },
];

function readIndexSource(): string {
  return fs.readFileSync(INDEX_PATH, 'utf-8');
}

/**
 * Extract the body of the FIRST argument passed to each register* call.
 * Heuristic regex: match `registerName(\s*(...callback...)\s*)`. The callback
 * may span multiple lines; we capture the balanced paren contents.
 *
 * Returns a map: registration name → callback body string (the full first arg).
 */
function extractCallbackBodies(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const name of REQUIRED_REGISTRATIONS) {
    // Match `name(` then capture everything up to the matching `)`.
    // We do a simple paren-depth scan from the position of `name(`.
    const startMarker = `${name}(`;
    const startIdx = source.indexOf(startMarker);
    if (startIdx < 0) continue;
    let depth = 0;
    let i = startIdx + startMarker.length;
    const bodyStart = i;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) {
          result.set(name, source.slice(bodyStart, i));
          break;
        }
        depth--;
      }
      i++;
    }
  }
  return result;
}

describe('coach event-wiring lint (boot-time)', () => {
  const source = readIndexSource();

  describe('Layer 1 — registration presence', () => {
    for (const name of REQUIRED_REGISTRATIONS) {
      it(`${name} is called in src/index.ts`, () => {
        expect(
          source.includes(`${name}(`),
          `${name} must be called in src/index.ts to wire coach event triggers. ` +
            `If absent, the corresponding monitor will never fire in production. ` +
            `See ADR 020 D6 + boot-wiring section in src/index.ts step 10.5e.`,
        ).toBe(true);
      });
    }
  });

  describe('Layer 2 — stub pattern detection', () => {
    const bodies = extractCallbackBodies(source);

    for (const name of REQUIRED_REGISTRATIONS) {
      const body = bodies.get(name);
      it(`${name} callback body is not a stub`, () => {
        expect(
          body,
          `Could not extract callback body for ${name}. The static test heuristic ` +
            `requires the form "${name}(...callback...)" with the first argument ` +
            `being the callback. If the call site uses a different shape (e.g. ` +
            `passing a named function reference), update this test.`,
        ).toBeTruthy();
        if (!body) return;

        const matchedStubs = STUB_PATTERNS.filter((p) => p.matcher.test(body));
        expect(
          matchedStubs,
          `${name} callback body matches ${matchedStubs.length} stub pattern(s): ` +
            matchedStubs.map((p) => p.name).join(', ') +
            `. Stub callbacks silently disable production behavior. ` +
            `If you need a placeholder during refactor, leave the call site ` +
            `commented-out instead so this lint catches the missing registration.`,
        ).toEqual([]);
      });
    }
  });

  describe('Layer 3 — non-trivial body (smoke check)', () => {
    const bodies = extractCallbackBodies(source);
    for (const name of REQUIRED_REGISTRATIONS) {
      const body = bodies.get(name);
      it(`${name} callback body has at least one function-call expression`, () => {
        if (!body) return;
        // A real callback should at minimum CALL something (notifyX, fireY, etc.).
        // Pure-data returns (e.g. `() => itemId`) wouldn't count — but our coach
        // monitor callbacks should always invoke a side-effect function.
        const hasFunctionCall = /[a-zA-Z_]\w*\s*\(/.test(body.replace(/\(\s*[^)]*\)\s*=>/, ''));
        expect(
          hasFunctionCall,
          `${name} callback body has no function-call expression. ` +
            `Coach monitor callbacks must invoke notifyX, fireY, or inspectZ — ` +
            `pure-data returns indicate the wiring isn't doing anything.`,
        ).toBe(true);
      });
    }
  });
});
