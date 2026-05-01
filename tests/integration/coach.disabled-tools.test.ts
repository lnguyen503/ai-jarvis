/**
 * Integration tests: coach.disabledTools dispatcher enforcement (ADR 018 commit 8).
 *
 * ADR 018-revisions R6/F1 (CONVERGENT BLOCKING): the 8 default disabled tools
 * are rejected at the dispatcher level (UNAUTHORIZED_IN_CONTEXT) when
 * ctx.coachTurnCounters is defined (coach turn). Outside coach turns, all tools
 * remain accessible regardless of coach.disabledTools.
 *
 * Tests:
 *   R6/F1-1: organize_complete rejected in coach turn → UNAUTHORIZED_IN_CONTEXT
 *   R6/F1-2: each of the 8 default disabled tools → UNAUTHORIZED_IN_CONTEXT (parameterized)
 *   R6/F1-3: organize_create from a coach turn → dispatches normally (regression anchor)
 *   R6/F1-4: config override disabledTools = [] → all tools restored (admin escape hatch)
 *   R6/F1-5: non-coach turn → disabled-tool call accessible (gate only on coachTurnCounters)
 *   R6/F1-6: unknown tool still returns UNKNOWN_TOOL (not UNAUTHORIZED_IN_CONTEXT)
 *   R6/F1-7: organize_list accessible in a coach turn (not in disabledTools)
 *   R6/F1-8: coach turn with empty disabledTools → organize_complete accessible
 *   R6/F1-9: gate fires even when allowedToolNames is not set
 *  R6/F1-10: gate code is UNAUTHORIZED_IN_CONTEXT (exact match)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { registerTools, dispatch } from '../../src/tools/index.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { AppConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const USER_ID = 88001;

const stubLogger: ToolContext['logger'] = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => stubLogger,
  level: 'info',
} as unknown as ToolContext['logger'];

/** Minimal SafetyApi stub. */
const stubSafety = {
  isReadAllowed: () => true,
  isWriteAllowed: () => true,
  classifyCommand: () => ({ hardReject: false, requiresConfirmation: false }),
  scrub: (t: string) => t,
  scrubRecord: (d: Record<string, unknown>) => d,
  requiresConfirmation: () => false,
  addConfirmation: () => ({ id: 'test', expiresAt: new Date() }),
  consumeConfirmation: () => null,
  getConfirmation: () => null,
  listConfirmations: () => [],
  expireConfirmations: () => {},
};

let dataDir: string;
let mem: MemoryApi;
let cfg: AppConfig;

beforeEach(() => {
  _resetDb();
  dataDir = mkdtempSync(path.join(os.tmpdir(), `jarvis-coach-disabled-${Date.now()}-`));
  mkdirSync(path.join(dataDir, 'organize', String(USER_ID)), { recursive: true });

  const dbPath = path.join(dataDir, 'test.db');
  cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  mem = initMemory(cfg);

  // Register tools with the test config (no tavily, no google, no browser)
  registerTools({ config: cfg, logger: stubLogger, safety: stubSafety as unknown as ToolContext['safety'], memory: mem });
});

function cleanup() {
  try { mem.close(); } catch (_e) { /* non-fatal */ }
  _resetDb();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* non-fatal */ }
}

