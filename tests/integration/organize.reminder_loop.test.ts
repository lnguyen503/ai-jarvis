/**
 * Integration tests for the /organize reminder loop (v1.9.0 — Dev B scope).
 *
 * Scope:
 *   - tickAllUsers() per-user outcome dispatch (shouldNudge:true, shouldNudge:false, fallback)
 *   - markResponsiveIfPending() direct call (gateway hook path)
 *   - Nag status after tick
 *
 * Mocks: MessagingAdapter + both providers. Never hits real LLM or Telegram.
 * Disk: temp dirs per test (mkdtemp + rm in afterEach).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  initReminders,
  _resetTickInFlightForTests,
  type ReminderDeps,
} from '../../src/organize/reminders.js';
import {
  loadReminderState,
  writeReminderState,
  ymdLocal,
} from '../../src/organize/reminderState.js';
import { createItem } from '../../src/organize/storage.js';
import type { AppConfig } from '../../src/config/index.js';
import type { ModelProvider } from '../../src/providers/types.js';
import type { MessagingAdapter } from '../../src/messaging/adapter.js';
import type { MemoryApi } from '../../src/memory/index.js';

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-24T14:00:00.000Z');
const TODAY = ymdLocal(NOW);

const MOCK_CONFIG = {
  organize: {
    reminders: {
      enabled: true,
      cronExpression: '0 8-20/2 * * *',
      minActiveItemsForOptIn: 3,
      dailyCap: 3,
      itemCooldownMinutes: 4320,
      muteAfterConsecutiveIgnores: 3,
      quietHoursLocal: [], // no quiet hours so tests run clean
      maxItemsPerTriage: 50,
      triageProvider: 'ollama-cloud',
      triageModel: 'deepseek-v4-flash:cloud',
      fallbackProvider: 'claude',
      fallbackModel: 'claude-haiku-4-5',
      triageTimeoutMs: 90000,
      haikuFallbackMaxPerDay: 20,
    },
  },
  ai: {
    routing: { fallbackToClaudeOnError: true },
  },
} as unknown as AppConfig;

function makeProvider(response: string | (() => string) | Error): ModelProvider {
  return {
    name: 'mock-provider',
    call: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      const content = typeof response === 'function' ? response() : response;
      return {
        stop_reason: 'end_turn',
        content,
        tool_calls: [],
        usage: { input_tokens: 100, output_tokens: 50 },
        provider: 'mock',
        model: 'mock-model',
      };
    }),
  };
}

function makeShouldNudgeFalse(): string {
  return JSON.stringify({ shouldNudge: false, reasoning: 'No nudge needed right now' });
}

function makeShouldNudgeTrue(itemId: string): string {
  return JSON.stringify({
    shouldNudge: true,
    itemId,
    urgency: 'medium',
    message: 'Hey, check on this task!',
    reasoning: 'Due soon',
  });
}

function makeAdapter(): MessagingAdapter & { resolveDmChatId(userId: number): number | null } {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 1001 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ messageId: 1002 }),
    sendPhoto: vi.fn().mockResolvedValue({ messageId: 1003 }),
    sendVoice: vi.fn().mockResolvedValue({ messageId: 1004 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    resolveDmChatId: vi.fn().mockImplementation((userId: number) => userId),
  };
}

function makeMemory(): MemoryApi {
  return {
    auditLog: {
      insert: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    },
  } as unknown as MemoryApi;
}

/** Seed N items for a user so they pass the minActiveItemsForOptIn gate (3). */
async function seedItems(
  userId: number,
  dataDir: string,
  count = 3,
): Promise<Array<{ id: string }>> {
  await mkdir(path.join(dataDir, 'organize', String(userId)), { recursive: true });
  const items: Array<{ id: string }> = [];
  for (let i = 0; i < count; i++) {
    const item = await createItem(userId, dataDir, {
      type: 'task',
      title: `Task ${i + 1}`,
      due: `2026-05-${String(i + 1).padStart(2, '0')}`,
    });
    items.push({ id: item.frontMatter.id });
  }
  return items;
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-remloop-'));
  _resetTickInFlightForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tickAllUsers — per-user outcomes', () => {
  it('User 1: shouldNudge:true → sendMessage called once; state updated', async () => {
    const userId = 10001;
    const seeded = await seedItems(userId, dataDir, 3);
    const firstItemId = seeded[0]!.id;

    const adapter = makeAdapter();
    const ollamaProvider = makeProvider(makeShouldNudgeTrue(firstItemId));
    const claudeProvider = makeProvider(makeShouldNudgeFalse());

    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter,
      claudeProvider,
      ollamaProvider,
      dataDir,
    };

    const api = initReminders(deps);
    await api.tickAllUsers();

    // Nudge was sent
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    const [calledChatId, calledText] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledChatId).toBe(userId);
    expect(typeof calledText).toBe('string');
    expect(calledText).toContain('Hey, check on this task!');

    // State updated: nudgesToday incremented, item has pending entry
    const state = await loadReminderState(userId, dataDir);
    expect(state.nudgesToday).toBe(1);
    expect(state.dailyResetDate).toBe(TODAY);
    const itemState = state.items[firstItemId];
    expect(itemState).toBeDefined();
    expect(itemState!.responseHistory).toContain('pending');
  });

  it('User 2: shouldNudge:false → no sendMessage; lastTickAt updated', async () => {
    const userId = 10002;
    await seedItems(userId, dataDir, 3);

    const adapter = makeAdapter();
    const ollamaProvider = makeProvider(makeShouldNudgeFalse());
    const claudeProvider = makeProvider(makeShouldNudgeFalse());

    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter,
      claudeProvider,
      ollamaProvider,
      dataDir,
    };

    const api = initReminders(deps);
    await api.tickAllUsers();

    expect(adapter.sendMessage).not.toHaveBeenCalled();

    // State: nudgesToday stays 0 but lastTickAt is set
    const state = await loadReminderState(userId, dataDir);
    expect(state.nudgesToday).toBe(0);
    expect(state.lastTickAt).toBeTruthy();
  });

  it('User 3: primary Ollama throws; Haiku fallback → sendMessage called; fallbackUsed audited', async () => {
    const userId = 10003;
    const seeded = await seedItems(userId, dataDir, 3);
    const firstItemId = seeded[0]!.id;

    const adapter = makeAdapter();
    // Ollama throws (non-429, so fallback is triggered)
    const ollamaProvider = makeProvider(new Error('Ollama Cloud HTTP 503: Service Unavailable'));
    const claudeProvider = makeProvider(makeShouldNudgeTrue(firstItemId));

    const memory = makeMemory();
    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory,
      adapter,
      claudeProvider,
      ollamaProvider,
      dataDir,
    };

    const api = initReminders(deps);
    await api.tickAllUsers();

    // Fallback path: Claude called, nudge delivered
    expect(claudeProvider.call).toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledOnce();

    // Audit insert was called — verify fallbackUsed=true is in one of the calls
    const auditInsert = (memory.auditLog.insert as ReturnType<typeof vi.fn>);
    expect(auditInsert).toHaveBeenCalled();
    const auditCalls = auditInsert.mock.calls as Array<[{ detail: { fallbackUsed?: boolean; result?: string } }]>;
    const okCall = auditCalls.find((c) => c[0].detail.result === 'ok');
    expect(okCall).toBeDefined();
    expect(okCall![0].detail.fallbackUsed).toBe(true);
  });

  it('tickAllUsers is a no-op when organize dir does not exist', async () => {
    const adapter = makeAdapter();
    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter,
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider: makeProvider(makeShouldNudgeFalse()),
      dataDir,
    };
    const api = initReminders(deps);
    // organize/ directory doesn't exist yet — should not throw
    await expect(api.tickAllUsers()).resolves.not.toThrow();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});

