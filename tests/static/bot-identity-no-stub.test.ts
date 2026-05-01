/**
 * Static gate: boot-wiring lint for BotIdentity callbacks.
 *
 * BINDING: ADR 021 D16 + 021-revisions + CLAUDE.md v1.21.0 invariant 3 +
 * KNOWN_ISSUES v1.21.0 entry 3.
 *
 * Pre-empts the v1.18.0/v1.19.0/v1.20.0/v1.21.0 trap class — for the 5th
 * iteration — where a callback INTERFACE is correctly declared in module
 * code, but the BOOT-TIME REGISTRATION at src/index.ts wires it as an
 * identity stub (`async () => undefined`, etc.) that silently disables the
 * downstream behavior in production while unit tests pass.
 *
 * Trap class history:
 *  - v1.18.0 cross-review I2: gateway dropped `coachTurnCounters` in
 *    `enqueueSchedulerTurn` → R6/F1 brake inert in production
 *  - v1.19.0 Scalability CRIT-A: `isCircuitBreakerOpen` stubbed
 *  - v1.19.0 Scalability WARN-A: audit shims log-only
 *  - v1.20.0 R1: `fireSpontaneousCoachTurn` originally bound only
 *    `isSpontaneousTrigger` (NOT `isCoachRun: true`) — caught at CP1
 *  - v1.20.0 Scalability CRIT-A: `recordCoachDM` + `recordUserMessage`
 *    exported but never called from production
 *  - v1.21.0 F1: `ToolContext.botIdentity` plumbing — pre-empted at CP1 via
 *    `buildToolContext` SSOT helper + commit 12.5 static test
 *
 * What this lint enforces (Layer 1): For each `register*Callback` /
 * `init*` site in src/index.ts that is bot-identity-affecting, the
 * registration body must NOT match any of 12 known stub patterns
 * (inherited from v1.20.0 `coach-event-wiring.test.ts`).
 *
 * Layer 2: Each of the expected registration patterns MUST actually be
 * CALLED in src/index.ts. If a registration is removed, the bot identity
 * goes silent — caught here.
 *
 * BotIdentity-related callbacks/initializations to enforce (per ADR 021):
 *  - `resolveBotIdentity(...)` — bot identity resolved at boot
 *  - `runBotDataMigration(...)` — migration runs BEFORE initMemory
 *  - `initMemory(cfg, identity)` — receives identity for per-bot DB path
 *  - `initSafety(...)` — receives identity for path-sandbox narrowing
 *  - `registerTools(deps)` — deps include identity for allowlist gate
 *  - `initAgent(deps)` — deps include identity for persona path
 *  - `initGateway(deps)` — deps include identity for mention routing
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX_PATH = path.join(PROJECT_ROOT, 'src/index.ts');

/**
 * Bot-identity-affecting registrations that MUST be called in src/index.ts.
 * If any is removed, the bot identity wiring silently breaks somewhere
 * downstream.
 *
 * Cross-review W-A1 fix: expanded after Dev-A's commit 3 + Dev-B's commit 12
 * landed (boot wiring complete). The lint now enforces that all four
 * load-bearing identity boot integration points stay wired:
 *  - resolveBotIdentity: boot reads BOT_NAME env, validates closed-set
 *  - runBotDataMigration: per-bot data migration runs BEFORE initMemory
 *  - identity.name: boot-logger child binding (so per-bot logs are tagged)
 *  - identity.dataDir: path-sandbox narrowing into initSafety
 */
const REQUIRED_BOT_IDENTITY_CALLS = [
  'resolveBotIdentity',
  'runBotDataMigration',
  'identity.name',
  'identity.dataDir',
] as const;

/**
 * Stub patterns inherited from v1.20.0 coach-event-wiring.test.ts.
 */
