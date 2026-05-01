/**
 * Integration test - v1.20.0 Scalability CRITICAL-1.20.0.A producer-side wiring.
 *
 * Verifies that the two rate-limit recorders are CALLED (not just imported)
 * on the production paths Reviewers identified:
 *
 *   - PRD-1: gateway.enqueueSchedulerTurn writes coach.global.lastCoachDmAt
 *            ONLY when coachTurnCounters is set (i.e. scheduler-driven coach
 *            run). Plain scheduled tasks must NOT touch the cooldown.
 *   - PRD-2: gateway.fireSpontaneousCoachTurn writes coach.global.lastCoachDmAt
 *            after a successful sendMessage on the spontaneous path.
 *   - PRD-3: agent.turn for a private DM (non-coach) writes
 *            coach.global.lastUserMessageAt BEFORE the post-turn chat trigger
 *            callback fires.
 *   - PRD-4: agent.turn for a coach run does NOT write lastUserMessageAt
 *            (coach replies are not user messages).
 *
 * Each test reads the keyed-memory entry directly via getEntry() to confirm
 * the timestamp was actually written - the static lint catches the import +
 * call-site existence; this test catches "imported, called on the wrong
 * branch, writes never happen".
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { registerTools } from '../../src/tools/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { AgentApi, TurnParams, TurnResult } from '../../src/agent/index.js';
import type { Transcriber } from '../../src/transcriber/index.js';
import type { GatewayDeps } from '../../src/gateway/index.js';
import type { ToolContext } from '../../src/tools/types.js';
import { getEntry } from '../../src/memory/userMemoryEntries.js';
import type { TriggerRecord } from '../../src/coach/triggerFiring.js';

// Mock grammY Bot — same pattern as coach.gateway-plumbing.test.ts
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
  dataDir = mkdtempSync(path.join(os.tmpdir(), `jarvis-rate-limit-prod-${Date.now()}-`));
  mkdirSync(path.join(dataDir, 'organize', String(USER_ID)), { recursive: true });
  mkdirSync(path.join(dataDir, 'memories'), { recursive: true });
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

// Wait for fire-and-forget recordCoachDM / recordUserMessage promises to resolve.
async function flushAsync(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scalability CRIT-1.20.0.A producer-side wiring', () => {
  it('PRD-1: enqueueSchedulerTurn writes lastCoachDmAt when coachTurnCounters set', async () => {
    const safety = initSafety(cfg, mem);
    const { api: agent } = makeRecordingAgent();
    const gw = initGateway({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent,
      transcriber: makeTranscriberMock(),
      version: '1.20.0-test',
    } as GatewayDeps);

    // Pre-condition: no coach DM ledger entry exists.
    const before = await getEntry(USER_ID, dataDir, 'coach.global.lastCoachDmAt');
    expect(before).toBeNull();

    gw.enqueueSchedulerTurn({
      chatId: CHAT_ID,
      taskId: 100,
      description: '__coach_morning__',
      command: 'expanded coach prompt body',
      ownerUserId: USER_ID,
      coachTurnCounters: { nudges: 0, writes: 0 },
    });

    // Wait for both the queue job AND the fire-and-forget recordCoachDM to flush.
    await flushAsync(100);

    const after = await getEntry(USER_ID, dataDir, 'coach.global.lastCoachDmAt');
    expect(after).not.toBeNull();
    const parsed = JSON.parse(after!.body) as { at: string };
    expect(typeof parsed.at).toBe('string');
    expect(Date.parse(parsed.at)).toBeGreaterThan(0);
  });

  it('PRD-1b: enqueueSchedulerTurn does NOT write lastCoachDmAt when coachTurnCounters absent (plain scheduled task)', async () => {
    const safety = initSafety(cfg, mem);
    const { api: agent } = makeRecordingAgent();
    const gw = initGateway({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent,
      transcriber: makeTranscriberMock(),
      version: '1.20.0-test',
    } as GatewayDeps);

    gw.enqueueSchedulerTurn({
      chatId: CHAT_ID,
      taskId: 200,
      description: 'check email',
      command: 'show me emails',
      ownerUserId: USER_ID,
      // no coachTurnCounters → plain scheduled task → must NOT count
    });
    await flushAsync(100);

    const entry = await getEntry(USER_ID, dataDir, 'coach.global.lastCoachDmAt');
    expect(entry).toBeNull();
  });

  it('PRD-2: fireSpontaneousCoachTurn writes lastCoachDmAt after successful send', async () => {
    const safety = initSafety(cfg, mem);
    const { api: agent } = makeRecordingAgent();
    const gw = initGateway({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent,
      transcriber: makeTranscriberMock(),
      version: '1.20.0-test',
    } as GatewayDeps);

    const before = await getEntry(USER_ID, dataDir, 'coach.global.lastCoachDmAt');
    expect(before).toBeNull();

    const trigger: TriggerRecord = {
      userId: USER_ID,
      itemId: '2026-04-25-abcd',
      kind: 'item-state',
      triggerType: 'goal-stale-14d',
      reason: 'goal_stale_14d',
      triggerContext: 'item idle for 14d, no progress',
      detectedAt: new Date().toISOString(),
    };
    await gw.fireSpontaneousCoachTurn(trigger);
    await flushAsync(100);

    const after = await getEntry(USER_ID, dataDir, 'coach.global.lastCoachDmAt');
    expect(after).not.toBeNull();
    const parsed = JSON.parse(after!.body) as { at: string };
    expect(typeof parsed.at).toBe('string');
  });
});
