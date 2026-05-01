/**
 * Agent streaming integration tests (v1.12.0).
 *
 * Verifies:
 *   - When TurnParams.onTextDelta is provided and the provider implements
 *     streamText, the agent routes through streamText and forwards chunks.
 *   - When the callback is absent, agent routes through call() as before.
 *   - When the provider omits streamText, agent silently falls back to call().
 *   - onProviderCallStart fires before each provider invocation (one per
 *     iteration of the ReAct loop), enabling buffer-reset semantics.
 *
 * Mock pattern matches tests/unit/agent.turn.test.ts (vi.mock both
 * provider modules; expose __mockCall / __mockStream for setup).
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

vi.mock('../../src/providers/claude.js', () => {
  const mockCall = vi.fn();
  const mockStream = vi.fn();
  class MockClaudeProvider {
    readonly name = 'claude';
    call = mockCall;
    streamText = mockStream;
    static __mockCall = mockCall;
    static __mockStream = mockStream;
  }
  return {
    ClaudeProvider: MockClaudeProvider,
    createClaudeClient: vi.fn(() => ({})),
    callClaude: mockCall,
    __mockCall: mockCall,
    __mockStream: mockStream,
  };
});

vi.mock('../../src/providers/ollama-cloud.js', () => {
  const mockCall = vi.fn();
  const mockStream = vi.fn();
  class MockOllamaCloudProvider {
    readonly name = 'ollama-cloud';
    call = mockCall;
    streamText = mockStream;
  }
  return {
    OllamaCloudProvider: MockOllamaCloudProvider,
    __mockCall: mockCall,
    __mockStream: mockStream,
  };
});

import * as claudeMod from '../../src/providers/claude.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { OllamaCloudProvider } from '../../src/providers/ollama-cloud.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCall = (claudeMod as any).__mockCall as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStream = (claudeMod as any).__mockStream as ReturnType<typeof vi.fn>;

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  const claudeProvider = new ClaudeProvider(cfg);
  const ollamaProvider = new OllamaCloudProvider();
  const agent = initAgent({
    config: cfg,
    logger: getLogger(),
    memory: mem,
    tools,
    safety,
    claudeProvider,
    ollamaProvider,
  });
  return { agent, mem };
}

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
});

describe('agent streaming integration', () => {
  it('routes to streamText when onTextDelta is provided; forwards chunks', async () => {
    mockStream.mockImplementationOnce(async (params: { onTextDelta: (c: string) => void }) => {
      params.onTextDelta('Hello');
      params.onTextDelta(' world');
      return {
        stop_reason: 'end_turn',
        content: 'Hello world',
        tool_calls: [],
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      };
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);

    const deltas: string[] = [];
    const callStarts: number[] = [];
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'hi',
      abortSignal: new AbortController().signal,
      onTextDelta: (chunk) => deltas.push(chunk),
      onProviderCallStart: () => callStarts.push(Date.now()),
    });

    expect(mockStream).toHaveBeenCalledOnce();
    expect(mockCall).not.toHaveBeenCalled();
    expect(deltas).toEqual(['Hello', ' world']);
    expect(callStarts).toHaveLength(1);
    expect(result.replyText).toBe('Hello world');
  });

  it('falls back to call() when no streaming callbacks provided', async () => {
    mockCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'plain',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);

    await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'hi',
      abortSignal: new AbortController().signal,
    });

    expect(mockCall).toHaveBeenCalledOnce();
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('onProviderCallStart fires before each provider invocation (ReAct loop)', async () => {
    // First streamText: tool_use → forces a second iteration.
    // Second streamText: end_turn.
    // But agent's tool dispatcher will fail on an unknown tool — we'll
    // mock a known tool call. Use system_info which is always registered.
    let streamInvocation = 0;
    mockStream.mockImplementation(async (params: { onTextDelta: (c: string) => void }) => {
      streamInvocation++;
      if (streamInvocation === 1) {
        params.onTextDelta('Let me check...');
        return {
          stop_reason: 'tool_use',
          content: 'Let me check...',
          tool_calls: [
            { id: 'tc1', name: 'system_info', input: {} },
          ],
          provider: 'claude',
          model: 'claude-sonnet-4-6',
        };
      }
      params.onTextDelta('Done.');
      return {
        stop_reason: 'end_turn',
        content: 'Done.',
        tool_calls: [],
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      };
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);

    const callStarts: number[] = [];
    const deltas: string[] = [];
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'hi',
      abortSignal: new AbortController().signal,
      onTextDelta: (c) => deltas.push(c),
      onProviderCallStart: () => callStarts.push(Date.now()),
    });

    // Two streamText invocations → two onProviderCallStart fires.
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(callStarts.length).toBe(2);
    expect(deltas).toContain('Let me check...');
    expect(deltas).toContain('Done.');
    expect(result.replyText).toBe('Done.');
    expect(result.toolCalls).toBe(1);
  });
});
