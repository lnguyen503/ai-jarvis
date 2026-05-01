/**
 * Static gate: `src/coach/**` MUST NOT import from `src/agent/index`.
 *
 * BINDING: ADR 020 D16 + 020-revisions W2 + KNOWN_ISSUES v1.20.0.
 *
 * Coach modules are downstream of the agent (the agent invokes coach turns
 * via `gateway.fireSpontaneousCoachTurn` / `gateway.enqueueSchedulerTurn`).
 * Coach also receives the agent's post-turn callback (`registerPostTurnChatCallback`)
 * as a one-way registration: agent exposes a hook; coach REGISTERS via that
 * hook at boot. Coach must never import `agent/index` directly — that would
 * create a cycle (agent → gateway → coach → agent).
 *
 * Allowed: coach may import `src/agent/types` (types-only edge; no runtime
 * cycle). Coach may import shared types from agent if they're in a leaf
 * module — but NOT `src/agent/index.ts` itself.
 *
 * Failure mode this catches: a refactor that "shortcuts" by having coach/
 * directly import agent.turn() and invoke it. That breaks the gateway
 * indirection that lets us route through `buildCoachTurnArgs()` SSOT
 * (the v1.20.0 R1 fix for the gateway-plumbing trap class 4th iteration).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbiddenImports } from './_helpers/import-edges.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COACH_DIR = path.join(PROJECT_ROOT, 'src/coach');

describe('coach/ does not import agent/index', () => {
  it('no file in src/coach/** imports from src/agent/index', () => {
    // Allow agent/types (types-only edge; not a runtime cycle).
    const violations = findForbiddenImports(
      COACH_DIR,
      /\/agent\//,
      ['/agent/types.js', '/agent/types'], // types-only allowed
    );
    expect(
      violations,
      `Forbidden coach → agent imports detected:\n` +
        violations.map((v) => `  ${v.file} imports ${v.specifier}`).join('\n') +
        `\n\nCoach must invoke the agent via gateway (fireSpontaneousCoachTurn or ` +
        `enqueueSchedulerTurn), routed through buildCoachTurnArgs() SSOT helper. ` +
        `Direct imports of agent/index would bypass the helper and re-open the ` +
        `gateway-plumbing trap class (4 iterations counting; see ADR 020-revisions R1).`,
    ).toEqual([]);
  });
});
