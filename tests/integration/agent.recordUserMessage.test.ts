/**
 * Integration test - v1.20.0 Scalability CRITICAL-1.20.0.A producer-side wiring.
 *
 * Asserts that agent.turn() writes coach.global.lastUserMessageAt for private
 * DMs (params.userId set, !isCoachRun) BEFORE the post-turn chat callback fires.
 * Sister test to coach.rateLimitProducerWiring.test.ts (which covers the gateway
 * coach paths) - this one covers the agent post-turn user-message path.
 *
 *   - PRD-3: agent.turn writes lastUserMessageAt for non-coach private DM
 *   - PRD-4: agent.turn does NOT write lastUserMessageAt for coach run
 *            (coach replies are not user messages; D12 must not gate against them)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { initAgent } from '../../src/agent/index.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { registerTools } from '../../src/tools/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';
import { getEntry } from '../../src/memory/userMemoryEntries.js';
import path from 'node:path';

vi.mock('../../src/providers/claude.js', () => {
  const mockCall = vi.fn();
  class MockClaudeProvider {
    readonly name = 'claude';
    call = mockCall;
    static __mockCall = mockCall;
  }
  return {
    ClaudeProvider: MockClaudeProvider,
    createClaudeClient: vi.fn(() => ({})),
    callClaude: mockCall,
    __mockCall: mockCall,
  };
});

vi.mock('../../src/providers/ollama-cloud.js', () => {
  const mockCall = vi.fn();
  class MockOllamaCloudProvider {
    readonly name = 'ollama-cloud';
    call = mockCall;
    static __mockCall = mockCall;
  }
  return { OllamaCloudProvider: MockOllamaCloudProvider, __mockCall: mockCall };
});

import * as claudeMod from '../../src/providers/claude.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { OllamaCloudProvider } from '../../src/providers/ollama-cloud.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProviderCall = (claudeMod as any).__mockCall as ReturnType<typeof vi.fn>;

let cfg: AppConfig;

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

async function flushAsync(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('agent.turn writes lastUserMessageAt (CRIT-1.20.0.A producer wiring)', () => {
  it('PRD-3: writes lastUserMessageAt for non-coach private DM', async () => {
    _resetDb();
    cfg = makeTestConfig();
    (cfg as { context: { autoCompact: boolean } }).context.autoCompact = false;

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({
      config: cfg, logger: getLogger(), memory: mem, tools, safety,
      claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider(),
    });

    const userId = 7777;
    const session = mem.sessions.getOrCreate(userId);

    // Provider returns a single end_turn so agent.turn reaches the primary success path.
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'hello back',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const dataDir = path.resolve(path.dirname(cfg.memory.dbPath));

    // Pre-condition: no debounce ledger entry.
    const before = await getEntry(userId, dataDir, 'coach.global.lastUserMessageAt');
    expect(before).toBeNull();

    const result = await agent.turn({
      chatId: userId,
      sessionId: session.id,
      userText: 'hi',
      userId,
      abortSignal: new AbortController().signal,
    });
    expect(result.replyText).toBe('hello back');

    // Wait for fire-and-forget recordUserMessage to flush.
    await flushAsync(50);

    const after = await getEntry(userId, dataDir, 'coach.global.lastUserMessageAt');
    expect(after).not.toBeNull();
    const parsed = JSON.parse(after!.body) as { at: string };
    expect(typeof parsed.at).toBe('string');
    expect(Date.parse(parsed.at)).toBeGreaterThan(0);
  });

  it('PRD-4: does NOT write lastUserMessageAt when isCoachRun=true', async () => {
    _resetDb();
    cfg = makeTestConfig();
    (cfg as { context: { autoCompact: boolean } }).context.autoCompact = false;

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({
      config: cfg, logger: getLogger(), memory: mem, tools, safety,
      claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider(),
    });

    const userId = 8888;
    const session = mem.sessions.getOrCreate(userId);

    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'coach nudge text',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const dataDir = path.resolve(path.dirname(cfg.memory.dbPath));

    await agent.turn({
      chatId: userId,
      sessionId: session.id,
      userText: 'expanded coach prompt body',
      userId,
      isCoachRun: true,
      coachTurnCounters: { nudges: 0, writes: 0 },
      abortSignal: new AbortController().signal,
    });
    await flushAsync(50);

    const entry = await getEntry(userId, dataDir, 'coach.global.lastUserMessageAt');
    expect(entry).toBeNull();
  });
});
