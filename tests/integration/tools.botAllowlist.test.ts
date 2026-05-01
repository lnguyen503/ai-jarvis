/**
 * Integration tests: per-bot allowlist gate at dispatcher (ADR 021 D6 + CP1 W1 + R6).
 *
 * Gate ordering (CP1 W1 BINDING):
 *   GATE 1: per-bot specialist allowlist (outermost)
 *   GATE 2: per-turn allowedToolNames
 *   GATE 3: per-coach-turn coach.disabledTools
 *
 * Tests:
 *   D6-1: ai-tony (specialist) — read_file is in allowlist → passes GATE 1.
 *   D6-2: ai-tony (specialist) — organize_create NOT in allowlist → TOOL_NOT_AVAILABLE_FOR_BOT.
 *   D6-3: ai-tony (specialist) — schedule NOT in allowlist → TOOL_NOT_AVAILABLE_FOR_BOT.
 *   D6-4: ai-tony (specialist) — run_command NOT in allowlist (CP1 R6) → TOOL_NOT_AVAILABLE_FOR_BOT.
 *   D6-5: ai-jarvis (full, no ctx.botIdentity scope restriction) — organize_create passes.
 *   D6-6: error code is exactly TOOL_NOT_AVAILABLE_FOR_BOT (not UNAUTHORIZED_IN_CONTEXT).
 *   W1-1: GATE 1 fires before GATE 2 — specialist allowlist supersedes allowedToolNames.
 *   W1-2: GATE 1 fires before GATE 3 — specialist allowlist supersedes coach.disabledTools.
 *   W1-3: GATE 2 fires before GATE 3 — per-turn override supersedes coach denylist (full-scope).
 *   D6-7: no botIdentity in ctx (undefined) → gates inert, dispatch proceeds normally.
 *   D6-8: all 9 specialist tools pass GATE 1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { registerTools, dispatch } from '../../src/tools/index.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { BotIdentity } from '../../src/config/botIdentity.js';
import { SPECIALIST_TOOL_ALLOWLIST } from '../../src/config/botIdentity.js';

// ---------------------------------------------------------------------------
// Stub infrastructure
// ---------------------------------------------------------------------------

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

const stubSafety: ToolContext['safety'] = {
  isPathAllowed: () => true,
  isReadAllowed: () => true,
  isWriteAllowed: () => true,
  isPathAllowedInRoots: () => true,
  isReadAllowedInRoots: () => true,
  isWriteAllowedInRoots: () => true,
  filterDeniedEntries: (_dir: string, entries: string[]) => entries,
  classifyCommand: () => ({ hardReject: false, requiresConfirmation: false }),
  scrub: (t: string) => t,
  scrubRecord: (d: Record<string, unknown>) => d,
  requireConfirmation: () => ({
    type: 'confirmation_required',
    confirmationId: 'test',
    promptText: 'test',
    expiresAt: Date.now() + 300000,
  }),
  consumeConfirmation: () => null,
  hasPending: () => false,
} as unknown as ToolContext['safety'];

function makeTonyIdentity(): BotIdentity {
  return {
    name: 'ai-tony',
    scope: 'specialist',
    telegramToken: 'test-token',
    personaPath: '/tmp/tony.md',
    dataDir: '/tmp/data/ai-tony',
    webappPort: 7889,
    healthPort: 7888,
    allowedTools: SPECIALIST_TOOL_ALLOWLIST,
    aliases: [],
  additionalReadPaths: [],
  };
}

function makeJarvisIdentity(): BotIdentity {
  return {
    name: 'ai-jarvis',
    scope: 'full',
    telegramToken: 'test-token',
    personaPath: '/tmp/jarvis.md',
    dataDir: '/tmp/data/ai-jarvis',
    webappPort: 7879,
    healthPort: 7878,
    allowedTools: new Set<string>(), // empty = no restriction
    aliases: [],
  additionalReadPaths: [],
  };
}

let tmpDir: string;
let mem: MemoryApi;
let cfg: AppConfig;

beforeEach(() => {
  _resetDb();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowlist-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  mem = initMemory(cfg);
  registerTools({
    config: cfg,
    logger: stubLogger,
    safety: stubSafety,
    memory: mem,
  });
});

afterEach(() => {
  try { mem.close(); } catch (_e) { /* non-fatal */ }
  _resetDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* non-fatal */ }
});

