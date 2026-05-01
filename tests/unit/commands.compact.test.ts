/**
 * Unit tests for src/commands/compact.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleCompact } from '../../src/commands/compact.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ModelProvider } from '../../src/providers/types.js';

let cfg: AppConfig;

function makeMockProvider(summary = 'Summary text.'): ModelProvider {
  return {
    name: 'mock',
    call: vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: summary,
      tool_calls: [],
      provider: 'mock',
      model: 'mock',
    }),
  };
}

function makeCtx(chatId: number, fromId?: number): { chat: { id: number }; from?: { id: number }; reply: ReturnType<typeof vi.fn>; message?: { text: string } } {
  const replySpy = vi.fn().mockResolvedValue(undefined);
  return {
    chat: { id: chatId },
    from: fromId !== undefined ? { id: fromId } : undefined,
    reply: replySpy,
    message: { text: '/compact' },
  };
}

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  return initMemory(cfg);
}

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

describe('handleCompact', () => {
  it('replies "Nothing to compact yet." for empty session', async () => {
    const mem = setup();
    const ctx = makeCtx(9001);
    const mockProvider = makeMockProvider();

    const deps = {
      config: cfg,
      memory: mem,
      claudeProvider: mockProvider,
      getProvider: () => mockProvider,
    };

    await handleCompact(ctx as never, deps);

    expect(ctx.reply).toHaveBeenCalledWith('Nothing to compact yet.');
  });

  it('refuses with "Nothing to compact yet." if <5 messages and no archive', async () => {
    const mem = setup();
    const ctx = makeCtx(9002);
    const session = mem.sessions.getOrCreate(9002);
    // Insert only 3 messages (< 5)
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'a' });
    mem.messages.insert({ session_id: session.id, role: 'assistant', content: 'b' });
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'c' });

    const mockProvider = makeMockProvider();
    const deps = {
      config: cfg,
      memory: mem,
      claudeProvider: mockProvider,
      getProvider: () => mockProvider,
    };

    await handleCompact(ctx as never, deps);
    expect(ctx.reply).toHaveBeenCalledWith('Nothing to compact yet.');
  });

  it('compacts and replies with token notice for ≥5 messages', async () => {
    const mem = setup();
    const ctx = makeCtx(9003);
    const session = mem.sessions.getOrCreate(9003);

    for (let i = 0; i < 6; i++) {
      mem.messages.insert({ session_id: session.id, role: 'user', content: `message ${i}` });
    }

    const mockProvider = makeMockProvider('Compact summary.');
    const deps = {
      config: cfg,
      memory: mem,
      claudeProvider: mockProvider,
      getProvider: () => mockProvider,
    };

    await handleCompact(ctx as never, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Context compacted'),
      expect.anything(),
    );
  });

  it('replies error message when compaction fails', async () => {
    const mem = setup();
    const ctx = makeCtx(9004);
    const session = mem.sessions.getOrCreate(9004);

    for (let i = 0; i < 6; i++) {
      mem.messages.insert({ session_id: session.id, role: 'user', content: `m${i}` });
    }

    const failProvider: ModelProvider = {
      name: 'fail',
      call: vi.fn().mockRejectedValue(new Error('provider down')),
    };

    const deps = {
      config: cfg,
      memory: mem,
      claudeProvider: failProvider,
      getProvider: () => failProvider,
    };

    await handleCompact(ctx as never, deps);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Compaction failed'),
    );
  });

  it('refuses with "Just compacted" if < 5 messages and recent archive', async () => {
    const mem = setup();
    const ctx = makeCtx(9005);
    const session = mem.sessions.getOrCreate(9005);

    // Insert a recent archive entry (within 60 seconds)
    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'manual',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 1000,
      compressed_tokens: 100,
      original_message_count: 20,
      full_history_json: '[]',
      summary_text: 'Prior summary.',
    });

    // Insert 3 messages (< 5)
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'a' });
    mem.messages.insert({ session_id: session.id, role: 'assistant', content: 'b' });
    mem.messages.insert({ session_id: session.id, role: 'user', content: 'c' });

    const mockProvider = makeMockProvider();
    const deps = {
      config: cfg,
      memory: mem,
      claudeProvider: mockProvider,
      getProvider: () => mockProvider,
    };

    await handleCompact(ctx as never, deps);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Just compacted'),
    );
  });
});
