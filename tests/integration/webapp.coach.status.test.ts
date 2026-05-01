/**
 * Integration tests: GET /api/webapp/coach/profiles and POST /coach/setup
 * mute_all action (v1.20.0 ADR 020 D20).
 *
 * Verifies:
 *   CS-1: GET /coach/profiles with no active tasks → 200, profiles all active:false, quietUntil:null
 *   CS-2: GET /coach/profiles after setting morning → morning active:true with correct hhmm
 *   CS-3: POST /coach/setup { action: 'mute_all' } with no tasks → 200, removedCount:0
 *   CS-4: POST /coach/setup { action: 'mute_all' } removes all profile tasks → removedCount N
 *   CS-5: POST /coach/setup { action: 'mute_all' } removes legacy __coach__ task too
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

const BOT_TOKEN = 'coach_status_int_test_token';
const TEST_PORT = 17940;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const USER_ID = 88220;
const NOW_UNIX = Math.floor(Date.now() / 1000);
const CHAT_ID = 88220;

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
    user: JSON.stringify({ id: USER_ID, username: 'teststatus', first_name: 'Status' }),
  });
}

const AUTH = { Authorization: `tma ${validInitData()}` };
const AUTH_JSON = { ...AUTH, 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Config builder
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
    health: { port: 7882 },
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coach-status-'));
  dataDir = fs.realpathSync.native(tmpRoot);
  const cfg = makeConfig(dataDir);
  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.20.0-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  _resetDb();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// ---------------------------------------------------------------------------
// Helper: insert a coach task directly into memory
// ---------------------------------------------------------------------------
function insertCoachTask(description: string, cronExpression: string): number {
  return mem.scheduledTasks.insert({
    description,
    cron_expression: cronExpression,
    command: '${coach_prompt}',
    chat_id: CHAT_ID,
    owner_user_id: USER_ID,
  });
}

// ---------------------------------------------------------------------------
// CS-1: GET /coach/profiles with no active tasks → profiles all active:false
// ---------------------------------------------------------------------------
describe('GET /api/webapp/coach/profiles', () => {
  it('CS-1: no active tasks → 200, all profiles inactive, quietUntil null', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/profiles`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; profiles: Array<{ profile: string; active: boolean }>; quietUntil: string | null };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.profiles.length).toBe(4); // morning, midday, evening, weekly
    expect(body.profiles.every((p) => !p.active)).toBe(true);
    expect(body.quietUntil).toBeNull();
  });

  it('CS-2: after setting morning → morning active:true with correct hhmm', async () => {
    // Set up morning profile via the API
    const setupRes = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'morning', hhmm: '08:15', chatId: CHAT_ID }),
    });
    expect(setupRes.status).toBe(200);

    const res = await fetch(`${BASE_URL}/api/webapp/coach/profiles`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; profiles: Array<{ profile: string; active: boolean; hhmm?: string }> };
    expect(body.ok).toBe(true);
    const morning = body.profiles.find((p) => p.profile === 'morning');
    expect(morning).toBeDefined();
    expect(morning!.active).toBe(true);
    expect(morning!.hhmm).toBe('08:15');
    // Other profiles remain inactive
    const others = body.profiles.filter((p) => p.profile !== 'morning');
    expect(others.every((p) => !p.active)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CS-3..5: POST /coach/setup { action: 'mute_all' }
// ---------------------------------------------------------------------------
describe('POST /api/webapp/coach/setup action:mute_all', () => {
  it('CS-3: no tasks → removedCount:0', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ action: 'mute_all' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; removedCount: number };
    expect(body.ok).toBe(true);
    expect(body.removedCount).toBe(0);
  });

  it('CS-4: two profile tasks → removedCount:2, tasks gone', async () => {
    insertCoachTask('__coach_morning__', '0 8 * * *');
    insertCoachTask('__coach_evening__', '0 19 * * *');

    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ action: 'mute_all' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; removedCount: number };
    expect(body.ok).toBe(true);
    expect(body.removedCount).toBe(2);

    // Verify tasks are gone
    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    const coachTasks = tasks.filter((t) => t.description.startsWith('__coach'));
    expect(coachTasks.length).toBe(0);
  });

  it('CS-5: legacy __coach__ task also removed by mute_all', async () => {
    insertCoachTask('__coach__', '0 8 * * *');
    insertCoachTask('__coach_midday__', '30 12 * * *');

    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ action: 'mute_all' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; removedCount: number };
    expect(body.ok).toBe(true);
    expect(body.removedCount).toBe(2); // both legacy + midday

    const tasks = mem.scheduledTasks.listByOwner(USER_ID);
    const coachTasks = tasks.filter(
      (t) => t.description === '__coach__' || t.description.startsWith('__coach_'),
    );
    expect(coachTasks.length).toBe(0);
  });
});
