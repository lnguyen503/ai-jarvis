/**
 * Static test — v1.21.0 production-wiring reachability lint.
 *
 * BINDING: ADR 021 D17 + 021-revisions + KNOWN_ISSUES v1.21.0 entry 9.
 *
 * Background — the 4-iteration trap class history:
 *  - v1.18.0 cross-review I2 (gateway plumbing dropped at boundary)
 *  - v1.19.0 Scalability CRIT-A (breaker stubs in buildCalendarSyncDeps)
 *  - v1.19.0 WARN-A (audit emission shims log-only)
 *  - v1.20.0 R1 (fireSpontaneousCoachTurn missing isCoachRun) + Scalability
 *    CRIT-A (recordCoachDM/recordUserMessage exported but never called)
 *  - v1.21.0 cross-review I1 + Anti-Slop F-A1/F-A2/F-A3 + Scalability
 *    CRITICAL-1.21.0.A/B/C/D (4 NEW unwired surfaces simultaneously)
 *
 * Pattern: helpers exported with correct signatures, unit-tested in isolation,
 * but ZERO production callers. Boot-wiring lint catches CONSUMER-side stubs;
 * cross-file reachability lint (`coach-prompt-builder-reachable.test.ts`)
 * catches DEAD EXPORTS. This lint extends the discipline to v1.21.0's
 * specific producer-side helpers.
 *
 * What this enforces: each named function below MUST have at least one call
 * site in src tree (outside its own definition file AND outside test files).
 *
 * Failure mode this catches: a future iteration ships a new helper, writes
 * unit tests, but forgets to thread the call into production. The shape-only
 * test passes; production behavior is missing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../');
const SRC_DIR = path.join(ROOT, 'src');

/**
 * v1.21.0 producer-side helpers that MUST have a production call site.
 * Each entry: { name: function/method exported; ownerFile: where it's defined
 * (call sites in this file don't count) }.
 */
const REQUIRED_REACHABLE = [
  // R6 path-sandbox — Scalability CRITICAL-1.21.0.A
  { name: 'wrapPathForBotIdentity', ownerFile: 'safety/botPathSandbox.ts' },

  // R2 self-echo drop — Cross-review I1, Anti-Slop F-A1, Scalability CRITICAL-1.21.0.B
  { name: 'recordOutgoing', ownerFile: 'memory/botSelfMessages.ts' },
  { name: 'isOurEcho', ownerFile: 'memory/botSelfMessages.ts' },

  // R3 inter-bot wrap — Anti-Slop F-A2, Scalability CRITICAL-1.21.0.D
  { name: 'wrapBotMessage', ownerFile: 'gateway/interBotContext.ts' },
  { name: 'maybeWrapBotHistoryEntry', ownerFile: 'gateway/interBotContext.ts' },

  // D10 loop protection — Anti-Slop F-A3, Scalability CRITICAL-1.21.0.C
  { name: 'checkBotToBotLoop', ownerFile: 'gateway/loopProtection.ts' },
  { name: 'recordBotToBotTurn', ownerFile: 'gateway/loopProtection.ts' },
  { name: 'resetBotToBotCounterOnUserMessage', ownerFile: 'gateway/loopProtection.ts' },

  // F1 ToolContext SSOT — Scalability CRITICAL-1.21.0.D
  { name: 'buildToolContext', ownerFile: 'tools/buildToolContext.ts' },

  // v1.21.1 — config rewrite per identity (closes 6th-iter trap class on cfg layer)
  { name: 'applyBotIdentityToConfig', ownerFile: 'config/applyBotIdentity.ts' },
] as const;

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

function isOwnerFile(filePath: string, ownerSuffix: string): boolean {
  const rel = path.relative(SRC_DIR, filePath).replace(/\\/g, '/');
  return rel === ownerSuffix;
}

function findCallSites(funcName: string, ownerSuffix: string): string[] {
  const callers: string[] = [];
  const callPattern = new RegExp(`\\b${funcName}\\s*\\(`);
  for (const file of collectSrcFiles(SRC_DIR)) {
    if (isOwnerFile(file, ownerSuffix)) continue;
    const source = readFileSync(file, 'utf-8');
    // Strip block + line comments before pattern matching.
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLine = noBlock
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    if (callPattern.test(noLine)) {
      callers.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  return callers;
}

describe('v1.21.0 production-wiring reachability', () => {
  for (const { name, ownerFile } of REQUIRED_REACHABLE) {
    it(`${name} (defined in ${ownerFile}) has >=1 production caller`, () => {
      const callers = findCallSites(name, ownerFile);
      expect(
        callers.length,
        `${name} (defined in src/${ownerFile}) has NO production callers in src/. ` +
          `This is the v1.18.0/v1.19.0/v1.20.0/v1.21.0 trap class — interface ` +
          `shipped, runtime wiring deferred. Wire the helper into its production ` +
          `call site (typically in gateway, agent, or safety/initSafety). ` +
          `If the helper is genuinely deferred, comment out its export and add a ` +
          `TODO in TODO.md so it shows up next iteration.`,
      ).toBeGreaterThanOrEqual(1);
    });
  }
});
