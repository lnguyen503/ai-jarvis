/**
 * Integration test for auto-compaction flow.
 *
 * Mocks the provider, fills history past the threshold,
 * then verifies:
 *  - archive row exists with correct metadata
 *  - history is replaced with a single synthetic summary message
 *  - turn result carries compactionEvent
 *  - subsequent turn uses the compacted history
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

// Mock providers
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

function setup(compactThreshold = 0.001) {
  _resetDb();
  cfg = makeTestConfig();
  // Enable auto-compact with a very low threshold to trigger on any content.
  // Also set a tiny context limit via provider models map so the estimate
  // exceeds the threshold even on small histories.
  (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.autoCompact = true;
  (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.compactThreshold = compactThreshold;
  // Force a tiny context limit (10 tokens) so any content triggers compaction
  (cfg.ai.providers as Record<string, { models: Record<string, string> }>)['claude'] = {
    models: { 'claude-sonnet-4-6': '10' },
  };
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  const claudeProvider = new ClaudeProvider(cfg);
  const ollamaProvider = new OllamaCloudProvider();
  const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider, ollamaProvider });
  return { agent, mem, cfg };
}

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
});

describe('auto-compaction integration flow', () => {
  it('runs compaction when threshold exceeded, archives history, inserts summary, returns compactionEvent', async () => {
    const { agent, mem } = setup(0.001); // nearly-zero threshold — always compacts
    const session = mem.sessions.getOrCreate(7001);

    // Pre-populate some history so there's something to compact
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'Previous message A' });
    mem.messages.insert({ session_id: session.id, role: 'assistant', content: 'Previous reply A' });

    // First call: the compaction summarize call returns a summary
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Compacted summary of the conversation.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    // Second call: the actual agent turn after compaction
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Hello after compaction.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent.turn({
      chatId: 7001,
      sessionId: session.id,
      userText: 'New message after compaction',
      abortSignal: new AbortController().signal,
    });

    // Turn should succeed
    expect(result.replyText).toBe('Hello after compaction.');

    // compactionEvent should be set
    expect(result.compactionEvent).toBeDefined();
    expect(result.compactionEvent!.originalTokens).toBeGreaterThan(0);
    expect(result.compactionEvent!.compressedTokens).toBeGreaterThan(0);

    // Archive should have one row
    const archived = mem.conversationArchive.listForSession(session.id);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.trigger).toBe('auto');
    expect(archived[0]!.original_message_count).toBeGreaterThanOrEqual(2);

    // Current messages should include: system summary + user new msg + assistant reply
    const msgs = mem.messages.listRecent(session.id, 50);
    const systemMsg = msgs.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('[Prior conversation summary · messages');
    expect(systemMsg!.content).toContain('Compacted summary of the conversation.');
  });

  it('does NOT compact when autoCompact is false', async () => {
    _resetDb();
    cfg = makeTestConfig();
    // Explicitly disabled
    (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.autoCompact = false;
    (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.compactThreshold = 0.001;

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider() });

    const session = mem.sessions.getOrCreate(7002);
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'message' });
    mem.messages.insert({ session_id: session.id, role: 'assistant', content: 'reply' });

    // Only one provider call expected (no compaction call)
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Normal reply.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent.turn({
      chatId: 7002,
      sessionId: session.id,
      userText: 'hello',
      abortSignal: new AbortController().signal,
    });

    expect(result.compactionEvent).toBeUndefined();
    expect(mockProviderCall).toHaveBeenCalledTimes(1);

    cleanupTmpRoot(cfg);
  });

  it('compactionEvent is undefined when no compaction occurred', async () => {
    // Use a very high threshold with NO tiny-limit override — no compaction
    _resetDb();
    cfg = makeTestConfig();
    (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.autoCompact = true;
    (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.compactThreshold = 0.9999;
    // Default claude limit is 200,000 — small history will not trigger

    const mem2 = initMemory(cfg);
    const safety2 = initSafety(cfg, mem2);
    const tools2 = registerTools({ config: cfg, logger: getLogger(), safety: safety2, memory: mem2 });
    const agent2 = initAgent({ config: cfg, logger: getLogger(), memory: mem2, tools: tools2, safety: safety2, claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider() });

    const session = mem2.sessions.getOrCreate(7003);

    // Only one call needed — no compaction
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'No compaction reply.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent2.turn({
      chatId: 7003,
      sessionId: session.id,
      userText: 'simple message',
      abortSignal: new AbortController().signal,
    });

    expect(result.compactionEvent).toBeUndefined();
    expect(result.replyText).toBe('No compaction reply.');

    cleanupTmpRoot(cfg);
    _resetDb();
  });
});
