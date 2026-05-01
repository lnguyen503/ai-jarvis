/**
 * Integration test for the recall_archive tool recall flow.
 *
 * Seeds a session with one archive containing a known snippet,
 * then simulates the mocked provider emitting a tool_use for recall_archive.
 * Asserts the tool_result contains the snippet and the archive_id.
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

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

describe('agent recall flow', () => {
  it('executes recall_archive tool and returns matching snippet from archive', async () => {
    _resetDb();
    cfg = makeTestConfig();
    // Disable auto-compaction — we seed the archive manually
    (cfg as { context: { autoCompact: boolean } }).context.autoCompact = false;

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider() });

    const session = mem.sessions.getOrCreate(6001);

    // Seed an archive with a known unique snippet
    const knownSnippet = 'the sacred incantation foo-bar-baz-42';
    const historyJson = JSON.stringify([
      {
        id: 500,
        session_id: session.id,
        role: 'user',
        content: `remember to use ${knownSnippet} as the deployment passphrase`,
        tool_name: null,
        tool_input: null,
        tool_output: null,
        tool_use_id: null,
        created_at: '2026-04-14T18:00:00.000Z',
      },
    ]);

    const archiveId = mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 50,
      compressed_tokens: 10,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Discussed deployment passphrase.',
      first_message_id: 500,
      last_message_id: 500,
    });

    // Insert synthetic summary message (as compaction would)
    mem.messages.insert({
      session_id: session.id,
      role: 'system',
      content:
        `[Prior conversation summary · messages 500-500 · archive #${archiveId}]\n` +
        `If the user references something not in this summary, call the \`recall_archive\` tool with a search query and archive_id=${archiveId} to retrieve the full original context from SQLite.\n\n` +
        'Discussed deployment passphrase (details not retained in summary).',
    });

    // Round 1: model emits a tool_use for recall_archive
    const toolCallId = 'tu_recall_01';
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          name: 'recall_archive',
          input: {
            query: 'incantation',
            archive_id: archiveId,
            max_results: 5,
          },
        },
      ],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    // Round 2: model generates a final answer after seeing the tool result
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'The passphrase was foo-bar-baz-42.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent.turn({
      chatId: 6001,
      sessionId: session.id,
      userText: 'What was the incantation we discussed earlier?',
      abortSignal: new AbortController().signal,
    });

    // Agent should have completed successfully
    expect(result.replyText).toBe('The passphrase was foo-bar-baz-42.');
    expect(result.toolCalls).toBe(1);

    // The tool result persisted to messages should contain the snippet
    const msgs = mem.messages.listRecent(session.id, 50);
    const toolResultMsg = msgs.find(
      (m) => m.role === 'tool' && m.tool_name === 'recall_archive',
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.tool_output).toContain('incantation');
    expect(toolResultMsg!.tool_output).toContain(String(archiveId));
  });

  it('tool returns empty-match string and agent continues normally', async () => {
    _resetDb();
    cfg = makeTestConfig();
    (cfg as { context: { autoCompact: boolean } }).context.autoCompact = false;

    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const agent = initAgent({ config: cfg, logger: getLogger(), memory: mem, tools, safety, claudeProvider: new ClaudeProvider(cfg), ollamaProvider: new OllamaCloudProvider() });

    const session = mem.sessions.getOrCreate(6002);
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'hello' });

    const toolCallId = 'tu_recall_02';
    // Provider emits recall_archive tool_use with a query that won't match anything
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          name: 'recall_archive',
          input: {
            query: 'xyzzy frobnicator nonexistent',
            max_results: 5,
          },
        },
      ],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    // After seeing empty result, model gives a normal response
    mockProviderCall.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: 'I could not find that in the archive.',
      tool_calls: [],
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });

    const result = await agent.turn({
      chatId: 6002,
      sessionId: session.id,
      userText: 'Do you remember xyzzy?',
      abortSignal: new AbortController().signal,
    });

    expect(result.ok === undefined || result.replyText).toBeTruthy();
    expect(result.replyText).toBe('I could not find that in the archive.');
    expect(result.toolCalls).toBe(1);

    const msgs = mem.messages.listRecent(session.id, 50);
    const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_name === 'recall_archive');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_output).toContain('No matches');
  });
});
