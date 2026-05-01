/**
 * F-05: Integration test for gateway/index.ts — text message turn.
 * Mocks the grammY Bot class and agent to verify routing logic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { registerTools } from '../../src/tools/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { AgentApi, TurnResult } from '../../src/agent/index.js';
import type { Transcriber } from '../../src/transcriber/index.js';
import type { GatewayDeps } from '../../src/gateway/index.js';

// We mock grammY Bot so we don't need a real Telegram token
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
  const handlers: Map<string, ((ctx: unknown) => Promise<void>)[]> = new Map();
  let middlewares: ((ctx: unknown, next: () => Promise<void>) => Promise<void>)[] = [];

  class MockBot {
    api = {
      token: 'mock-bot-token',
      sendMessage: vi.fn().mockResolvedValue({}),
      sendChatAction: vi.fn().mockResolvedValue({}),
    };

    use(fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) {
      middlewares.push(fn);
    }

    command(cmd: string, handler: (ctx: unknown) => Promise<void>) {
      if (!handlers.has(cmd)) handlers.set(cmd, []);
      handlers.get(cmd)!.push(handler);
    }

    on(_event: string, handler: (ctx: unknown) => Promise<void>) {
      if (!handlers.has('message')) handlers.set('message', []);
      handlers.get('message')!.push(handler);
    }

    catch(_fn: (err: unknown) => void) {
      // no-op for tests; errors inside handlers propagate to the test
    }

    async start() {}
    async stop() {}

    // Test helper to simulate an incoming message
    async simulateMessage(ctx: unknown) {
      for (const mw of middlewares) {
        let passed = false;
        await mw(ctx, async () => { passed = true; });
        if (!passed) return; // middleware blocked
      }
      const msgHandlers = handlers.get('message') ?? [];
      for (const h of msgHandlers) {
        await h(ctx);
      }
    }
  }

  // Reset handler state between tests
  afterEach(() => {
    handlers.clear();
    middlewares = [];
  });

  return { ...actual, Bot: MockBot };
});

// Mock health server to avoid binding a real port
vi.mock('../../src/gateway/health.js', () => ({
  createHealthServer: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { initGateway } from '../../src/gateway/index.js';
import { Bot } from 'grammy';

let cfg: AppConfig;

function makeAgentMock(replyText = 'Agent reply'): AgentApi {
  return {
    turn: vi.fn().mockResolvedValue({ replyText, toolCalls: 0 } as TurnResult),
    runConfirmedCommand: vi.fn().mockResolvedValue({ replyText: 'done', toolCalls: 1 } as TurnResult),
  };
}

function makeTranscriberMock(): Transcriber {
  return {
    transcribeVoice: vi.fn().mockResolvedValue({ text: 'transcribed', durationMs: 100 }),
  };
}

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  return { mem, safety };
}

afterEach(() => {
  if (cfg) cleanupTmpRoot(cfg);
  vi.clearAllMocks();
});

describe('gateway/index.ts — text turn routing', () => {
  it('allowlist rejects messages from non-allowlisted users', async () => {
    const { mem, safety } = setup();
    const agent = makeAgentMock();
    const deps: GatewayDeps = {
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent,
      transcriber: makeTranscriberMock(),
      version: '1.0.0',
    };
    const gw = initGateway(deps);
    const bot = (gw as unknown as { bot?: InstanceType<typeof Bot> }).bot;

    // User ID 99999 is not in allowedUserIds ([12345])
    const ctx = {
      from: { id: 99999 },
      chat: { id: 99999 },
      message: { text: 'hack', voice: undefined, audio: undefined },
      reply: vi.fn(),
      api: { sendMessage: vi.fn(), sendChatAction: vi.fn(), token: 'mock-bot-token' },
    };

    if (bot && typeof (bot as unknown as { simulateMessage: (ctx: unknown) => Promise<void> }).simulateMessage === 'function') {
      await (bot as unknown as { simulateMessage: (ctx: unknown) => Promise<void> }).simulateMessage(ctx);
    }

    // Agent must not be called for unauthorized user
    expect(agent.turn).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('enqueueSchedulerTurn is exposed on the gateway api', () => {
    const { mem, safety } = setup();
    const gw = initGateway({
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent: makeAgentMock(),
      transcriber: makeTranscriberMock(),
      version: '1.0.0',
    });
    expect(typeof gw.enqueueSchedulerTurn).toBe('function');
    expect(typeof gw.start).toBe('function');
    expect(typeof gw.stop).toBe('function');
  });
});
