/**
 * Integration tests: webapp coach setup + reset-memory endpoints (v1.18.0 commit 10).
 *
 * Verifies:
 *   CS-1:  POST /api/webapp/coach/setup returns 200 + taskId + cronExpression
 *   CS-2:  POST /api/webapp/coach/setup → task visible in GET /api/webapp/scheduled
 *   CS-3:  POST /api/webapp/coach/setup twice → idempotent (re-uses/replaces coach task)
 *   CS-4:  POST /api/webapp/coach/setup with invalid time → 400 VALIDATION_ERROR
 *   CS-5:  POST /api/webapp/coach/setup with missing chatId → 400 VALIDATION_ERROR
 *   CS-6:  POST /api/webapp/coach/reset-memory without confirm → 200 CONFIRM_REQUIRED
 *   CS-7:  POST /api/webapp/coach/reset-memory?confirm=1 → 200 ok + deletedCount
 *   CS-8:  PATCH /api/webapp/scheduled/:id where description='__coach__' → 400 RESERVED_DESCRIPTION
 *   CS-9:  POST /api/webapp/coach/setup auth failure → 401
 *  CS-10:  POST /api/webapp/coach/reset-memory body { confirm: true } → 200 ok
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { upsertCoachTask } from '../../src/coach/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'coach_setup_int_test_token';
const TEST_PORT = 17930;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const USER_ID = 88200;
const NOW_UNIX = Math.floor(Date.now() / 1000);
const CHAT_ID = 88200;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function buildInitData(fields: Record<string, string>): string {
  const pairs = Object.entries(fields).sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.set(k, v);
  params.set('hash', hash);
  return params.toString();
}

function validInitData(): string {
  return buildInitData({
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: USER_ID, username: 'testcoach', first_name: 'Coach' }),
  });
}

const AUTH = { Authorization: `tma ${validInitData()}` };
const AUTH_JSON = { ...AUTH, 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Full config builder (mirrors webapp.organize.coach-fields.test.ts)
// ---------------------------------------------------------------------------

function makeConfig(dataDir: string) {
  const dbPath = path.join(dataDir, 'jarvis.db');
  return {
    telegram: { allowedUserIds: [USER_ID], botToken: BOT_TOKEN },
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
    health: { port: 7879 },
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
    data: { dir: dataDir },
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

beforeEach(async () => {
  _resetDb();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coach-setup-'));
  dataDir = fs.realpathSync.native(tmpRoot);

  const cfg = makeConfig(dataDir);
  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.18.0-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  _resetDb();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webapp coach setup + reset-memory (commit 10)', () => {
  it('CS-1: POST /api/webapp/coach/setup returns 200 + taskId + cronExpression', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: '09:00', chatId: CHAT_ID }),
    });
    const data = await res.json() as { ok: boolean; taskId: number; cronExpression: string };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.taskId).toBe('number');
    expect(data.cronExpression).toBe('0 9 * * *');
  });

  it('CS-2: POST /api/webapp/coach/setup → task visible in GET /api/webapp/scheduled', async () => {
    await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: '14:30', chatId: CHAT_ID }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, { headers: AUTH });
    const data = await res.json() as { ok: boolean; tasks: Array<{ description: string; cron_expression?: string }> };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    const coachTask = data.tasks.find((t) => t.description === '__coach__');
    expect(coachTask).toBeDefined();
  });

  it('CS-3: POST /api/webapp/coach/setup twice → idempotent (one coach task total)', async () => {
    await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: '08:00', chatId: CHAT_ID }),
    });
    await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: '10:00', chatId: CHAT_ID }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, { headers: AUTH });
    const data = await res.json() as { ok: boolean; tasks: Array<{ description: string }> };
    expect(res.status).toBe(200);
    const coachTasks = data.tasks.filter((t) => t.description === '__coach__');
    expect(coachTasks.length).toBe(1);
  });

  it('CS-4: POST /api/webapp/coach/setup with invalid time → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: 'not-a-time', chatId: CHAT_ID }),
    });
    const data = await res.json() as { ok: boolean; code: string };
    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('CS-5: POST /api/webapp/coach/setup with missing chatId → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: '09:00' }),
    });
    const data = await res.json() as { ok: boolean; code: string };
    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('CS-6: POST /api/webapp/coach/reset-memory without confirm → 200 CONFIRM_REQUIRED', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/reset-memory`, {
      method: 'POST',
      headers: AUTH,
    });
    const data = await res.json() as { ok: boolean; code: string };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('CONFIRM_REQUIRED');
  });

  it('CS-7: POST /api/webapp/coach/reset-memory?confirm=1 → 200 ok + deletedCount', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/reset-memory?confirm=1`, {
      method: 'POST',
      headers: AUTH,
    });
    const data = await res.json() as { ok: boolean; deletedCount: number };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.deletedCount).toBe('number');
  });

  it('CS-8: PATCH /api/webapp/scheduled/:id where description=__coach__ → 400 RESERVED_DESCRIPTION', async () => {
    // Insert a coach task directly via memory so we have an ID to PATCH
    const taskId = upsertCoachTask(mem, USER_ID, CHAT_ID, '0 9 * * *');
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled/${taskId}`, {
      method: 'PATCH',
      headers: AUTH_JSON,
      body: JSON.stringify({ status: 'paused' }),
    });
    const data = await res.json() as { ok: boolean; code: string };
    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('RESERVED_DESCRIPTION');
  });

  it('CS-9: POST /api/webapp/coach/setup auth failure → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: { Authorization: 'tma invalid_init_data', 'Content-Type': 'application/json' },
      body: JSON.stringify({ time: '09:00', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('CS-10: POST /api/webapp/coach/reset-memory body { confirm: true } → 200 ok', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/reset-memory`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json() as { ok: boolean; deletedCount: number };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.deletedCount).toBe('number');
  });

  // -------------------------------------------------------------------------
  // CS-11: regression for P2 fix Item 3 (Scalability WARNING-1.18.0.A)
  // Without scheduler.reload() after upsertCoachTask, the new coach task is
  // not picked up by node-cron until pm2 restart. Wire a spy scheduler and
  // assert reload() fires on every successful POST /coach/setup.
  // -------------------------------------------------------------------------
  it('CS-11: POST /api/webapp/coach/setup calls scheduler.reload() — same trap as v1.17.0 WARNING-1.17.0.A', async () => {
    // Stop the default server (which has no scheduler bound) and re-start with
    // a spy scheduler to observe the reload call.
    await server.stop();

    const reload = vi.fn();
    const spyScheduler = { reload, start: () => {}, stop: () => {}, _fireTaskForTests: () => false } as unknown as Parameters<WebappServer['setScheduler']>[0];

    const cfg = makeConfig(dataDir);
    server = createWebappServer({ config: cfg, version: '1.18.0-test', memory: mem });
    server.setScheduler(spyScheduler);
    await server.start();

    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ time: '07:30', chatId: CHAT_ID }),
    });
    const data = await res.json() as { ok: boolean };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