describe('markResponsiveIfPending — gateway hook path', () => {
  it('flips pending → responded when called with pending state', async () => {
    const userId = 20001;
    await seedItems(userId, dataDir, 3);

    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter: makeAdapter(),
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider: makeProvider(makeShouldNudgeFalse()),
      dataDir,
    };

    // Manually seed a state with a 'pending' response entry
    const itemId = '2026-04-24-test';
    const state = await loadReminderState(userId, dataDir);
    state.items[itemId] = {
      lastNudgedAt: '2026-04-24T12:00:00.000Z',
      nudgeCount: 1,
      responseHistory: ['pending'],
      muted: false,
    };
    await writeReminderState(userId, dataDir, state);

    const api = initReminders(deps);
    await api.markResponsiveIfPending(userId);

    const updated = await loadReminderState(userId, dataDir);
    expect(updated.items[itemId]?.responseHistory).toEqual(['responded']);
  });

  it('is a no-op when there are no pending entries', async () => {
    const userId = 20002;
    await mkdir(path.join(dataDir, 'organize', String(userId)), { recursive: true });

    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter: makeAdapter(),
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider: makeProvider(makeShouldNudgeFalse()),
      dataDir,
    };

    const state = await loadReminderState(userId, dataDir);
    // No items, no pending
    const api = initReminders(deps);
    await expect(api.markResponsiveIfPending(userId)).resolves.not.toThrow();

    // State unchanged
    const after = await loadReminderState(userId, dataDir);
    expect(Object.keys(after.items)).toHaveLength(0);
  });

  it('does not flip non-pending (responded/ignored) entries', async () => {
    const userId = 20003;
    await mkdir(path.join(dataDir, 'organize', String(userId)), { recursive: true });

    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter: makeAdapter(),
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider: makeProvider(makeShouldNudgeFalse()),
      dataDir,
    };

    const state = await loadReminderState(userId, dataDir);
    const itemId = '2026-04-24-xyz1';
    state.items[itemId] = {
      lastNudgedAt: '2026-04-24T10:00:00.000Z',
      nudgeCount: 2,
      responseHistory: ['responded', 'ignored'],
      muted: false,
    };
    await writeReminderState(userId, dataDir, state);

    const api = initReminders(deps);
    await api.markResponsiveIfPending(userId);

    const after = await loadReminderState(userId, dataDir);
    expect(after.items[itemId]?.responseHistory).toEqual(['responded', 'ignored']);
  });
});

