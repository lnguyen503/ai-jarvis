/**
 * Integration test: agent turn that triggers send_file via tool_use.
 *
 * The mocked provider emits a tool_use for send_file.
 * The mocked TelegramAdapter is injected via TurnParams.telegram.
 * Asserts end-to-end flow including audit row in file_sends.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initAgent } from '../../src/agent/index.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { makeMockTelegramAdapter } from '../fixtures/mockTelegramAdapter.js';
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

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

describe('agent send_file flow', () => {
  it('executes send_file tool end-to-end: file sent, audit row inserted, agent completes', async () => {
    _resetDb();
    cfg = makeTestConfig();
    const root = cfg.filesystem.allowedPaths[0]!;

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider() });

    // Create a real file in the allowed root
    const testFilePath = path.join(root, 'output.md');
    fs.writeFileSync(testFilePath, '# Generated output\n\nSome content here.');

    const session = mem.sessions.getOrCreate(7500);
    const mockTelegram = makeMockTelegramAdapter();
    const toolCallId = 'tu_sendfile_01';

    // Round 1: provider emits tool_use for send_file
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          name: 'send_file',
          input: {
            path: testFilePath,
            caption: 'Here is your generated file',
            preview: false,
          },
        },
      ],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    // Round 2: provider gives final answer after tool result
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: "I've sent the file to your chat.",
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent.turn({
      chatId: 7500,
      sessionId: session.id,
      userText: 'Please send me the output file.',
      abortSignal: new AbortController().signal,
      telegram: mockTelegram,
    });

    // Agent completed successfully
    expect(result.replyText).toBe("I've sent the file to your chat.");
    expect(result.toolCalls).toBe(1);

    // TelegramAdapter.sendDocument called once with correct args
    expect(mockTelegram.sendDocument).toHaveBeenCalledOnce();
    const [callChatId, callPath, callOpts] = mockTelegram.sendDocument.mock.calls[0]!;
    expect(callChatId).toBe(7500);
    expect(callPath).toBe(testFilePath);
    expect(callOpts?.caption).toBe('Here is your generated file');

    // Audit row inserted in file_sends
    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const auditRow = rows[0]!;
    expect(auditRow.ok).toBe(1);
    expect(auditRow.basename).toBe('output.md');
    expect(auditRow.kind).toBe('document');
    expect(auditRow.telegram_message_id).toBe(42); // mock default

    // Tool result message persisted to messages table
    const msgs = mem.messages.listRecent(session.id, 50);
    const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_name === 'send_file');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_output).toContain('output.md');
  });

  it('agent handles send_file PATH_DENIED gracefully and continues loop', async () => {
    _resetDb();
    cfg = makeTestConfig();

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider() });

    const session = mem.sessions.getOrCreate(7501);
    const mockTelegram = makeMockTelegramAdapter();

    // Provider asks to send a system file that is outside allowed paths
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [
        {
          id: 'tu_sendfile_denied',
          name: 'send_file',
          input: { path: 'C:\\Windows\\System32\\kernel32.dll', preview: false },
        },
      ],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    // After seeing the denial, provider gives a normal response
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'That file is not accessible.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent.turn({
      chatId: 7501,
      sessionId: session.id,
      userText: 'Send me kernel32.dll',
      abortSignal: new AbortController().signal,
      telegram: mockTelegram,
    });

    expect(result.replyText).toBe('That file is not accessible.');
    expect(result.toolCalls).toBe(1);

    // Adapter should NOT have been called (rejected before reaching Telegram)
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();

    // Tool result message contains the denial
    const msgs = mem.messages.listRecent(session.id, 50);
    const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_name === 'send_file');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_output).toContain('Access denied');
  });
});
