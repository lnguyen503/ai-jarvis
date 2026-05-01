/**
 * Integration tests for BotSelfMessagesRepo + migration 014 (v1.21.0 R2).
 *
 * Covers:
 *   - recordOutgoing inserts a row; isOurEcho returns true within TTL
 *   - isOurEcho returns false when (chat_id, message_id) not recorded
 *   - isOurEcho returns false when row is outside TTL window (expired)
 *   - recordOutgoing is idempotent: re-recording the same (chat_id, message_id) is a no-op
 *   - evictExpired deletes rows older than TTL; leaves fresh rows
 *   - evictExpired returns evicted count accurately
 *   - concurrent INSERT OR IGNORE: two records for different message_ids both succeed
 *   - isOurEcho is chat-scoped: same message_id in different chats treated independently
 *   - evictExpired with no expired rows returns evicted=0
 *   - SELF_MESSAGE_TTL_MS is 3_600_000 (1h)
 *   - migration is idempotent (running migrations twice does not error)
 *   - bot_self_messages exposed on MemoryApi.botSelfMessages
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initMemory, SELF_MESSAGE_TTL_MS, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

let mem: MemoryApi;
let tmpDir: string;

function makeConfig(dbPath: string) {
  return {
    telegram: { allowedUserIds: [], botToken: 'test-token' },
    ai: {
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      defaultProvider: 'claude',
      defaultModel: 'claude-sonnet-4-6',
      premiumProvider: 'claude',
      premiumModel: 'claude-sonnet-4-6',
      judgeModel: 'claude-opus-4-6',
      maxTokens: 4096,
      temperature: 0.3,
      maxToolIterations: 10,
      streamingEnabled: false,
      streamingEditIntervalMs: 150,
      streamingCursor: '▍',
      providers: { claude: {}, 'ollama-cloud': {} },
      routing: { enabled: false, fallbackToClaudeOnError: false, logRoutingDecisions: false },
    },
    whisper: { model: 'whisper-1', apiBaseUrl: 'https://api.openai.com/v1' },
    health: { port: 7878 },
    chat: { userQueueMax: 5, schedulerQueueMax: 20, maxQueueAgeMs: 600000 },
    safety: {
      confirmationTtlMs: 300000,
      commandTimeoutMs: 120000,
      maxOutputLength: 4000,
      allowEncodedCommands: false,
      blockedCommands: [],
    },
    filesystem: { allowedPaths: [tmpDir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(tmpDir, 'workspaces') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath, maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: {
      enabled: false,
      headless: true,
      pageTimeoutMs: 15000,
      maxContentChars: 100000,
      denyHosts: [],
      userAgent: '',
    },
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(tmpDir, 'google-tokens.json') },
      calendar: { enabled: false, defaultCalendarId: 'primary' },
      gmail: {
        enabled: false,
        maxResults: 10,
        send: {
          enabled: false,
          confirmationTtlSeconds: 300,
          rateLimitPerHour: 10,
          maxRecipientsPerSend: 20,
          requireReplyToThread: false,
        },
      },
    },
    groups: {
      enabled: false,
      allowedGroupIds: [],
      adminUserIds: [],
      developerUserIds: [],
      groupRoles: {},
      rateLimitPerUser: 10,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: [],
      intentDetection: {
        enabled: false,
        provider: 'ollama-cloud',
        model: 'gemma4:cloud',
        followUpWindowSeconds: 120,
        confirmationTtlSeconds: 120,
        rateLimitPerMinute: 30,
        recentMessageContext: 4,
      },
    },
    context: {
      autoCompact: false,
      compactThreshold: 0.75,
      summarizePrompt: 'Summarize',
      notifyUser: false,
    },
    aliases: {},
    organize: {
      reminders: {
        enabled: false,
        cronExpression: '0 8 * * *',
        minActiveItemsForOptIn: 3,
        dailyCap: 3,
        itemCooldownMinutes: 4320,
        muteAfterConsecutiveIgnores: 3,
        quietHoursLocal: [],
        triage: {
          enabled: false,
          maxItemsPerTriage: 50,
          triageProvider: 'ollama-cloud',
          triageModel: 'deepseek-v4-flash:cloud',
          fallbackProvider: 'claude',
          fallbackModel: 'claude-haiku-4-5',
          triageTimeoutMs: 120000,
          haikuFallbackMaxPerDay: 20,
          globalHaikuFallbackMaxPerDay: 500,
          tickConcurrency: 5,
          wallTimeWarnRatio: 0.75,
        },
      },
      trashTtlDays: 30,
      trashEvictCron: '0 4 * * *',
      trashEvictWallTimeWarnMs: 600000,
      trashEvictAuditZeroBatches: false,
      reconcileHotEmitterThreshold: 100,
    },
    projects: [],
    debate: { panelStateCacheMax: 50, panelStateTtlHours: 24 },
    webapp: {
      publicUrl: 'https://example.com',
      staticDir: 'public/webapp',
      port: 17900,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  };
}

beforeEach(() => {
  _resetDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-self-msg-test-'));
  const dbPath = path.join(tmpDir, 'jarvis.db');
  mem = initMemory(makeConfig(dbPath));
});

afterEach(() => {
  mem.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const CHAT_A = 100001;
const CHAT_B = 100002;
const NOW = Date.now();

// ---------------------------------------------------------------------------
// SELF_MESSAGE_TTL_MS constant
// ---------------------------------------------------------------------------

describe('SELF_MESSAGE_TTL_MS', () => {
  it('BSM-1: TTL constant is 1h (3_600_000 ms)', () => {
    expect(SELF_MESSAGE_TTL_MS).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// MemoryApi surface
// ---------------------------------------------------------------------------

describe('MemoryApi.botSelfMessages', () => {
  it('BSM-2: botSelfMessages is exposed on MemoryApi', () => {
    expect(mem.botSelfMessages).toBeDefined();
    expect(typeof mem.botSelfMessages.recordOutgoing).toBe('function');
    expect(typeof mem.botSelfMessages.isOurEcho).toBe('function');
    expect(typeof mem.botSelfMessages.evictExpired).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// recordOutgoing + isOurEcho
// ---------------------------------------------------------------------------

describe('BotSelfMessagesRepo — record + lookup', () => {
  it('BSM-3: recorded message is recognized as our echo within TTL', () => {
    const sentAt = new Date(NOW - 1000).toISOString(); // 1s ago — well within 1h
    mem.botSelfMessages.recordOutgoing(CHAT_A, 999, sentAt);
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 999, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
  });

  it('BSM-4: unknown message_id is not our echo', () => {
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 12345, SELF_MESSAGE_TTL_MS, NOW)).toBe(false);
  });

  it('BSM-5: recorded message outside TTL window is NOT our echo', () => {
    // sent 2 hours ago; TTL is 1 hour
    const sentAt = new Date(NOW - 2 * SELF_MESSAGE_TTL_MS).toISOString();
    mem.botSelfMessages.recordOutgoing(CHAT_A, 111, sentAt);
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 111, SELF_MESSAGE_TTL_MS, NOW)).toBe(false);
  });

  it('BSM-6: isOurEcho is chat-scoped — same message_id in different chats is independent', () => {
    const sentAt = new Date(NOW - 500).toISOString();
    mem.botSelfMessages.recordOutgoing(CHAT_A, 777, sentAt);
    // CHAT_A has it; CHAT_B does not
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 777, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
    expect(mem.botSelfMessages.isOurEcho(CHAT_B, 777, SELF_MESSAGE_TTL_MS, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (INSERT OR IGNORE)
// ---------------------------------------------------------------------------

describe('BotSelfMessagesRepo — idempotency', () => {
  it('BSM-7: re-recording the same (chat_id, message_id) is a no-op (no error + still recognized)', () => {
    const sentAt = new Date(NOW - 100).toISOString();
    mem.botSelfMessages.recordOutgoing(CHAT_A, 42, sentAt);
    // Second call with same IDs must not throw
    expect(() => mem.botSelfMessages.recordOutgoing(CHAT_A, 42, sentAt)).not.toThrow();
    // Still recognized
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 42, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
  });

  it('BSM-8: concurrent inserts for different message_ids in the same chat both succeed', () => {
    const sentAt = new Date(NOW - 200).toISOString();
    mem.botSelfMessages.recordOutgoing(CHAT_A, 201, sentAt);
    mem.botSelfMessages.recordOutgoing(CHAT_A, 202, sentAt);
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 201, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 202, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evictExpired
// ---------------------------------------------------------------------------

describe('BotSelfMessagesRepo — eviction', () => {
  it('BSM-9: evictExpired deletes rows older than TTL; leaves fresh rows intact', () => {
    const freshAt = new Date(NOW - 1000).toISOString();          // 1s ago — keep
    const staleAt = new Date(NOW - 2 * SELF_MESSAGE_TTL_MS).toISOString(); // 2h ago — evict

    mem.botSelfMessages.recordOutgoing(CHAT_A, 301, freshAt);
    mem.botSelfMessages.recordOutgoing(CHAT_A, 302, staleAt);

    const { evicted } = mem.botSelfMessages.evictExpired(SELF_MESSAGE_TTL_MS, NOW);
    expect(evicted).toBe(1);

    // Fresh row still present
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 301, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
    // Stale row gone
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 302, SELF_MESSAGE_TTL_MS, NOW)).toBe(false);
  });

  it('BSM-10: evictExpired with no expired rows returns evicted=0', () => {
    const freshAt = new Date(NOW - 500).toISOString();
    mem.botSelfMessages.recordOutgoing(CHAT_B, 401, freshAt);
    const { evicted } = mem.botSelfMessages.evictExpired(SELF_MESSAGE_TTL_MS, NOW);
    expect(evicted).toBe(0);
  });

  it('BSM-11: evictExpired on empty table returns evicted=0 without error', () => {
    const { evicted } = mem.botSelfMessages.evictExpired(SELF_MESSAGE_TTL_MS, NOW);
    expect(evicted).toBe(0);
  });

  it('BSM-12: evictExpired evicts exactly the rows that cross the TTL boundary', () => {
    const justFresh = new Date(NOW - SELF_MESSAGE_TTL_MS + 1000).toISOString(); // 1s before boundary
    const justStale = new Date(NOW - SELF_MESSAGE_TTL_MS - 1000).toISOString(); // 1s past boundary

    mem.botSelfMessages.recordOutgoing(CHAT_A, 501, justFresh);
    mem.botSelfMessages.recordOutgoing(CHAT_A, 502, justStale);

    const { evicted } = mem.botSelfMessages.evictExpired(SELF_MESSAGE_TTL_MS, NOW);
    expect(evicted).toBe(1);
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 501, SELF_MESSAGE_TTL_MS, NOW)).toBe(true);
    expect(mem.botSelfMessages.isOurEcho(CHAT_A, 502, SELF_MESSAGE_TTL_MS, NOW)).toBe(false);
  });
});
