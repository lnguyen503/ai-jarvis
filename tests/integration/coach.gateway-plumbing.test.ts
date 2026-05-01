/**
 * End-to-end regression test: scheduler → gateway → agent.turn → coach turn
 * → coachTurnCounters reach the dispatcher → UNAUTHORIZED_IN_CONTEXT for
 * disabled tools (v1.18.0 P2 fix loop, Item 1 — convergent CRIT).
 *
 * Anchors the gateway boundary so the field cannot be silently dropped again:
 *   - cross-review I1+I2 (gateway plumbing gap + field-name mismatch)
 *   - Anti-Slop F1   (R6/F1 disabledTools enforcement INERT in production)
 *   - Scalability CRITICAL-1.18.0.A (per-turn caps INERT in production)
 *
 * Tests:
 *   GP-1: gateway.enqueueSchedulerTurn forwards isCoachRun=true to agent.turn
 *         when scheduler passes coachTurnCounters
 *   GP-2: gateway.enqueueSchedulerTurn forwards isCoachRun=false (omits/false)
 *         when scheduler does NOT pass coachTurnCounters (non-coach task)
 *   GP-3: with coachTurnCounters set, dispatch() rejects each disabled tool
 *         with UNAUTHORIZED_IN_CONTEXT — proves the dispatcher gate fires
 *         when the gateway has done its job
 *   GP-4: with coachTurnCounters absent, dispatch() admits the same disabled
 *         tools — proves the gate is gated on the counters (regression anchor
 *         against accidentally hard-coding the gate active in non-coach turns)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { registerTools, dispatch } from '../../src/tools/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { AgentApi, TurnParams, TurnResult } from '../../src/agent/index.js';
import type { Transcriber } from '../../src/transcriber/index.js';
import type { GatewayDeps } from '../../src/gateway/index.js';
import type { ToolContext } from '../../src/tools/types.js';

// Mock grammY Bot — same shape as gateway.textTurn.test.ts
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
  class MockBot {
    api = {
      token: 'mock-bot-token',
      sendMessage: vi.fn().mockResolvedValue({}),
      sendChatAction: vi.fn().mockResolvedValue({}),
    };
    use(_fn: unknown) {}
    command(_cmd: string, _h: unknown) {}
    on(_event: string, _h: unknown) {}
    catch(_fn: unknown) {}
    async start() {}
    async stop() {}
  }
  return { ...actual, Bot: MockBot };
});

vi.mock('../../src/gateway/health.js', () => ({
  createHealthServer: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { initGateway } from '../../src/gateway/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 12345;
const CHAT_ID = 12345;

let cfg: AppConfig;
let mem: MemoryApi;
let dataDir: string;

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

beforeEach(() => {
  _resetDb();
  dataDir = mkdtempSync(path.join(os.tmpdir(), `jarvis-coach-gw-${Date.now()}-`));
  mkdirSync(path.join(dataDir, 'organize', String(USER_ID)), { recursive: true });
  cfg = makeTestConfig({ memory: { dbPath: path.join(dataDir, 'test.db'), maxHistoryMessages: 50 } });
  mem = initMemory(cfg);
  registerTools({
    config: cfg,
    logger: stubLogger,
    safety: stubSafety as unknown as ToolContext['safety'],
    memory: mem,
  });
});

afterEach(() => {
  try { mem.close(); } catch { /* non-fatal */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  if (cfg) cleanupTmpRoot(cfg);
  vi.clearAllMocks();
});

function makeTranscriberMock(): Transcriber {
  return {
    transcribeVoice: vi.fn().mockResolvedValue({ text: 'transcribed', durationMs: 100 }),
  };
}

/**
 * Build an AgentApi mock that records every TurnParams it receives so the
 * test can assert on `isCoachRun`.
 */
