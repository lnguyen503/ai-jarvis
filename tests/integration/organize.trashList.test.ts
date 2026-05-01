/**
 * Integration tests for /organize trash list command (v1.14.5 D6/R6).
 *
 * Uses the same ctx mock + real-fs pattern as organize.command.test.ts.
 * Tests:
 *   - Empty trash → "Trash is empty."
 *   - Happy path: 3 items, correct format
 *   - Pagination: /organize trash list 50 returns next page
 *   - Invalid offset strings → "Invalid offset" error reply
 *   - Maximum-cap offset (≤ 100000 accepted, > 100000 rejected)
 *   - R6 strict parser edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { vi } from 'vitest';
import {
  handleOrganize,
  type OrganizeCommandDeps,
} from '../../src/commands/organize.js';

// ---------------------------------------------------------------------------
// Mock isGroupChat
// ---------------------------------------------------------------------------
vi.mock('../../src/gateway/groupGate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway/groupGate.js')>();
  return {
    ...original,
    isGroupChat: vi.fn(() => false),
  };
});

// ---------------------------------------------------------------------------
// Minimal ctx factory
// ---------------------------------------------------------------------------

interface MockCtx {
  from?: { id: number };
  message?: { text?: string };
  replies: string[];
  replyOptions: Array<Record<string, unknown>>;
  reply: (msg: string, opts?: Record<string, unknown>) => Promise<void>;
}

function makeCtx(userId: number, text: string): MockCtx {
  const ctx: MockCtx = {
    from: { id: userId },
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

const USER_ID = 80001;

let dataDir: string;
let deps: OrganizeCommandDeps;

function makeConfig(dir: string) {
  return {
    telegram: { allowedUserIds: [USER_ID], botToken: 'test_token' },
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
    filesystem: { allowedPaths: [dir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(dir, 'workspaces') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath: path.join(dir, 'jarvis.db'), maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: { enabled: false, headless: true, pageTimeoutMs: 15000, maxContentChars: 100000, denyHosts: [], userAgent: '' },
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(dir, 'google-tokens.json') },
      calendar: { enabled: false, defaultCalendarId: 'primary' },
      gmail: {
        enabled: false,
        maxResults: 10,
        send: { enabled: false, confirmationTtlSeconds: 300, rateLimitPerHour: 10, maxRecipientsPerSend: 20, requireReplyToThread: false },
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
      intentDetection: { enabled: false, provider: 'ollama-cloud', model: 'gemma4:cloud', followUpWindowSeconds: 120, confirmationTtlSeconds: 120, rateLimitPerMinute: 30, recentMessageContext: 4 },
    },
    context: { autoCompact: false, compactThreshold: 0.75, summarizePrompt: 'Summarize', notifyUser: false },
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
      port: 17911,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  };
}

function makeTrashMd(opts: {
  id: string;
  type: 'task' | 'event' | 'goal';
  status: 'active' | 'done' | 'abandoned';
  title: string;
  deletedAt?: string;
}): string {
  const deletedAtLine = opts.deletedAt ? `deletedAt: ${opts.deletedAt}\n` : '';
  return (
    `---\n` +
    `id: ${opts.id}\n` +
    `type: ${opts.type}\n` +
    `status: ${opts.status}\n` +
    `title: ${opts.title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `${deletedAtLine}` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. -->\n\n` +
    `## Notes\n\n## Progress\n`
  );
}

async function writeTrashItem(trashDir: string, filename: string, content: string): Promise<void> {
  await mkdir(trashDir, { recursive: true });
  await writeFile(path.join(trashDir, filename), content, 'utf8');
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-trashlist-int-'));
  deps = { config: makeConfig(dataDir) as OrganizeCommandDeps['config'] };
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function trashDir(): string {
  return path.join(dataDir, 'organize', String(USER_ID), '.trash');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/organize trash list — integration (v1.14.5 D6/R6)', () => {
  it('TL-1: empty trash → "Trash is empty."', async () => {
    const ctx = makeCtx(USER_ID, '/organize trash list');
    await handleOrganize(ctx as never, deps);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('empty');
  });

  it('TL-2: happy path — 3 items, shows titles and ids', async () => {
    const td = trashDir();
    await writeTrashItem(td, '2026-04-25-t001.md', makeTrashMd({
      id: '2026-04-25-t001', type: 'task', status: 'active', title: 'My task',
      deletedAt: '2026-04-25T10:00:00.000Z',
    }));
    await writeTrashItem(td, '2026-04-24-t002.md', makeTrashMd({
      id: '2026-04-24-t002', type: 'goal', status: 'active', title: 'My goal',
      deletedAt: '2026-04-24T10:00:00.000Z',
    }));
    await writeTrashItem(td, '2026-04-23-t003.md', makeTrashMd({
      id: '2026-04-23-t003', type: 'event', status: 'done', title: 'My event',
      deletedAt: '2026-04-23T10:00:00.000Z',
    }));

    const ctx = makeCtx(USER_ID, '/organize trash list');
    await handleOrganize(ctx as never, deps);
    expect(ctx.replies).toHaveLength(1);
    const reply = ctx.replies[0]!;
    // Should contain item titles
    expect(reply).toContain('My task');
    expect(reply).toContain('My goal');
    expect(reply).toContain('My event');
    // Should contain item ids (in some form — possibly HTML-escaped)
    expect(reply).toContain('2026-04-25-t001');
    expect(reply).toContain('2026-04-24-t002');
    expect(reply).toContain('2026-04-23-t003');
    // Should show total
    expect(reply).toMatch(/3 item/);
  });

  it('TL-3: paginated — offset=0 returns first page, offset=1 returns second item', async () => {
    const td = trashDir();
    for (const [id, iso] of [
      ['2026-04-25-t010', '2026-04-25T10:00:00.000Z'],
      ['2026-04-24-t011', '2026-04-24T10:00:00.000Z'],
      ['2026-04-23-t012', '2026-04-23T10:00:00.000Z'],
    ] as [string, string][]) {
      await writeTrashItem(td, `${id}.md`, makeTrashMd({
        id, type: 'task', status: 'active', title: `Item ${id}`,
        deletedAt: iso,
      }));
    }

    // First page (offset 0, limit 50) returns all 3
    const ctx1 = makeCtx(USER_ID, '/organize trash list');
    await handleOrganize(ctx1 as never, deps);
    expect(ctx1.replies[0]).toContain('2026-04-25-t010');
    expect(ctx1.replies[0]).toContain('2026-04-24-t011');
    expect(ctx1.replies[0]).toContain('2026-04-23-t012');

    // Offset 1 skips most-recent item
    const ctx2 = makeCtx(USER_ID, '/organize trash list 1');
    await handleOrganize(ctx2 as never, deps);
    expect(ctx2.replies[0]).not.toContain('2026-04-25-t010');
    expect(ctx2.replies[0]).toContain('2026-04-24-t011');
    expect(ctx2.replies[0]).toContain('2026-04-23-t012');
  });

  it('TL-4: invalid offset strings → "Invalid offset" reply (R6)', async () => {
    const badInputs = ['-1', '1.5', '1e3', 'abc', '0xff', '+1'];
    for (const bad of badInputs) {
      const ctx = makeCtx(USER_ID, `/organize trash list ${bad}`);
      await handleOrganize(ctx as never, deps);
      expect(ctx.replies).toHaveLength(1);
      expect(ctx.replies[0]).toMatch(/invalid offset/i);
    }
  });

  it('TL-5: max-cap offset 100000 → accepted (returns empty beyond total)', async () => {
    const ctx = makeCtx(USER_ID, '/organize trash list 100000');
    await handleOrganize(ctx as never, deps);
    // Either "empty" or "offset beyond end" reply, NOT an error reply
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).not.toMatch(/invalid offset/i);
  });

  it('TL-6: offset 100001 (> max cap) → "Invalid offset" reply', async () => {
    const ctx = makeCtx(USER_ID, '/organize trash list 100001');
    await handleOrganize(ctx as never, deps);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toMatch(/invalid offset/i);
  });

  it('TL-7: offset 0 explicitly → same as no offset', async () => {
    const td = trashDir();
    await writeTrashItem(td, '2026-04-25-t020.md', makeTrashMd({
      id: '2026-04-25-t020', type: 'task', status: 'active', title: 'Only item',
      deletedAt: '2026-04-25T10:00:00.000Z',
    }));

    const ctx = makeCtx(USER_ID, '/organize trash list 0');
    await handleOrganize(ctx as never, deps);
    expect(ctx.replies[0]).toContain('Only item');
  });
});
