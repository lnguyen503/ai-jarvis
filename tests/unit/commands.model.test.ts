/**
 * Tests for /model command handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleModel } from '../../src/commands/model.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AppConfig } from '../../src/config/schema.js';

// Minimal grammY Context mock
function makeCtx(text: string, chatId = 12345) {
  const replies: string[] = [];
  return {
    chat: { id: chatId },
    message: { text },
    reply: vi.fn(async (msg: string) => {
      replies.push(msg);
      return { message_id: 1 };
    }),
    _replies: replies,
  };
}

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  const mem = initMemory(cfg);
  cfg.ai.premiumProvider = 'claude';
  cfg.ai.premiumModel = 'claude-sonnet-4-6';
  cfg.ai.defaultProvider = 'ollama-cloud';
  cfg.ai.defaultModel = 'glm-5.1:cloud';
  return { cfg, mem };
}

beforeEach(() => {
  _resetDb();
});

describe('/model command', () => {
  it('shows auto-routing status when no pin is set', async () => {
    const { cfg, mem } = setup();
    const ctx = makeCtx('/model');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleModel(ctx as any, { config: cfg, memory: mem });
    expect(ctx.reply).toHaveBeenCalledOnce();
    const replyText = ctx._replies[0] ?? '';
    expect(replyText).toContain('auto-routing');
    cleanupTmpRoot(cfg);
  });

  it('shows pinned model when session pin is set', async () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', true);

    const ctx = makeCtx('/model');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleModel(ctx as any, { config: cfg, memory: mem });
    const replyText = ctx._replies[0] ?? '';
    expect(replyText).toContain('pinned');
    expect(replyText).toContain('claude');
    cleanupTmpRoot(cfg);
  });

  it('sets a model pin with /model claude', async () => {
    const { cfg, mem } = setup();
    const ctx = makeCtx('/model claude');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleModel(ctx as any, { config: cfg, memory: mem });

    const session = mem.sessions.getOrCreate(12345);
    const state = mem.sessionModelState.get(session.id);
    expect(state?.provider).toBe('claude');
    expect(state?.model).toBe('claude-sonnet-4-6');
    expect(state?.override_until_clear).toBe(true);
    const replyText = ctx._replies[0] ?? '';
    expect(replyText).toContain('pinned');
    cleanupTmpRoot(cfg);
  });

  it('sets an Ollama model pin with /model glm-5.1:cloud', async () => {
    const { cfg, mem } = setup();
    const ctx = makeCtx('/model glm-5.1:cloud');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleModel(ctx as any, { config: cfg, memory: mem });

    const session = mem.sessions.getOrCreate(12345);
    const state = mem.sessionModelState.get(session.id);
    expect(state?.provider).toBe('ollama-cloud');
    expect(state?.model).toBe('glm-5.1:cloud');
    expect(state?.override_until_clear).toBe(true);
    cleanupTmpRoot(cfg);
  });

  it('clears pin with /model auto', async () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', true);

    const ctx = makeCtx('/model auto');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleModel(ctx as any, { config: cfg, memory: mem });

    const state = mem.sessionModelState.get(session.id);
    expect(state?.override_until_clear).toBe(false);
    expect(ctx._replies[0]).toContain('auto-routing');
    cleanupTmpRoot(cfg);
  });

  it('does not affect other sessions when pinning', async () => {
    const { cfg, mem } = setup();
    // Session for chat 12345
    const session1 = mem.sessions.getOrCreate(12345);
    // Session for chat 99999
    const session2 = mem.sessions.getOrCreate(99999);

    const ctx = makeCtx('/model claude', 12345);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleModel(ctx as any, { config: cfg, memory: mem });

    // session1 should be pinned, session2 should not
    const state1 = mem.sessionModelState.get(session1.id);
    const state2 = mem.sessionModelState.get(session2.id);
    expect(state1?.override_until_clear).toBe(true);
    expect(state2).toBeUndefined(); // never set
    cleanupTmpRoot(cfg);
  });
});