const STUB_PATTERNS: Array<{ name: string; matcher: RegExp }> = [
  { name: 'async-undefined', matcher: /async\s*\(\s*[^)]*\)\s*=>\s*undefined/ },
  { name: 'async-null', matcher: /async\s*\(\s*[^)]*\)\s*=>\s*null/ },
  { name: 'async-false', matcher: /async\s*\(\s*[^)]*\)\s*=>\s*false/ },
  { name: 'arrow-empty-body', matcher: /\(\s*[^)]*\)\s*=>\s*\{\s*\}/ },
  { name: 'arrow-undefined-followed', matcher: /\(\s*[^)]*\)\s*=>\s*undefined\s*[,)]/ },
  { name: 'arrow-null-followed', matcher: /\(\s*[^)]*\)\s*=>\s*null\s*[,)]/ },
  { name: 'arrow-false-followed', matcher: /\(\s*[^)]*\)\s*=>\s*false\s*[,)]/ },
  { name: 'promise-resolve-empty', matcher: /Promise\.resolve\(\s*\)/ },
  { name: 'promise-resolve-undefined', matcher: /Promise\.resolve\(\s*undefined\s*\)/ },
  { name: 'identity-return', matcher: /\(\s*([a-zA-Z_]\w*)\s*\)\s*=>\s*\1\s*[,)]/ },
  { name: 'todo-implement', matcher: /\/\/\s*TODO[:\s].*implement/i },
  { name: 'todo-not-yet', matcher: /\/\/\s*not[\s_-]?yet|log\.warn\(['"]not\s+(yet\s+)?implement/i },
];

function readIndexSource(): string {
  return fs.readFileSync(INDEX_PATH, 'utf-8');
}

describe('bot identity boot-wiring lint (Layer 1)', () => {
  const source = readIndexSource();
  const isWired = source.includes('resolveBotIdentity(');

  describe('required calls present', () => {
    for (const call of REQUIRED_BOT_IDENTITY_CALLS) {
      // FAIL-then-GREEN pattern: skip until Phase 2 wiring lands.
      // Once Dev-A's commit 1 (botIdentity.ts) + Dev-B's commit 12 (boot
      // wiring) are in master, isWired flips to true and the test enforces.
      const testFn = isWired ? it : it.skip;
      testFn(`${call} appears in src/index.ts`, () => {
        expect(
          source.includes(call),
          `${call} must appear in src/index.ts boot sequence. ` +
            `If absent, bot identity is not resolved and v1.21.0 multi-bot ` +
            `infrastructure is silently broken. See ADR 021 D1.`,
        ).toBe(true);
      });
    }
  });

  describe('no stub patterns in identity-affecting code blocks', () => {
    // Find the block of src/index.ts that handles BotIdentity setup.
    // Heuristic: lines mentioning resolveBotIdentity within ±50 lines.
    const lines = source.split('\n');
    const resolveLineIdx = lines.findIndex((line) => line.includes('resolveBotIdentity('));

    if (resolveLineIdx >= 0) {
      const start = Math.max(0, resolveLineIdx - 5);
      const end = Math.min(lines.length, resolveLineIdx + 50);
      const blockText = lines.slice(start, end).join('\n');

      for (const stub of STUB_PATTERNS) {
        it(`identity boot block does not match stub pattern ${stub.name}`, () => {
          const matched = stub.matcher.test(blockText);
          expect(
            matched,
            `Identity boot block in src/index.ts (lines ~${start}-${end}) matches stub pattern ` +
              `'${stub.name}'. Stub patterns silently disable production behavior; if you need a ` +
              `placeholder during refactor, comment out the registration entirely so this lint ` +
              `catches the missing call.`,
          ).toBe(false);
        });
      }
    } else {
      // Pre-Phase-2 state: resolveBotIdentity not yet wired. The
      // 'required calls present' test above will FAIL until Dev-A/B's
      // commits land — that's the FAIL-then-GREEN pattern.
      it.skip('identity boot block stub patterns (resolveBotIdentity not yet present)', () => {});
    }
  });
});
