/**
 * Tests for silent Claude fallback when Ollama Cloud fails.
 * Verifies: Ollama failure → silent fallback to Claude, user sees no error banner.
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

// Mock providers — vi.mock is hoisted, cannot reference outer variables.
// Expose mock fns via __mockCall on the module export.

vi.mock('../../src/providers/claude.js', () => {
  const mockCall = vi.fn();
  class MockClaudeProvider {
    readonly name = 'claude';
    call = mockCall;
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
  }
  return { OllamaCloudProvider: MockOllamaCloudProvider, __mockCall: mockCall };
});

import * as claudeMod from '../../src/providers/claude.js';
import * as ollamaMod from '../../src/providers/ollama-cloud.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { OllamaCloudProvider } from '../../src/providers/ollama-cloud.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClaudeCall = (claudeMod as any).__mockCall as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOllamaCall = (ollamaMod as any).__mockCall as ReturnType<typeof vi.fn>;

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  // Enable routing so Ollama is the first choice
  cfg.ai.routing.enabled = true;
  cfg.ai.routing.logRoutingDecisions = false;
  cfg.ai.routing.fallbackToClaudeOnError = true;
  cfg.ai.defaultProvider = 'ollama-cloud';
  cfg.ai.defaultModel = 'glm-5.1:cloud';
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  const claudeProvider = new ClaudeProvider(cfg);
  const ollamaProvider = new OllamaCloudProvider();
  const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider, ollamaProvider });
  return { agent, mem, safety, cfg };
}

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
});

describe('agent fallback to Claude on Ollama failure', () => {
  it('falls back to Claude when Ollama throws HTTP error', async () => {
    // Ollama fails
    mockOllamaCall.mockRejectedValueOnce(
      Object.assign(new Error('Ollama Cloud HTTP 503: Service Unavailable'), {
        code: 'OLLAMA_HTTP_ERROR',
        status: 503,
      }),
    );
    // Claude succeeds
    mockClaudeCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Response from Claude fallback.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'Hello from fallback test',
      abortSignal: new AbortController().signal,
    });

    // User sees Claude's response, not an error
    expect(result.replyText).toBe('Response from Claude fallback.');
    expect(result.toolCalls).toBe(0);
    expect(mockOllamaCall).toHaveBeenCalledOnce();
    expect(mockClaudeCall).toHaveBeenCalledOnce();
  });

  it('falls back to Claude when Ollama throws network error', async () => {
    mockOllamaCall.mockRejectedValueOnce(new TypeError('fetch failed'));
    mockClaudeCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Fallback response.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'network error test',
      abortSignal: new AbortController().signal,
    });

    expect(result.replyText).toBe('Fallback response.');
    expect(mockClaudeCall).toHaveBeenCalledOnce();
  });

  it('does NOT fall back when fallbackToClaudeOnError is false', async () => {
    mockOllamaCall.mockRejectedValueOnce(new Error('Ollama Cloud HTTP 500: error'));

    const { agent, mem, cfg } = setup();
    cfg.ai.routing.fallbackToClaudeOnError = false;

    const session = mem.sessions.getOrCreate(12345);
    await expect(
      agent.turn({
        chatId: 12345,
        sessionId: session.id,
        userText: 'no fallback test',
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    expect(mockClaudeCall).not.toHaveBeenCalled();
  });

  it('user reply contains model response text, not error message', async () => {
    mockOllamaCall.mockRejectedValueOnce(new Error('timeout'));
    mockClaudeCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'I can help you with that.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'test',
      abortSignal: new AbortController().signal,
    });

    // Must not contain any error-like text
    expect(result.replyText).not.toMatch(/error|timeout|fail|503/i);
    expect(result.replyText).toBe('I can help you with that.');
  });

  it('does not fall back when provider is already Claude (failure propagates)', async () => {
    // Direct Claude failure should propagate
    _resetDb();
    const localCfg = makeTestConfig();
    localCfg.ai.routing.enabled = false;
    localCfg.ai.defaultProvider = 'claude';
    localCfg.ai.defaultModel = 'claude-sonnet-4-6';
    localCfg.ai.routing.fallbackToClaudeOnError = true;

    const localMem = initMemory(localCfg);
    const localSafety = initSafety(localCfg, localMem);
    const localTools = registerTools({ config: localCfg, logger: getLogger(), safety: localSafety, memory: localMem });
    const localAgent = initAgent({
      config: localCfg,
      logger: getLogger(),
      memory: localMem,
      tools: localTools,
      safety: localSafety,
      claudeProvider: new ClaudeProvider(localCfg),
      ollamaProvider: new OllamaCloudProvider(),
    });

    mockClaudeCall.mockRejectedValueOnce(
      Object.assign(new Error('Claude API error (500)'), { code: 'CLAUDE_UNREACHABLE' }),
    );

    const session = localMem.sessions.getOrCreate(12345);
    await expect(
      localAgent.turn({
        chatId: 12345,
        sessionId: session.id,
        userText: 'test',
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    cleanupTmpRoot(localCfg);
  });
});