/** Build a ToolContext with the given coach config and optional coachTurnCounters. */
function makeCtx(opts: {
  coachDisabledTools?: string[];
  coachTurnCounters?: { nudges: number; writes: number };
}): ToolContext {
  const coachDisabledTools = opts.coachDisabledTools ?? cfg.coach?.disabledTools ?? [
    'run_command', 'schedule', 'organize_complete', 'organize_delete',
    'forget_memory', 'calendar_delete_event', 'calendar_update_event', 'gmail_draft',
  ];

  const configWithCoach: AppConfig = {
    ...cfg,
    coach: {
      enabled: true,
      disabledTools: coachDisabledTools,
    },
  };

  return {
    sessionId: 1,
    chatId: USER_ID,
    userId: USER_ID,
    logger: stubLogger,
    config: configWithCoach,
    memory: mem,
    safety: stubSafety as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
    coachTurnCounters: opts.coachTurnCounters,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coach.disabledTools dispatcher enforcement (commit 8)', () => {
  it('R6/F1-1: organize_complete rejected in coach turn → UNAUTHORIZED_IN_CONTEXT', async () => {
    const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
    const result = await dispatch('organize_complete', { itemId: '2026-01-01-abcd', reason: 'done' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
    cleanup();
  });

  const DEFAULT_DISABLED_TOOLS = [
    'run_command',
    'schedule',
    'organize_complete',
    'organize_delete',
    'forget_memory',
    'calendar_delete_event',
    'calendar_update_event',
    'gmail_draft',
  ] as const;

  it.each(DEFAULT_DISABLED_TOOLS.map((t) => [t]))(
    'R6/F1-2: %s rejected in coach turn → UNAUTHORIZED_IN_CONTEXT',
    async (toolName) => {
      const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
      const result = await dispatch(toolName, {}, ctx);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
      cleanup();
    },
  );

  it('R6/F1-3: organize_create accessible in coach turn (not disabled)', async () => {
    const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
    // organize_create with minimal valid args — expect NOT UNAUTHORIZED_IN_CONTEXT
    // (may fail for other reasons like file system, but not the disabled-tool gate)
    const result = await dispatch('organize_create', { type: 'task', title: 'test item' }, ctx);
    // The important assertion: not an UNAUTHORIZED_IN_CONTEXT error
    if (!result.ok) {
      expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
    }
    cleanup();
  });

  it('R6/F1-4: config override disabledTools = [] → organize_complete accessible in coach turn', async () => {
    const ctx = makeCtx({ coachDisabledTools: [], coachTurnCounters: { nudges: 0, writes: 0 } });
    const result = await dispatch('organize_complete', { itemId: '2026-01-01-abcd', reason: 'done' }, ctx);
    // With empty disabledTools, gate doesn't fire → result should NOT be UNAUTHORIZED_IN_CONTEXT
    if (!result.ok) {
      expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
    }
    cleanup();
  });

  it('R6/F1-5: non-coach turn (no coachTurnCounters) → organize_complete accessible', async () => {
    const ctx = makeCtx({ coachTurnCounters: undefined }); // no coachTurnCounters = normal DM turn
    const result = await dispatch('organize_complete', { itemId: '2026-01-01-abcd', reason: 'done' }, ctx);
    // Gate must NOT fire for non-coach turns
    if (!result.ok) {
      expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
    }
    cleanup();
  });

  it('R6/F1-6: unknown tool → UNKNOWN_TOOL (not UNAUTHORIZED_IN_CONTEXT)', async () => {
    const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
    const result = await dispatch('not_a_real_tool', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_TOOL');
    cleanup();
  });

  it('R6/F1-7: organize_list accessible in coach turn (not in default disabledTools)', async () => {
    const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
    const result = await dispatch('organize_list', { filter: 'active' }, ctx);
    // organize_list is safe for coach; must not be rejected by the disabled-tool gate
    if (!result.ok) {
      expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
    }
    cleanup();
  });

  it('R6/F1-8: coach turn with empty disabledTools + organize_complete → accessible', async () => {
    // Admin override: all tools restored
    const ctx = makeCtx({ coachDisabledTools: [], coachTurnCounters: { nudges: 0, writes: 0 } });
    const result = await dispatch('organize_complete', { itemId: '2026-01-01-abcd', reason: 'done' }, ctx);
    if (!result.ok) {
      expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
    }
    cleanup();
  });

  it('R6/F1-9: gate fires even when allowedToolNames is not set', async () => {
    const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
    // Do NOT set allowedToolNames → should still gate on coachTurnCounters + disabledTools
    expect(ctx.allowedToolNames).toBeUndefined();
    const result = await dispatch('organize_complete', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
    cleanup();
  });

  it('R6/F1-10: UNAUTHORIZED_IN_CONTEXT code is exact string (no typos)', async () => {
    const ctx = makeCtx({ coachTurnCounters: { nudges: 0, writes: 0 } });
    const result = await dispatch('forget_memory', {}, ctx);
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
    cleanup();
  });
});
