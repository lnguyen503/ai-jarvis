/**
 * Integration tests: webapp coach setup multi-profile endpoint (v1.20.0 ADR 020 D18).
 *
 * Verifies:
 *   CP-1:  POST /coach/setup with {profile:'morning', hhmm:'08:00', chatId} → 200 + morning cron
 *   CP-2:  POST /coach/setup with {profile:'midday', hhmm:'12:30', chatId} → 200 + midday cron
 *   CP-3:  POST /coach/setup with {profile:'evening', hhmm:'19:00', chatId} → 200 + evening cron
 *   CP-4:  POST /coach/setup with {profile:'weekly', hhmm:'09:00', weekday:1, chatId} → 200 + weekly cron Mon
 *   CP-5:  POST /coach/setup with invalid profile → 400 VALIDATION_ERROR
 *   CP-6:  POST /coach/setup with invalid hhmm → 400 VALIDATION_ERROR
 *   CP-7:  POST /coach/setup weekly without weekday → 400 VALIDATION_ERROR
 *   CP-8:  POST /coach/setup weekly with weekday out of range → 400 VALIDATION_ERROR
 *   CP-9:  POST /coach/setup two different profiles → both tasks exist independently
 *   CP-10: GET  /coach/profiles returns expected shape per profile state
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

const BOT_TOKEN = 'coach_profiles_int_test_token';
const TEST_PORT = 17932;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const USER_ID = 88210;
const NOW_UNIX = Math.floor(Date.now() / 1000);
const CHAT_ID = 88210;

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
    user: JSON.stringify({ id: USER_ID, username: 'testprofile', first_name: 'Profile' }),
  });
}

const AUTH = { Authorization: `tma ${validInitData()}` };
const AUTH_JSON = { ...AUTH, 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Config builder (minimal, same pattern as webapp.coach.setup.test.ts)
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
    health: { port: 7881 },
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coach-profiles-'));
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
// Tests
// ---------------------------------------------------------------------------

describe('webapp coach setup multi-profile (ADR 020 D18)', () => {
  it('CP-1: POST /coach/setup with morning profile returns 200 and correct daily cron', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'morning', hhmm: '08:00', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(true);
    expect(typeof data['taskId']).toBe('number');
    expect(data['cronExpression']).toBe('0 8 * * *');
    expect(data['profile']).toBe('morning');
  });

  it('CP-2: POST /coach/setup with midday profile returns 200 and correct daily cron', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'midday', hhmm: '12:30', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(true);
    expect(data['cronExpression']).toBe('30 12 * * *');
    expect(data['profile']).toBe('midday');
  });

  it('CP-3: POST /coach/setup with evening profile returns 200 and correct daily cron', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'evening', hhmm: '19:00', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(true);
    expect(data['cronExpression']).toBe('0 19 * * *');
    expect(data['profile']).toBe('evening');
  });

  it('CP-4: POST /coach/setup with weekly profile + weekday returns 200 and weekly cron', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'weekly', hhmm: '09:00', weekday: 1, chatId: CHAT_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(true);
    expect(data['cronExpression']).toBe('0 9 * * 1');
    expect(data['profile']).toBe('weekly');
  });

  it('CP-5: POST /coach/setup with invalid profile → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'lunch', hhmm: '12:00', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(false);
    expect(data['code']).toBe('VALIDATION_ERROR');
  });

  it('CP-6: POST /coach/setup with invalid hhmm → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'morning', hhmm: '25:99', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(false);
    expect(data['code']).toBe('VALIDATION_ERROR');
  });

  it('CP-7: POST /coach/setup weekly without weekday → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'weekly', hhmm: '09:00', chatId: CHAT_ID }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(false);
    expect(data['code']).toBe('VALIDATION_ERROR');
  });

  it('CP-8: POST /coach/setup weekly with weekday out of range → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'weekly', hhmm: '09:00', weekday: 8, chatId: CHAT_ID }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(false);
    expect(data['code']).toBe('VALIDATION_ERROR');
  });

  it('CP-9: POST /coach/setup two different profiles creates both tasks independently', async () => {
    // Set up morning profile
    const r1 = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'morning', hhmm: '08:00', chatId: CHAT_ID }),
    });
    expect(r1.status).toBe(200);

    // Set up evening profile
    const r2 = await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'evening', hhmm: '20:00', chatId: CHAT_ID }),
    });
    expect(r2.status).toBe(200);

    // Both tasks must be present in scheduled tasks list
    const listRes = await fetch(`${BASE_URL}/api/webapp/scheduled`, { headers: AUTH });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json() as Record<string, unknown>;
    const tasks = listData['tasks'] as Array<{ description: string }>;
    const descriptions = tasks.map((t) => t.description);
    expect(descriptions).toContain('__coach_morning__');
    expect(descriptions).toContain('__coach_evening__');
  });

  it('CP-10: GET /coach/profiles returns expected shape with active profiles', async () => {
    // Set up morning profile first
    await fetch(`${BASE_URL}/api/webapp/coach/setup`, {
      method: 'POST',
      headers: AUTH_JSON,
      body: JSON.stringify({ profile: 'morning', hhmm: '08:00', chatId: CHAT_ID }),
    });

    const res = await fetch(`${BASE_URL}/api/webapp/coach/profiles`, { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data['ok']).toBe(true);
    expect(Array.isArray(data['profiles'])).toBe(true);

    const profiles = data['profiles'] as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(4); // all 4 profiles always returned

    const morning = profiles.find((p) => p['profile'] === 'morning');
    expect(morning).toBeDefined();
    expect(morning!['active']).toBe(true);
    expect(morning!['hhmm']).toBe('08:00');

    const midday = profiles.find((p) => p['profile'] === 'midday');
    expect(midday!['active']).toBe(false);

    // quietUntil is null when no quiet mode set
    expect(data['quietUntil']).toBeNull();
  });
});