function makeCtx(
  identity: BotIdentity | undefined,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    sessionId: 1,
    chatId: 12345,
    userId: 12345,
    logger: stubLogger,
    config: cfg,
    memory: mem,
    safety: stubSafety,
    abortSignal: new AbortController().signal,
    botIdentity: identity,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GATE 1 — specialist allowlist
// ---------------------------------------------------------------------------

describe('GATE 1: specialist allowlist', () => {
  it('D6-2: organize_create rejected for ai-tony → TOOL_NOT_AVAILABLE_FOR_BOT', async () => {
    const ctx = makeCtx(makeTonyIdentity());
    const result = await dispatch('organize_create', {
      userId: 12345,
      title: 'test task',
      type: 'task',
    }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('D6-3: schedule rejected for ai-tony → TOOL_NOT_AVAILABLE_FOR_BOT', async () => {
    const ctx = makeCtx(makeTonyIdentity());
    const result = await dispatch('schedule', {
      description: 'test',
      cron: '0 8 * * *',
      command: 'hello',
    }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('D6-4: run_command rejected for ai-tony (CP1 R6 — not in SPECIALIST_TOOL_ALLOWLIST)', async () => {
    const ctx = makeCtx(makeTonyIdentity());
    const result = await dispatch('run_command', { command: 'echo hello', shell: 'powershell' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('D6-6: error code is exactly TOOL_NOT_AVAILABLE_FOR_BOT (not UNAUTHORIZED_IN_CONTEXT)', async () => {
    const ctx = makeCtx(makeTonyIdentity());
    const result = await dispatch('organize_create', { userId: 1, title: 'x', type: 'task' }, ctx);
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
    expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
  });

  it('D6-5: ai-jarvis (full scope) — system_info passes GATE 1', async () => {
    const ctx = makeCtx(makeJarvisIdentity());
    const result = await dispatch('system_info', {}, ctx);
    // system_info returns ok:true (or fails for a different reason, not GATE 1)
    expect(result.error?.code).not.toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('D6-7: no botIdentity in ctx (undefined) → gate inert, dispatch proceeds normally', async () => {
    const ctx = makeCtx(undefined);
    const result = await dispatch('system_info', {}, ctx);
    // Should NOT get TOOL_NOT_AVAILABLE_FOR_BOT
    expect(result.error?.code).not.toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('D6-8: all 9 specialist tools pass GATE 1 for ai-tony', async () => {
    // We just verify GATE 1 doesn't block them (actual tool execution may fail for other reasons)
    const ctx = makeCtx(makeTonyIdentity());
    for (const toolName of SPECIALIST_TOOL_ALLOWLIST) {
      const result = await dispatch(toolName, {}, ctx);
      // Should NOT be rejected by GATE 1
      expect(
        result.error?.code,
        `${toolName} was rejected by GATE 1 (TOOL_NOT_AVAILABLE_FOR_BOT)`,
      ).not.toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
    }
  });
});

// ---------------------------------------------------------------------------
// Gate ordering (CP1 W1)
// ---------------------------------------------------------------------------

describe('CP1 W1: gate ordering', () => {
  it('W1-1: GATE 1 fires before GATE 2 — specialist rejects even when tool is in allowedToolNames', async () => {
    // ai-tony + allowedToolNames includes organize_create (group-mode might allow it)
    // organize_create is NOT in SPECIALIST_TOOL_ALLOWLIST → GATE 1 must reject first
    const ctx = makeCtx(makeTonyIdentity(), {
      allowedToolNames: new Set(['organize_create', 'read_file']),
    });
    const result = await dispatch('organize_create', { userId: 1, title: 'x', type: 'task' }, ctx);
    expect(result.ok).toBe(false);
    // Must be GATE 1 error (TOOL_NOT_AVAILABLE_FOR_BOT), not GATE 2 (UNAUTHORIZED_IN_CONTEXT)
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('W1-2: GATE 1 fires before GATE 3 — specialist rejects even inside a coach turn', async () => {
    const ctx = makeCtx(makeTonyIdentity(), {
      coachTurnCounters: { nudges: 0, writes: 0 },
    });
    const result = await dispatch('organize_create', { userId: 1, title: 'x', type: 'task' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE_FOR_BOT');
  });

  it('W1-3: GATE 2 fires before GATE 3 for full-scope bot', async () => {
    // Full scope bot (ai-jarvis) in a coach turn
    // allowedToolNames DOES NOT include run_command
    // coach.disabledTools also includes run_command
    // GATE 2 should fire first → UNAUTHORIZED_IN_CONTEXT
    const cfgWithCoach = {
      ...cfg,
      coach: { enabled: true, disabledTools: ['run_command'] },
    } as AppConfig;

    const ctx: ToolContext = {
      sessionId: 1,
      chatId: 12345,
      userId: 12345,
      logger: stubLogger,
      config: cfgWithCoach,
      memory: mem,
      safety: stubSafety,
      abortSignal: new AbortController().signal,
      botIdentity: makeJarvisIdentity(),
      allowedToolNames: new Set(['read_file', 'system_info']), // run_command not here
      coachTurnCounters: { nudges: 0, writes: 0 },
    };

    const result = await dispatch('run_command', { command: 'echo', shell: 'powershell' }, ctx);
    expect(result.ok).toBe(false);
    // GATE 2 fires before GATE 3 → UNAUTHORIZED_IN_CONTEXT
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
  });
});