describe('getNagStatus', () => {
  it('returns correct status after a tick delivers a nudge', async () => {
    const userId = 30001;
    const seeded = await seedItems(userId, dataDir, 3);
    const firstItemId = seeded[0]!.id;

    const adapter = makeAdapter();
    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter,
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider: makeProvider(makeShouldNudgeTrue(firstItemId)),
      dataDir,
    };

    const api = initReminders(deps);
    await api.tickAllUsers();

    const status = await api.getNagStatus(userId);
    expect(status.disabledNag).toBe(false);
    expect(status.nudgesToday).toBe(1);
    expect(status.lastNudgeAt).toBeTruthy();
    expect(status.mutedCount).toBe(0);
  });

  it('disabledNag is true after setUserDisabledNag(true)', async () => {
    const userId = 30002;
    await mkdir(path.join(dataDir, 'organize', String(userId)), { recursive: true });

    const deps: ReminderDeps = {
      config: MOCK_CONFIG,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter: makeAdapter(),
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider: makeProvider(makeShouldNudgeFalse()),
      dataDir,
    };

    const api = initReminders(deps);
    await api.setUserDisabledNag(userId, true);
    const status = await api.getNagStatus(userId);
    expect(status.disabledNag).toBe(true);
  });
});

describe('daily cap enforcement', () => {
  it('stops nudging after dailyCap reached', async () => {
    const userId = 40001;
    const seeded = await seedItems(userId, dataDir, 3);
    const firstItemId = seeded[0]!.id;

    const adapter = makeAdapter();
    const ollamaProvider = makeProvider(makeShouldNudgeTrue(firstItemId));
    const deps: ReminderDeps = {
      config: {
        ...MOCK_CONFIG,
        organize: {
          reminders: {
            ...MOCK_CONFIG.organize!.reminders!,
            dailyCap: 1,
            itemCooldownMinutes: 0, // no cooldown so same item can be re-picked
          },
        },
      } as unknown as AppConfig,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      memory: makeMemory(),
      adapter,
      claudeProvider: makeProvider(makeShouldNudgeFalse()),
      ollamaProvider,
      dataDir,
    };

    const api = initReminders(deps);
    // First tick — cap is 1, should send
    await api.tickOneUser(userId);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();

    // Second tick — already at cap, should not send
    await api.tickOneUser(userId);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1); // still 1
  });
});
