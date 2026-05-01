/**
 * Unit tests for src/agent/compaction.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldCompact, compactSession } from '../../src/agent/compaction.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ModelProvider } from '../../src/providers/types.js';

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  // Enable auto-compact for compaction tests
  (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.autoCompact = true;
  (cfg as { context: { autoCompact: boolean; compactThreshold: number } }).context.compactThreshold = 0.75;
  return initMemory(cfg);
}

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

function makeMockProvider(summary = 'Mocked summary.'): ModelProvider {
  return {
    name: 'mock',
    call: vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: summary,
      tool_calls: [],
      provider: 'mock',
      model: 'mock-model',
    }),
  };
}

describe('shouldCompact', () => {
  it('returns false for empty history', () => {
    const mem = setup();
    void mem;
    const decision = shouldCompact([], cfg, 'claude', 'claude-sonnet-4-6');
    expect(decision.compact).toBe(false);
    expect(decision.estimated).toBe(0);
  });

  it('returns false when below threshold', () => {
    const smallHistory = [
      { id: 1, session_id: 1, role: 'user' as const, content: 'hi', tool_name: null, tool_input: null, tool_output: null, tool_use_id: null, created_at: new Date().toISOString() },
    ];
    const decision = shouldCompact(smallHistory, cfg, 'claude', 'claude-sonnet-4-6');
    // 'hi' = 2 chars = 0.5 tokens, limit=200000 → way below threshold
    expect(decision.compact).toBe(false);
  });

  it('returns true when estimated tokens >= threshold * limit', () => {
    // Make a config with a tiny limit to force compaction
    const miniCfg = makeTestConfig();
    (miniCfg as { context: { compactThreshold: number } }).context.compactThreshold = 0.5;
    // Override: set glm-5.1:cloud limit to 100 in providers
    (miniCfg.ai.providers as Record<string, { models: Record<string, string> }>)['ollama-cloud'] = {
      models: { 'glm-5.1:cloud': '100' },
    };
    // Build a history that is definitely > 50 tokens (50 * 4 = 200 chars)
    const bigContent = 'x'.repeat(300);
    const history = [
      { id: 1, session_id: 1, role: 'user' as const, content: bigContent, tool_name: null, tool_input: null, tool_output: null, tool_use_id: null, created_at: new Date().toISOString() },
    ];
    const decision = shouldCompact(history, miniCfg, 'ollama-cloud', 'glm-5.1:cloud');
    expect(decision.compact).toBe(true);
    expect(decision.limit).toBe(100);
    expect(decision.estimated).toBeGreaterThan(50);
  });
});

describe('compactSession', () => {
  it('archives history and inserts summary message', async () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(5001);

    // Insert some history
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'Hello!' });
    mem.messages.insert({ session_id: session.id, role: 'assistant', content: 'Hi there!' });

    const history = mem.messages.listRecent(session.id, 50);
    expect(history).toHaveLength(2);

    const mockProvider = makeMockProvider('Mocked summary of the convo.');

    const result = await compactSession({
      sessionId: session.id,
      trigger: 'manual',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      history,
      cfg,
      claudeProvider: mockProvider,
      primaryProvider: mockProvider,
      memory: mem,
      abortSignal: new AbortController().signal,
    });

    expect(result.summary).toBe('Mocked summary of the convo.');
    expect(result.originalTokens).toBeGreaterThan(0);
    expect(result.archiveId).toBeGreaterThan(0);

    // Archive row should exist
    const archived = mem.conversationArchive.listForSession(session.id);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.trigger).toBe('manual');
    expect(archived[0]!.original_message_count).toBe(2);
    expect(archived[0]!.first_message_id).toBeGreaterThan(0);
    expect(archived[0]!.last_message_id).toBeGreaterThanOrEqual(archived[0]!.first_message_id!);

    // Original messages should be gone
    const remaining = mem.messages.listRecent(session.id, 50);
    // Only the synthetic summary system message
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.role).toBe('system');
    // v1.4.1: summary now starts with the tagged header
    expect(remaining[0]!.content).toContain('[Prior conversation summary · messages');
    expect(remaining[0]!.content).toContain(`archive #${result.archiveId}`);
    expect(remaining[0]!.content).toContain('recall_archive');
    expect(remaining[0]!.content).toContain('Mocked summary of the convo.');
  });

  it('falls back to Claude when primary provider fails', async () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(5002);
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'Test message.' });
    const history = mem.messages.listRecent(session.id, 50);

    const failingProvider: ModelProvider = {
      name: 'failing',
      call: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    const claudeFallback = makeMockProvider('Claude fallback summary.');

    const result = await compactSession({
      sessionId: session.id,
      trigger: 'auto',
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      history,
      cfg,
      claudeProvider: claudeFallback,
      primaryProvider: failingProvider,
      memory: mem,
      abortSignal: new AbortController().signal,
    });

    expect(result.summary).toBe('Claude fallback summary.');
  });

  it('throws when both providers fail', async () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(5003);
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'Test.' });
    const history = mem.messages.listRecent(session.id, 50);

    const failProvider: ModelProvider = {
      name: 'fail',
      call: vi.fn().mockRejectedValue(new Error('all down')),
    };

    await expect(
      compactSession({
        sessionId: session.id,
        trigger: 'auto',
        provider: 'ollama-cloud',
        model: 'glm-5.1:cloud',
        history,
        cfg,
        claudeProvider: failProvider,
        primaryProvider: failProvider,
        memory: mem,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/compaction failed/i);
  });

  it('scrubs secrets from archived history JSON', async () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(5004);
    const secretContent = 'my api key is sk-ant-abcdefghij12345678901234567890';
    mem.messages.insert({ session_id: session.id, role: 'user', content: secretContent });
    const history = mem.messages.listRecent(session.id, 50);

    const mockProvider = makeMockProvider('summary');

    await compactSession({
      sessionId: session.id,
      trigger: 'manual',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      history,
      cfg,
      claudeProvider: mockProvider,
      primaryProvider: mockProvider,
      memory: mem,
      abortSignal: new AbortController().signal,
    });

    const archived = mem.conversationArchive.listForSession(session.id);
    expect(archived[0]!.full_history_json).not.toContain('sk-ant-');
    expect(archived[0]!.full_history_json).toContain('REDACTED');
  });

  it('sends empty tools array to provider (text-only output)', async () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(5005);
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'hi' });
    const history = mem.messages.listRecent(session.id, 50);

    const mockProvider = makeMockProvider('summary');

    await compactSession({
      sessionId: session.id,
      trigger: 'manual',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      history,
      cfg,
      claudeProvider: mockProvider,
      primaryProvider: mockProvider,
      memory: mem,
      abortSignal: new AbortController().signal,
    });

    const callArgs = (mockProvider.call as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArgs.tools).toEqual([]);
  });
});