function makeRecordingAgent(): { api: AgentApi; calls: TurnParams[] } {
  const calls: TurnParams[] = [];
  const turn = vi.fn(async (params: TurnParams): Promise<TurnResult> => {
    calls.push(params);
    return { replyText: 'mock reply', toolCalls: 0 };
  });
  const api: AgentApi = {
    turn,
    runConfirmedCommand: vi.fn().mockResolvedValue({ replyText: 'done', toolCalls: 1 } as TurnResult),
  };
  return { api, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coach gateway plumbing (P2 fix Item 1 — convergent CRIT)', () => {
  it('GP-1: gateway forwards isCoachRun=true when scheduler passes coachTurnCounters', async () => {
    const safety = initSafety(cfg, mem);
    const { api: agent, calls } = makeRecordingAgent();

    const deps: GatewayDeps = {
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent,
      transcriber: makeTranscriberMock(),
      version: '1.18.0-test',
    };
    const gw = initGateway(deps);

    gw.enqueueSchedulerTurn({
      chatId: CHAT_ID,
      taskId: 1,
      description: '__coach__',
      command: 'expanded coach prompt body',
      ownerUserId: USER_ID,
      coachTurnCounters: { nudges: 0, writes: 0 },
    });

    // The queue runs the job microtask-async; wait briefly for it to flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(calls.length).toBe(1);
    expect(calls[0]!.isCoachRun).toBe(true);
    expect(calls[0]!.userId).toBe(USER_ID);
  });

  it('GP-2: gateway forwards isCoachRun=false when scheduler omits coachTurnCounters', async () => {
    const safety = initSafety(cfg, mem);
    const { api: agent, calls } = makeRecordingAgent();

    const deps: GatewayDeps = {
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent,
      transcriber: makeTranscriberMock(),
      version: '1.18.0-test',
    };
    const gw = initGateway(deps);

    // No coachTurnCounters → non-coach scheduled task path.
    gw.enqueueSchedulerTurn({
      chatId: CHAT_ID,
      taskId: 2,
      description: 'check email',
      command: 'show me emails',
      ownerUserId: USER_ID,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(calls.length).toBe(1);
    expect(calls[0]!.isCoachRun).toBe(false);
  });

  it('GP-3: with coachTurnCounters set, dispatch rejects organize_complete with UNAUTHORIZED_IN_CONTEXT', async () => {
    // This is the END of the chain — the scheduler ships it, the gateway
    // ships isCoachRun, agent.turn() builds the counters, and dispatch()
    // enforces the gate. We test the dispatch end directly to prove the
    // sentinel works once the upstream plumbing is in place (GP-1).
    const cfgWithDisabled: AppConfig = {
      ...cfg,
      coach: {
        enabled: true,
        disabledTools: ['organize_complete', 'forget_memory', 'run_command'],
      },
    };

    const ctx: ToolContext = {
      sessionId: 1,
      chatId: CHAT_ID,
      userId: USER_ID,
      logger: stubLogger,
      config: cfgWithDisabled,
      memory: mem,
      safety: stubSafety as unknown as ToolContext['safety'],
      abortSignal: new AbortController().signal,
      coachTurnCounters: { nudges: 0, writes: 0 },
    };

    const result = await dispatch('organize_complete', { id: 'irrelevant' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
  });

  it('GP-4: without coachTurnCounters, dispatch admits the same tool (gate is gated on the counters)', async () => {
    // Negative regression anchor: if a future refactor accidentally enables
    // the coach disabledTools gate for ALL turns (not just coach turns),
    // this test catches it. The same disabled tool MUST be reachable when
    // the counters are absent.
    const cfgWithDisabled: AppConfig = {
      ...cfg,
      coach: {
        enabled: true,
        disabledTools: ['organize_complete'],
      },
    };

    const ctx: ToolContext = {
      sessionId: 1,
      chatId: CHAT_ID,
      userId: USER_ID,
      logger: stubLogger,
      config: cfgWithDisabled,
      memory: mem,
      safety: stubSafety as unknown as ToolContext['safety'],
      abortSignal: new AbortController().signal,
      // coachTurnCounters: undefined — non-coach turn
    };

    const result = await dispatch('organize_complete', { id: 'irrelevant' }, ctx);
    // The dispatcher gate at tools/index.ts:303 must NOT fire here. We don't
    // care if the call succeeds (it likely fails on input validation since
    // 'irrelevant' is not a real id) — only that the rejection code is NOT
    // UNAUTHORIZED_IN_CONTEXT (i.e., the gate is gated correctly).
    expect(result.error?.code).not.toBe('UNAUTHORIZED_IN_CONTEXT');
  });
});
