/**
 * Static test — agent/index.ts must NOT import userOverrideParser (ADR 019 R3).
 *
 * ADR 019 R3 binding: `agent.turn()` does NOT auto-invoke the NL parser on every
 * user message. The parser is only called by:
 *   1. coach turns (via coach_log_user_override tool in coachOverrideTool.ts)
 *   2. explicit chat commands (/coach back-off X etc. in coachSubcommands.ts)
 *
 * This static test asserts that src/agent/index.ts has no import of userOverrideParser.
 * Mirrors the v1.18.0 invariant-1 static-test pattern.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentIndexPath = path.resolve(__dirname, '../../src/agent/index.ts');

describe('ADR 019 R3 — agent/index.ts must not import userOverrideParser', () => {
  const agentSource = readFileSync(agentIndexPath, 'utf8');

  it('T-R3-7: agent/index.ts does not import userOverrideParser', () => {
    expect(agentSource).not.toContain('userOverrideParser');
  });

  it('T-R3-7b: agent/index.ts does not import parseOverrideIntents', () => {
    expect(agentSource).not.toContain('parseOverrideIntents');
  });

  it('T-R3-7c: agent/index.ts does not call parseOverrideIntents (belt-and-suspenders)', () => {
    // Even if the function were re-exported elsewhere and imported indirectly,
    // the direct call to parseOverrideIntents must not appear in agent/index.ts.
    expect(agentSource).not.toContain('parseOverrideIntents(');
  });
});
