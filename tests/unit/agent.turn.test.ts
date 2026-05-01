/**
 * F-05: Integration tests for agent/index.ts (agent ReAct loop).
 * Mocks the Claude provider to avoid real HTTP calls.
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

// Mock providers — factories cannot reference outer variables (vi.mock is hoisted).
// We expose the mock fn via the module's __mockCall property for test setup.

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
  }
  return { OllamaCloudProvider: MockOllamaCloudProvider, __mockCall: mockCall };
});

// Import the mocked modules to get access to the mock fns
import * as claudeMod from '../../src/providers/claude.js';
import * as ollamaMod from '../../src/providers/ollama-cloud.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { OllamaCloudProvider } from '../../src/providers/ollama-cloud.js';

// Access mock via the exported __mockCall — typed as any since the module type doesn't know it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProviderCall = (claudeMod as any).__mockCall as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mockOllamaCall = (ollamaMod as any).__mockCall as ReturnType<typeof vi.fn>;

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
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

describe('agent/index.ts — ReAct loop', () => {
  it('returns assistant text on end_turn with no tool calls', async () => {
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Hello, I am Jarvis.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'Hi',
      abortSignal: new AbortController().signal,
    });

    expect(result.replyText).toBe('Hello, I am Jarvis.');
    expect(result.toolCalls).toBe(0);
    expect(mockProviderCall).toHaveBeenCalledOnce();
  });

  it('executes a tool and continues to end_turn', async () => {
    // First call: provider wants to call system_info tool
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [{ id: 'tu_001', name: 'system_info', input: {} }],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    // Second call: provider responds with text after seeing tool result
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'System info retrieved.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'What is the system info?',
      abortSignal: new AbortController().signal,
    });

    expect(result.replyText).toBe('System info retrieved.');
    expect(result.toolCalls).toBe(1);
    expect(mockProviderCall).toHaveBeenCalledTimes(2);
  });

  it('returns stopped message when abortSignal fires before first provider call', async () => {
    const ac = new AbortController();
    ac.abort('user_stop');

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'Do something',
      abortSignal: ac.signal,
    });

    expect(result.replyText).toBe('Stopped.');
    expect(mockProviderCall).not.toHaveBeenCalled();
  });

  it('returns loop-exhausted error when max iterations reached', async () => {
    // Always respond with tool_use (no end_turn) to exhaust the loop
    mockProviderCall.mockResolvedValue({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [{ id: 'tu_loop', name: 'system_info', input: {} }],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem, cfg: localCfg } = setup();
    // Use a small maxToolIterations for the test
    (localCfg.ai as { maxToolIterations: number }).maxToolIterations = 3;
    const session = mem.sessions.getOrCreate(12345);
    const result = await agent.turn({
      chatId: 12345,
      sessionId: session.id,
      userText: 'Loop forever',
      abortSignal: new AbortController().signal,
    });

    expect(result.replyText).toMatch(/maximum number of tool calls/i);
    expect(mockProviderCall).toHaveBeenCalledTimes(3);
  });

  it('runConfirmedCommand dispatches run_command directly', async () => {
    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);

    // run_command with shell=none just runs via execa — no real shell invocation for simple echo
    const result = await agent.runConfirmedCommand({
      chatId: 12345,
      sessionId: session.id,
      command: 'echo hello',
      shell: 'none',
      abortSignal: new AbortController().signal,
    });

    // Should not throw — result should be a replyText
    expect(typeof result.replyText).toBe('string');
    expect(result.toolCalls).toBe(1);
    // Provider not called for runConfirmedCommand
    expect(mockProviderCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fix W1 — audit row emitted AFTER dispatch, capturing result.data.outcome
// ---------------------------------------------------------------------------
describe('agent tool audit — Fix W1 (outcome captured post-dispatch)', () => {
  it('audit row includes ok:true and outcome:null for tools without data.outcome', async () => {
    // system_info returns ok:true but no data.outcome
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [{ id: 'tu_audit_1', name: 'system_info', input: {} }],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Done.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(99001);
    await agent.turn({
      chatId: 99001,
      sessionId: session.id,
      userText: 'What is the system?',
      abortSignal: new AbortController().signal,
    });

    // Inspect audit rows written during the turn.
    const rows = mem.auditLog.listRecent(10);
    const toolCallRow = rows.find((r) => {
      type AuditDetail = { tool?: string };
      const d = JSON.parse(r.detail_json) as AuditDetail;
      return d.tool === 'system_info';
    });
    expect(toolCallRow).toBeDefined();
    type AuditDetail = { tool?: string; ok?: boolean; outcome?: unknown };
    const detail = JSON.parse(toolCallRow!.detail_json) as AuditDetail;
    expect(detail.ok).toBe(true);
    expect(detail.outcome).toBeNull();
  });

  it('audit row is emitted for unknown tool call (ok:false)', async () => {
    // An unregistered tool name causes dispatch to return ok:false.
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [{ id: 'tu_audit_fail', name: 'nonexistent_tool_xyz', input: {} }],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'Error handled.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const { agent, mem } = setup();
    const session = mem.sessions.getOrCreate(99002);
    await agent.turn({
      chatId: 99002,
      sessionId: session.id,
      userText: 'Call nonexistent tool',
      abortSignal: new AbortController().signal,
    });

    // An audit row should have been emitted (ok:false for unknown tool).
    const rows = mem.auditLog.listRecent(10);
    const toolCallRow = rows.find((r) => {
      type AuditDetail = { tool?: string };
      const d = JSON.parse(r.detail_json) as AuditDetail;
      return d.tool === 'nonexistent_tool_xyz';
    });
    expect(toolCallRow).toBeDefined();
    type AuditDetail = { tool?: string; ok?: boolean };
    const detail = JSON.parse(toolCallRow!.detail_json) as AuditDetail;
    expect(detail.ok).toBe(false);
  });
});
