/**
 * Integration tests verifying R2-mtime sunset (v1.14.4 D6).
 *
 * These tests assert that the X-Captured-Mtime path, staleWarning field,
 * and webapp.stale_edit audit rows NO LONGER exist in items.mutate.ts.
 *
 * ~5 cases per ADR 012 D6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'r2sunset_test_token';
const TEST_PORT = 17909;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const USER_A_ID = 777791;
const NOW_UNIX = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function buildInitData(botToken: string, fields: Record<string, string>): string {
  const pairs = Object.entries(fields).sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

function validInitDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
}

function authHeader(userId: number): Record<string, string> {
  return { Authorization: `tma ${validInitDataFor(userId)}` };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const UPDATED_ISO = '2026-04-24T10:00:00.000Z';

function makeItemMd(id: string, title: string): string {
  return (
    `---\n` +
    `id: ${id}\n` +
    `type: task\n` +
    `status: active\n` +
    `title: ${title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `updated: ${UPDATED_ISO}\n` +
    `tags: []\n` +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->\n\n` +
    `## Notes\n\n` +
    `## Progress\n`
  );
}

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

const ITEM_1 = '2026-04-24-r2s1';

beforeEach(async () => {
  _resetDb();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r2sunset-'));
  dataDir = fs.realpathSync.native(tmpRoot);
  const dbPath = path.join(dataDir, 'jarvis.db');

  const userDir = path.join(dataDir, 'organize', String(USER_A_ID));
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, `${ITEM_1}.md`), makeItemMd(ITEM_1, 'Sunset test'), 'utf8');

  const cfg = {
    telegram: { allowedUserIds: [USER_A_ID], botToken: BOT_TOKEN },
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
    health: { port: 7880 },
    chat: { userQueueMax: 5, schedulerQueueMax: 20, maxQueueAgeMs: 600000 },
    safety: {
      confirmationTtlMs: 300000,
      commandTimeoutMs: 120000,
      maxOutputLength: 4000,
      allowEncodedCommands: false,
      blockedCommands: [],
    },
    filesystem: { allowedPaths: [dataDir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(dataDir, 'workspaces') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath, maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: { enabled: false, headless: true, pageTimeoutMs: 15000, maxContentChars: 100000, denyHosts: [], userAgent: '' },
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(dataDir, 'google-tokens.json') },
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
      port: TEST_PORT,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  };

  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.14.4-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// R2 sunset tests
// ---------------------------------------------------------------------------

describe('R2-mtime sunset (D6) — no staleWarning, no X-Captured-Mtime, no webapp.stale_edit', () => {
  it('R2S-1: PATCH with X-Captured-Mtime header is silently ignored → no staleWarning in response', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(USER_A_ID),
        'X-Captured-Mtime': '0', // stale mtime — should be ignored in v1.14.4
      },
      body: JSON.stringify({ title: 'Updated' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // staleWarning must NOT be present in v1.14.4 (R2 sunset)
    expect(body.staleWarning).toBeUndefined();
  });

  it('R2S-2: PATCH does NOT emit webapp.stale_edit audit rows', async () => {
    await fetch(`${BASE_URL}/api/webapp/items/${ITEM_1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(USER_A_ID),
        'X-Captured-Mtime': '0',
      },
      body: JSON.stringify({ title: 'Updated' }),
    });

    const rows = mem.auditLog.listByCategory('webapp.stale_edit');
    expect(rows.length).toBe(0);
  });

  it('R2S-3: DELETE with X-Captured-Mtime is ignored → no staleWarning in response', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_1}`, {
      method: 'DELETE',
      headers: {
        ...authHeader(USER_A_ID),
        'X-Captured-Mtime': '0',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.staleWarning).toBeUndefined();
  });

  it('R2S-4: POST /complete with X-Captured-Mtime is ignored → no staleWarning', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_1}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(USER_A_ID),
        'X-Captured-Mtime': '0',
      },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.staleWarning).toBeUndefined();
  });

  it('R2S-5: successful PATCH audit row uses webapp.item_mutate category (not stale_edit)', async () => {
    await fetch(`${BASE_URL}/api/webapp/items/${ITEM_1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(USER_A_ID) },
      body: JSON.stringify({ title: 'Normal patch' }),
    });

    const mutateRows = mem.auditLog.listByCategory('webapp.item_mutate');
    const staleRows = mem.auditLog.listByCategory('webapp.stale_edit');

    expect(mutateRows.length).toBeGreaterThan(0);
    expect(staleRows.length).toBe(0);
  });
});
