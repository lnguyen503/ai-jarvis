/**
 * Integration tests for /api/webapp/scheduled routes (v1.17.0).
 *
 * Covers:
 *   - Auth: 401/403
 *   - GET /api/webapp/scheduled — list (per-user scoping, cross-user isolation)
 *   - GET /api/webapp/scheduled/preview — cron preview
 *   - GET /api/webapp/scheduled/:id — detail (cross-user 404)
 *   - POST /api/webapp/scheduled — create
 *   - PATCH /api/webapp/scheduled/:id — update status
 *   - DELETE /api/webapp/scheduled/:id — delete (cross-user isolation)
 *
 * ~14 tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

const BOT_TOKEN = 'sched_test_token';
const TEST_PORT = 17950;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 111111;
const USER_B_ID = 222222;
const USER_C_ID = 333333; // not in allowlist

const NOW_UNIX = Math.floor(Date.now() / 1000);

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

let server: WebappServer;
let mem: MemoryApi;
let tmpDir: string;

function makeConfig(dbPath: string) {
  return {
    telegram: { allowedUserIds: [USER_A_ID, USER_B_ID], botToken: BOT_TOKEN },
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
    safety: { confirmationTtlMs: 300000, commandTimeoutMs: 120000, maxOutputLength: 4000, allowEncodedCommands: false, blockedCommands: [] },
    filesystem: { allowedPaths: [tmpDir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(tmpDir, 'workspaces') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath, maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: { enabled: false, headless: true, pageTimeoutMs: 15000, maxContentChars: 100000, denyHosts: [], userAgent: '' },
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(tmpDir, 'google-tokens.json') },
      calendar: { enabled: false, defaultCalendarId: 'primary' },
      gmail: { enabled: false, maxResults: 10, send: { enabled: false, confirmationTtlSeconds: 300, rateLimitPerHour: 10, maxRecipientsPerSend: 20, requireReplyToThread: false } },
    },
    groups: {
      enabled: false, allowedGroupIds: [], adminUserIds: [], developerUserIds: [], groupRoles: {},
      rateLimitPerUser: 10, rateLimitWindowMinutes: 60, maxResponseLength: 2000, disabledTools: [],
      intentDetection: { enabled: false, provider: 'ollama-cloud', model: 'gemma4:cloud', followUpWindowSeconds: 120, confirmationTtlSeconds: 120, rateLimitPerMinute: 30, recentMessageContext: 4 },
    },
    context: { autoCompact: false, compactThreshold: 0.75, summarizePrompt: 'Summarize', notifyUser: false },
    aliases: {},
    organize: {
      reminders: {
        enabled: false, cronExpression: '0 8 * * *', minActiveItemsForOptIn: 3, dailyCap: 3,
        itemCooldownMinutes: 4320, muteAfterConsecutiveIgnores: 3, quietHoursLocal: [],
        triage: { enabled: false, maxItemsPerTriage: 50, triageProvider: 'ollama-cloud', triageModel: 'deepseek-v4-flash:cloud', fallbackProvider: 'claude', fallbackModel: 'claude-haiku-4-5', triageTimeoutMs: 120000, haikuFallbackMaxPerDay: 20, globalHaikuFallbackMaxPerDay: 500, tickConcurrency: 5, wallTimeWarnRatio: 0.75 },
      },
      trashTtlDays: 30, trashEvictCron: '0 4 * * *', trashEvictWallTimeWarnMs: 600000, trashEvictAuditZeroBatches: false, reconcileHotEmitterThreshold: 100,
    },
    projects: [],
    debate: { panelStateCacheMax: 50, panelStateTtlHours: 24 },
    webapp: { publicUrl: 'https://example.com', staticDir: 'public/webapp', port: TEST_PORT, initDataMaxAgeSeconds: 86400, initDataMaxFutureSkewSeconds: 300, itemsInitDataMaxAgeSeconds: 3600 },
  };
}

beforeEach(async () => {
  _resetDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sched-test-'));
  const dbPath = path.join(tmpDir, 'jarvis.db');
  const cfg = makeConfig(dbPath);
  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.17.0-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/webapp/scheduled — auth', () => {
  it('SC-A1: 401 for missing Authorization header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`);
    expect(res.status).toBe(401);
  });

  it('SC-A2: 403 for user not in allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, { headers: authHeader(USER_C_ID) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('GET /api/webapp/scheduled — list', () => {
  it('SC-L1: returns empty list for user with no tasks', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; tasks: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.tasks).toEqual([]);
  });

  it('SC-L2: User A sees only their tasks (cross-user isolation)', async () => {
    mem.scheduledTasks.insert({ description: 'A task', cron_expression: '0 9 * * *', command: '/remind', chat_id: 1, owner_user_id: USER_A_ID });
    mem.scheduledTasks.insert({ description: 'B task', cron_expression: '0 10 * * *', command: '/remind', chat_id: 2, owner_user_id: USER_B_ID });

    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { description: string }[] };
    expect(body.tasks.length).toBe(1);
    expect(body.tasks[0]?.description).toBe('A task');
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('GET /api/webapp/scheduled/preview — cron preview', () => {
  it('SC-P1: valid expression returns fire times', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled/preview?expr=0+9+*+*+*`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; fireTimes: string[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.fireTimes)).toBe(true);
    expect(body.fireTimes.length).toBeGreaterThan(0);
  });

  it('SC-P2: invalid expression returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled/preview?expr=not_valid`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(400);
  });

  it('SC-P3: missing expr param returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled/preview`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe('GET /api/webapp/scheduled/:id — detail', () => {
  it('SC-D1: returns 404 for task belonging to another user (cross-user isolation)', async () => {
    const taskId = mem.scheduledTasks.insert({ description: 'B task', cron_expression: '* * * * *', command: '/cmd', chat_id: 2, owner_user_id: USER_B_ID });
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled/${taskId}`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(404);
  });

  it('SC-D2: returns task detail for own task', async () => {
    const taskId = mem.scheduledTasks.insert({ description: 'My task', cron_expression: '0 9 * * *', command: '/run', chat_id: 1, owner_user_id: USER_A_ID });
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled/${taskId}`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; task: { description: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.task.description).toBe('My task');
    expect(body.task.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /api/webapp/scheduled — create', () => {
  it('SC-C1: creates task and returns 201', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, {
      method: 'POST',
      headers: { ...authHeader(USER_A_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'New task', cronExpression: '0 9 * * *', command: '/remind', chatId: 1 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('number');
  });

  it('SC-C2: rejects invalid cron expression', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/scheduled`, {
      method: 'POST',
      headers: { ...authHeader(USER_A_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Bad task', cronExpression: 'not_cron', command: '/run', chatId: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Update + Delete
// ---------------------------------------------------------------------------

describe('PATCH + DELETE /api/webapp/scheduled/:id', () => {
  it('SC-U1: PATCH status pauses and resumes task', async () => {
    const taskId = mem.scheduledTasks.insert({ description: 'Task', cron_expression: '* * * * *', command: '/x', chat_id: 1, owner_user_id: USER_A_ID });

    const patchRes = await fetch(`${BASE_URL}/api/webapp/scheduled/${taskId}`, {
      method: 'PATCH',
      headers: { ...authHeader(USER_A_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(patchRes.status).toBe(200);

    const task = mem.scheduledTasks.get(taskId);
    expect(task?.status).toBe('paused');
  });

  it('SC-U2: DELETE removes task; cross-user DELETE returns 404', async () => {
    const taskId = mem.scheduledTasks.insert({ description: 'Del task', cron_expression: '* * * * *', command: '/x', chat_id: 1, owner_user_id: USER_A_ID });

    // User B can't delete User A's task
    const crossRes = await fetch(`${BASE_URL}/api/webapp/scheduled/${taskId}`, {
      method: 'DELETE',
      headers: authHeader(USER_B_ID),
    });
    expect(crossRes.status).toBe(404);

    // User A can delete their own task
    const delRes = await fetch(`${BASE_URL}/api/webapp/scheduled/${taskId}`, {
      method: 'DELETE',
      headers: authHeader(USER_A_ID),
    });
    expect(delRes.status).toBe(200);
    expect(mem.scheduledTasks.get(taskId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 1: scheduler.reload() called after every successful mutation
// (ADR 017 §7 Risk #8 + CP1 surface row 13 binding)
// Three separate tests: one per mutation path (create / update / delete).
// ---------------------------------------------------------------------------

const RELOAD_TEST_PORT = 17952;
const RELOAD_BASE_URL = `http://127.0.0.1:${RELOAD_TEST_PORT}`;

describe('scheduler.reload() called after successful mutations (Fix 1 / M1)', () => {
  let reloadServer: WebappServer;
  let reloadMem: MemoryApi;
  let reloadTmpDir: string;
  let mockReload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _resetDb();
    reloadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sched-reload-'));
    const dbPath = path.join(reloadTmpDir, 'jarvis-reload.db');
    const cfg = makeConfig(dbPath);
    // Override port for this nested suite
    (cfg.webapp as Record<string, unknown>).port = RELOAD_TEST_PORT;
    reloadMem = initMemory(cfg);
    mockReload = vi.fn();
    // Create server with a mock scheduler wired in via setScheduler
    reloadServer = createWebappServer({ config: cfg, version: '1.17.0-test', memory: reloadMem });
    reloadServer.setScheduler({ reload: mockReload });
    await reloadServer.start();
  });

  afterEach(async () => {
    await reloadServer.stop();
    reloadMem.close();
    try { fs.rmSync(reloadTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('SC-R1 (Fix 1): POST /api/webapp/scheduled calls scheduler.reload() once on success', async () => {
    const res = await fetch(`${RELOAD_BASE_URL}/api/webapp/scheduled`, {
      method: 'POST',
      headers: { ...authHeader(USER_A_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Reload test', cronExpression: '0 9 * * *', command: '/remind', chatId: 1 }),
    });
    expect(res.status).toBe(201);
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('SC-R2 (Fix 1): PATCH /api/webapp/scheduled/:id calls scheduler.reload() once on success', async () => {
    const taskId = reloadMem.scheduledTasks.insert({ description: 'Patch test', cron_expression: '* * * * *', command: '/x', chat_id: 1, owner_user_id: USER_A_ID });
    const res = await fetch(`${RELOAD_BASE_URL}/api/webapp/scheduled/${taskId}`, {
      method: 'PATCH',
      headers: { ...authHeader(USER_A_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(200);
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('SC-R3 (Fix 1): DELETE /api/webapp/scheduled/:id calls scheduler.reload() once on success', async () => {
    const taskId = reloadMem.scheduledTasks.insert({ description: 'Delete test', cron_expression: '* * * * *', command: '/y', chat_id: 1, owner_user_id: USER_A_ID });
    const res = await fetch(`${RELOAD_BASE_URL}/api/webapp/scheduled/${taskId}`, {
      method: 'DELETE',
      headers: authHeader(USER_A_ID),
    });
    expect(res.status).toBe(200);
    expect(mockReload).toHaveBeenCalledTimes(1);
  });
});
