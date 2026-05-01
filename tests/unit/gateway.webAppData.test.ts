/**
 * v1.14.0+: web_app_data handler is intentionally minimal.
 * v1.13.0 had a pong handler that replied "🏓 pong" to any sendData payload.
 * v1.14.0 hub conversion removed the ping flow; v1.14.1+ will add typed
 * sendData routing (e.g. {kind: 'complete-item', id} → organize_complete tool).
 *
 * This test preserves the negative assertion that:
 *   - The handler IS still registered (so v1.14.1+ can drop in routing logic)
 *   - The handler does NOT auto-reply with pong text in v1.14.0
 *
 * v1.13.0 assertions removed: ping payload → ISO timestamp reply,
 * non-JSON payload → generic ack reply. Both are intentionally gone.
 * v1.14.1 will re-open this file and add typed routing assertions.
 *
 * Background (ADR 009 R5): DA-C3 identified that deleting this test file
 * would lose the MockBot precedent and bot.on('message:web_app_data')
 * introspection pattern that v1.14.1+ needs. Preserved as negative assertion.
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

// ------------------------------------------------------------------
// grammY mock — tracks handlers by event/command name so we can
// verify that 'message:web_app_data' is wired AND simulate messages.
// ------------------------------------------------------------------
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();

  // Shared maps (reset between tests via afterEach)
  const commandHandlers: Map<string, ((ctx: unknown) => Promise<void>)[]> = new Map();
  const eventHandlers: Map<string, ((ctx: unknown) => Promise<void>)[]> = new Map();
  let middlewares: ((ctx: unknown, next: () => Promise<void>) => Promise<void>)[] = [];

  class MockBot {
    api = {
      token: 'mock-bot-token',
      getMe: vi.fn().mockResolvedValue({ id: 77, username: 'test_bot' }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
    };

    use(fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) {
      middlewares.push(fn);
    }

    command(cmd: string, handler: (ctx: unknown) => Promise<void>) {
      if (!commandHandlers.has(cmd)) commandHandlers.set(cmd, []);
      commandHandlers.get(cmd)!.push(handler);
    }

    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }

    catch(_fn: (err: unknown) => void) {
      // no-op
    }

    async start() {}
    async stop() {}

    // Test helper: simulate an event (e.g. 'message:web_app_data') directly.
    async simulateEvent(event: string, ctx: unknown) {
      const handlers = eventHandlers.get(event) ?? [];
      for (const h of handlers) {
        await h(ctx);
      }
    }

    // Expose maps for inspection
    _commandHandlers = commandHandlers;
    _eventHandlers = eventHandlers;
  }

  afterEach(() => {
    commandHandlers.clear();
    eventHandlers.clear();
    middlewares = [];
  });

  return { ...actual, Bot: MockBot };
});

// Mock health server — avoid binding real port
vi.mock('../../src/gateway/health.js', () => ({
  createHealthServer: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock webapp server (Dev-A's) — avoid port binding in unit tests
vi.mock('../../src/webapp/server.js', () => ({
  createWebappServer: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { initGateway } from '../../src/gateway/index.js';
import { Bot } from 'grammy';

type MockBotInstance = InstanceType<typeof Bot> & {
  simulateEvent: (event: string, ctx: unknown) => Promise<void>;
  _eventHandlers: Map<string, ((ctx: unknown) => Promise<void>)[]>;
  _commandHandlers: Map<string, ((ctx: unknown) => Promise<void>)[]>;
};

let cfg: AppConfig;

function makeAgentMock(): AgentApi {
  return {
    turn: vi.fn().mockResolvedValue({ replyText: 'reply', toolCalls: 0 } as TurnResult),
    runConfirmedCommand: vi.fn().mockResolvedValue({ replyText: 'done', toolCalls: 0 } as TurnResult),
  };
}

function makeTranscriberMock(): Transcriber {
  return {
    transcribeVoice: vi.fn().mockResolvedValue({ text: 'text', durationMs: 0 }),
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

describe('gateway — message:web_app_data handler (v1.14.0)', () => {
  it('handler IS still registered after initGateway (prerequisite for v1.14.1+ typed routing)', () => {
    const { mem, safety } = setup();
    const deps: GatewayDeps = {
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent: makeAgentMock(),
      transcriber: makeTranscriberMock(),
      version: '1.14.0',
    };

    initGateway(deps);

    // The bot.on('message:web_app_data', ...) call must still exist in gateway/index.ts
    // even though the handler body is a no-op in v1.14.0. v1.14.1+ drops in typed
    // routing inside that handler body without needing to add a new bot.on() call.
    const mockBotClass = Bot as unknown as { new(): MockBotInstance };
    const dummyBot = new mockBotClass();
    expect(dummyBot._eventHandlers.has('message:web_app_data')).toBe(true);
  });

  it('v1.14.0: handler does NOT auto-reply to any sendData payload (ping → pong removed)', async () => {
    // v1.13.0: receiving {type:'ping'} triggered ctx.reply("🏓 Ping received…").
    // v1.14.0: the handler is a no-op. ctx.reply must NOT be called for any payload.
    // v1.14.1+: typed routing will be added here (e.g. {kind:'complete-item'} → tool call).
    const { mem, safety } = setup();
    const deps: GatewayDeps = {
      config: cfg,
      logger: getLogger(),
      memory: mem,
      safety,
      agent: makeAgentMock(),
      transcriber: makeTranscriberMock(),
      version: '1.14.0',
    };

    initGateway(deps);

    const mockBotClass = Bot as unknown as { new(): MockBotInstance };
    const dummyBot = new mockBotClass();

    const replyFn = vi.fn().mockResolvedValue(undefined);

    // Simulate the old ping payload — must produce NO reply in v1.14.0
    const pingCtx = {
      from: { id: 12345 },
      chat: { id: 12345 },
      message: {
        web_app_data: { data: JSON.stringify({ type: 'ping', ts: Date.now() }) },
      },
      reply: replyFn,
    };
    await dummyBot.simulateEvent('message:web_app_data', pingCtx);
    expect(replyFn).not.toHaveBeenCalled();

    // Simulate a non-JSON payload — must also produce NO reply
    const rawCtx = {
      from: { id: 12345 },
      chat: { id: 12345 },
      message: {
        web_app_data: { data: 'hello-non-json' },
      },
      reply: replyFn,
    };
    await dummyBot.simulateEvent('message:web_app_data', rawCtx);
    expect(replyFn).not.toHaveBeenCalled();
  });
});
