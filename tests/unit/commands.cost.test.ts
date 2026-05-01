/**
 * Tests for /cost command handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCost } from '../../src/commands/cost.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AppConfig } from '../../src/config/schema.js';

function makeCtx(chatId = 12345) {
  const replies: string[] = [];
  return {
    chat: { id: chatId },
    message: { text: '/cost' },
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
  return { cfg, mem };
}

beforeEach(() => {
  _resetDb();
});

describe('/cost command', () => {
  it('reports no usage when no tokens accumulated', async () => {
    const { cfg, mem } = setup();
    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleCost(ctx as any, { config: cfg, memory: mem });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx._replies[0]).toContain('No token usage');
    cleanupTmpRoot(cfg);
  });

  it('shows accumulated token counts for Ollama Cloud', async () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    mem.sessionModelState.setModel(session.id, 'ollama-cloud', 'glm-5.1:cloud', false);
    mem.sessionModelState.accumulateTokens(session.id, 1000, 200);

    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleCost(ctx as any, { config: cfg, memory: mem });
    const reply = ctx._replies[0] ?? '';
    expect(reply).toContain('1.0K'); // input tokens
    expect(reply).toContain('200');  // output tokens
    expect(reply).toContain('flat-rate'); // Ollama = flat-rate
    cleanupTmpRoot(cfg);
  });

  it('accumulates tokens across multiple turns', async () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', false);
    mem.sessionModelState.accumulateTokens(session.id, 500, 100);
    mem.sessionModelState.accumulateTokens(session.id, 300, 50);

    const state = mem.sessionModelState.get(session.id);
    expect(state?.input_tokens).toBe(800);
    expect(state?.output_tokens).toBe(150);
    cleanupTmpRoot(cfg);
  });

  it('shows cost estimate for Claude sessions', async () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', false);
    // 1M input tokens + 1M output tokens → $3 + $15 = $18
    mem.sessionModelState.accumulateTokens(session.id, 1_000_000, 1_000_000);

    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleCost(ctx as any, { config: cfg, memory: mem });
    const reply = ctx._replies[0] ?? '';
    expect(reply).toContain('est.'); // shows cost estimate
    expect(reply).not.toContain('flat-rate');
    cleanupTmpRoot(cfg);
  });

  it('shows no usage when tokens are 0 even with state row', async () => {
    const { cfg, mem } = setup();
    const session = mem.sessions.getOrCreate(12345);
    // Set model but don't accumulate tokens
    mem.sessionModelState.setModel(session.id, 'claude', 'claude-sonnet-4-6', false);

    const ctx = makeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleCost(ctx as any, { config: cfg, memory: mem });
    expect(ctx._replies[0]).toContain('No token usage');
    cleanupTmpRoot(cfg);
  });

  it('session cost is isolated — separate session has no tokens', async () => {
    const { cfg, mem } = setup();
    // Accumulate for session 12345
    const session1 = mem.sessions.getOrCreate(12345);
    mem.sessionModelState.accumulateTokens(session1.id, 500, 100);

    // Check session for 99999 — should have no tokens
    const session2 = mem.sessions.getOrCreate(99999);
    const state2 = mem.sessionModelState.get(session2.id);
    expect(state2).toBeUndefined();
    cleanupTmpRoot(cfg);
  });
});
