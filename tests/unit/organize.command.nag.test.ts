/**
 * Tests for /organize nag on|off|status subcommands (v1.9.0).
 *
 * Pattern-matches tests/unit/organize.command.test.ts for ctx shape and
 * assertion style.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleOrganize,
  type OrganizeCommandDeps,
} from '../../src/commands/organize.js';
import type { RemindersApi } from '../../src/organize/reminders.js';
import type { AppConfig } from '../../src/config/index.js';

// ---------------------------------------------------------------------------
// Mock isGroupChat — DM by default in all tests.
// ---------------------------------------------------------------------------
vi.mock('../../src/gateway/groupGate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway/groupGate.js')>();
  return {
    ...original,
    isGroupChat: vi.fn(() => false),
  };
});

import { isGroupChat } from '../../src/gateway/groupGate.js';

// ---------------------------------------------------------------------------
// Minimal ctx factory
// ---------------------------------------------------------------------------

interface MockCtx {
  chat?: { type: string; id: number };
  from?: { id: number; first_name?: string };
  message?: { text?: string };
  replies: string[];
  replyOptions: Array<Record<string, unknown>>;
  reply: (msg: string, opts?: Record<string, unknown>) => Promise<void>;
}

function makeCtx(
  userId: number | undefined,
  text: string,
  chatType = 'private',
): MockCtx {
  const ctx: MockCtx = {
    chat: { type: chatType, id: userId ?? 0 },
    from: userId !== undefined ? { id: userId, first_name: 'Boss' } : undefined,
    message: { text },
    replies: [],
    replyOptions: [],
    reply: async (msg: string, opts?: Record<string, unknown>) => {
      ctx.replies.push(msg);
      ctx.replyOptions.push(opts ?? {});
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Mock RemindersApi factory
// ---------------------------------------------------------------------------

function makeMockReminders(
  overrides?: Partial<RemindersApi>,
): RemindersApi {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    tickAllUsers: vi.fn().mockResolvedValue(undefined),
    tickOneUser: vi.fn().mockResolvedValue(undefined),
    markResponsiveIfPending: vi.fn().mockResolvedValue(undefined),
    setUserDisabledNag: vi.fn().mockResolvedValue(undefined),
    getNagStatus: vi.fn().mockResolvedValue({
      disabledNag: false,
      nudgesToday: 1,
      lastNudgeAt: '2026-04-24T08:00:00.000Z',
      mutedCount: 0,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal config factory
// ---------------------------------------------------------------------------

function makeTestConfig(dailyCap = 3): AppConfig {
  return {
    organize: {
      reminders: {
        enabled: true,
        cronExpression: '0 8-20/2 * * *',
        minActiveItemsForOptIn: 3,
        dailyCap,
        itemCooldownMinutes: 4320,
        muteAfterConsecutiveIgnores: 3,
        quietHoursLocal: [22, 23, 0, 1, 2, 3, 4, 5, 6, 7],
        maxItemsPerTriage: 50,
        triageProvider: 'ollama-cloud',
        triageModel: 'deepseek-v4-flash:cloud',
        fallbackProvider: 'claude',
        fallbackModel: 'claude-haiku-4-5',
        triageTimeoutMs: 90000,
        haikuFallbackMaxPerDay: 20,
      },
    },
    memory: { dbPath: './data/test.db', maxHistoryMessages: 50 },
  } as unknown as AppConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const USER_ID = 12345;

describe('/organize nag off', () => {
  beforeEach(() => {
    vi.mocked(isGroupChat).mockReturnValue(false);
  });

  it('calls setUserDisabledNag(userId, true) and replies with OFF', async () => {
    const reminders = makeMockReminders();
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag off');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(reminders.setUserDisabledNag).toHaveBeenCalledWith(USER_ID, true);
    expect(ctx.replies[0]).toContain('OFF');
  });

  it('replies "Reminders not available" when reminders is null', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders: null };
    const ctx = makeCtx(USER_ID, '/organize nag off');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('not available');
  });

  it('replies "Reminders not available" when reminders is undefined', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig() };
    const ctx = makeCtx(USER_ID, '/organize nag off');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('not available');
  });

  it('does not crash when userId is missing', async () => {
    const reminders = makeMockReminders();
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(undefined, '/organize nag off');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    // Should reply with "No user context" from the outer handler guard, not crash
    expect(ctx.replies[0]).toContain('No user context');
    expect(reminders.setUserDisabledNag).not.toHaveBeenCalled();
  });
});

describe('/organize nag on', () => {
  beforeEach(() => {
    vi.mocked(isGroupChat).mockReturnValue(false);
  });

  it('calls setUserDisabledNag(userId, false) and replies with ON', async () => {
    const reminders = makeMockReminders();
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag on');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(reminders.setUserDisabledNag).toHaveBeenCalledWith(USER_ID, false);
    expect(ctx.replies[0]).toContain('ON');
  });

  it('includes the daily cap from config in the reply', async () => {
    const reminders = makeMockReminders();
    const deps: OrganizeCommandDeps = { config: makeTestConfig(5), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag on');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('5/day');
  });

  it('replies "Reminders not available" when reminders is null', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders: null };
    const ctx = makeCtx(USER_ID, '/organize nag on');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('not available');
  });
});

describe('/organize nag status', () => {
  beforeEach(() => {
    vi.mocked(isGroupChat).mockReturnValue(false);
  });

  it('calls getNagStatus and reply contains nudges-today, muted counts', async () => {
    const reminders = makeMockReminders({
      getNagStatus: vi.fn().mockResolvedValue({
        disabledNag: false,
        nudgesToday: 2,
        lastNudgeAt: '2026-04-24T10:00:00.000Z',
        mutedCount: 3,
      }),
    });
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag status');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(reminders.getNagStatus).toHaveBeenCalledWith(USER_ID);
    const reply = ctx.replies[0] ?? '';
    // The reply goes through markdownToTelegramHtml so check for the values
    expect(reply).toContain('2');  // nudgesToday
    expect(reply).toContain('3');  // mutedCount
  });

  it('reply shows OFF when disabledNag is true', async () => {
    const reminders = makeMockReminders({
      getNagStatus: vi.fn().mockResolvedValue({
        disabledNag: true,
        nudgesToday: 0,
        lastNudgeAt: null,
        mutedCount: 0,
      }),
    });
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag status');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    const reply = ctx.replies[0] ?? '';
    expect(reply).toContain('OFF');
  });

  it('reply shows "never" when lastNudgeAt is null', async () => {
    const reminders = makeMockReminders({
      getNagStatus: vi.fn().mockResolvedValue({
        disabledNag: false,
        nudgesToday: 0,
        lastNudgeAt: null,
        mutedCount: 0,
      }),
    });
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag status');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('never');
  });

  it('replies "Reminders not available" when reminders is null', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders: null };
    const ctx = makeCtx(USER_ID, '/organize nag status');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('not available');
  });
});

describe('/organize nag — group chat rejected', () => {
  it('does not leak user data in group mode (isGroupChat intercepts first)', async () => {
    vi.mocked(isGroupChat).mockReturnValue(true);
    const reminders = makeMockReminders();
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders };
    const ctx = makeCtx(USER_ID, '/organize nag status', 'supergroup');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('DM-only');
    expect(reminders.getNagStatus).not.toHaveBeenCalled();
  });
});

describe('/organize nag — unknown sub-subcommand', () => {
  beforeEach(() => {
    vi.mocked(isGroupChat).mockReturnValue(false);
  });

  it('replies with usage hint for unknown sub-subcommand', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders: null };
    const ctx = makeCtx(USER_ID, '/organize nag frobnicate');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('on|off|status');
  });
});

describe('/organize help text includes nag', () => {
  beforeEach(() => {
    vi.mocked(isGroupChat).mockReturnValue(false);
  });

  it('unknown subcommand reply lists nag in usage', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig() };
    const ctx = makeCtx(USER_ID, '/organize unknowncmd');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('nag');
  });

  it('unknown subcommand reply includes "cost [days]" in nag usage', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig() };
    const ctx = makeCtx(USER_ID, '/organize unknowncmd');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('cost');
  });
});

describe('/organize nag cost dispatch', () => {
  beforeEach(() => {
    vi.mocked(isGroupChat).mockReturnValue(false);
  });

  it('replies "Memory not available" when memory is null', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig(), reminders: null, memory: null };
    const ctx = makeCtx(USER_ID, '/organize nag cost');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('not available');
  });

  it('/organize nag unknown-sub shows usage with cost [days]', async () => {
    const deps: OrganizeCommandDeps = { config: makeTestConfig() };
    const ctx = makeCtx(USER_ID, '/organize nag frobnicate');
    await handleOrganize(ctx as unknown as Parameters<typeof handleOrganize>[0], deps);
    expect(ctx.replies[0]).toContain('cost [days]');
  });
});
