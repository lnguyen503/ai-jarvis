/**
 * Integration tests for POST /api/webapp/items (v1.14.6 D17).
 *
 * Pattern mirrors webapp.organize.mutate.test.ts: real Express server on a
 * dedicated port, native fetch, no supertest. Real filesystem fixtures.
 *
 * Test numbering: CR-1..CR-N (separate from read/mutate/complete numbering).
 *
 * Coverage (25+ cases):
 *   CR-1..CR-5   — auth failures (401/403)
 *   CR-6..CR-9   — validation errors (400 codes from validateCreateBody)
 *   CR-10        — parentId existence check (400 PARENT_NOT_FOUND)
 *   CR-11        — parentId is a goal but type=goal (CREATE_PARENT_ON_GOAL via validator)
 *   CR-12..CR-15 — happy path: 201, response shape, ETag header, Cache-Control header
 *   CR-16        — type=goal with parentId=null → ok (no parent required for goals)
 *   CR-17        — type=event → ok
 *   CR-18        — with notes and progress (D8.b)
 *   CR-19        — with due date
 *   CR-20        — with tags
 *   CR-21        — with valid parentId pointing to active goal → 201
 *   CR-22        — parentId pointing to non-goal item → 400 PARENT_NOT_GOAL
 *   CR-23        — parentId pointing to abandoned goal → 400 PARENT_NOT_ACTIVE
 *   CR-24        — audit row emitted on success
 *   CR-25        — user B cannot see user A items; creates independently
 *   CR-26        — W4: NUL byte in title → 400 TITLE_INVALID_CHARS
 *   CR-27        — status field in body → 400 CREATE_UNKNOWN_FIELDS
 *   CR-28        — response item has correct OrganizeItemDetail shape
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { createItem, organizeUserDir, parentExistsAndIsActiveGoal } from '../../src/organize/storage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'create_int_test_token';
const TEST_PORT = 17912;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 111111;
const USER_B_ID = 222222;
const USER_C_ID = 333333;

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

function validInitDataFor(userId: number, overrides: Record<string, string> = {}): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
    ...overrides,
  });
}

function twoHourStaleInitDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX - 7200),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
}

function authHeader(userId: number): Record<string, string> {
  return { Authorization: `tma ${validInitDataFor(userId)}` };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

// Known goal IDs used across tests
let activeGoalId: string;
let abandonedGoalId: string;
let taskItemId: string;

function buildConfig() {
  const dbPath = path.join(dataDir, 'jarvis.db');
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
}

beforeEach(async () => {
  _resetDb();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-create-int-'));
  dataDir = fs.realpathSync.native(tmpRoot);

  // Pre-create items used in parent-existence tests
  const activeGoal = await createItem(USER_A_ID, dataDir, { type: 'goal', title: 'Active Goal' });
  activeGoalId = activeGoal.frontMatter.id;

  const abandonedGoal = await createItem(USER_A_ID, dataDir, { type: 'goal', title: 'Abandoned Goal' });
  abandonedGoalId = abandonedGoal.frontMatter.id;
  // Manually mark as abandoned via updateItem
  const { updateItem } = await import('../../src/organize/storage.js');
  await updateItem(USER_A_ID, dataDir, abandonedGoalId, { status: 'abandoned' });

  const taskItem = await createItem(USER_A_ID, dataDir, { type: 'task', title: 'Task (not a goal)' });
  taskItemId = taskItem.frontMatter.id;

  const cfg = buildConfig();
  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.14.6-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// POST helper
// ---------------------------------------------------------------------------

function post(body: unknown, userId = USER_A_ID, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(userId),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// CR-1..CR-5 — Auth failures
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — auth failures', () => {
  it('CR-1: no Authorization header → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'task', title: 'hi' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('AUTH_FAILED');
  });

  it('CR-2: header without "tma " prefix → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validInitDataFor(USER_A_ID)}`,
      },
      body: JSON.stringify({ type: 'task', title: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('CR-3: stale initData (> 1h) → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `tma ${twoHourStaleInitDataFor(USER_A_ID)}`,
      },
      body: JSON.stringify({ type: 'task', title: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('CR-4: user not in allowlist → 403', async () => {
    const res = await post({ type: 'task', title: 'hi' }, USER_C_ID);
    expect(res.status).toBe(403);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('NOT_ALLOWED');
  });

  it('CR-5: HMAC tampered → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'tma auth_date=12345&user=%7B%22id%22%3A111111%7D&hash=badhash',
      },
      body: JSON.stringify({ type: 'task', title: 'hi' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CR-6..CR-11 — Validation errors (400)
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — validation errors', () => {
  it('CR-6: missing type → 400 CREATE_TYPE_REQUIRED', async () => {
    const res = await post({ title: 'No type' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('CREATE_TYPE_REQUIRED');
  });

  it('CR-7: invalid type "archived" → 400 CREATE_TYPE_REQUIRED', async () => {
    const res = await post({ type: 'archived', title: 'Bad type' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('CREATE_TYPE_REQUIRED');
  });

  it('CR-8: status field present → 400 CREATE_UNKNOWN_FIELDS', async () => {
    const res = await post({ type: 'task', title: 'hi', status: 'active' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('CREATE_UNKNOWN_FIELDS');
  });

  it('CR-9: missing title → 400 (TITLE_REQUIRED or TITLE_NOT_STRING)', async () => {
    const res = await post({ type: 'task' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(['TITLE_REQUIRED', 'TITLE_NOT_STRING']).toContain(body.code);
  });

  it('CR-10: parentId not found → 400 PARENT_NOT_FOUND', async () => {
    const res = await post({ type: 'task', title: 'Orphan', parentId: '2020-01-01-xxxx' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('PARENT_NOT_FOUND');
  });

  it('CR-11: CREATE_PARENT_ON_GOAL via validator (goal+parentId) → 400', async () => {
    const res = await post({ type: 'goal', title: 'Nested Goal', parentId: activeGoalId });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('CREATE_PARENT_ON_GOAL');
  });
});

// ---------------------------------------------------------------------------
// CR-12..CR-15 — Happy path: response shape, status, headers
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — happy path', () => {
  it('CR-12: minimal create → 201 Created', async () => {
    const res = await post({ type: 'task', title: 'New task' });
    expect(res.status).toBe(201);
  });

  it('CR-13: response has {ok: true, item, etag} envelope', async () => {
    const res = await post({ type: 'task', title: 'Envelope check' });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown>; etag: string };
    expect(body.ok).toBe(true);
    expect(typeof body.item).toBe('object');
    expect(typeof body.etag).toBe('string');
    expect(body.etag.length).toBeGreaterThan(0);
  });

  it('CR-14: ETag header is set on 201 response', async () => {
    const res = await post({ type: 'task', title: 'ETag check' });
    expect(res.status).toBe(201);
    expect(res.headers.get('ETag')).toBeTruthy();
  });

  it('CR-15: Cache-Control: no-store header is set', async () => {
    const res = await post({ type: 'task', title: 'Cache check' });
    const cc = res.headers.get('Cache-Control') ?? '';
    expect(cc).toContain('no-store');
  });
});

// ---------------------------------------------------------------------------
// CR-16..CR-20 — Various type and field combinations
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — type and field combinations', () => {
  it('CR-16: type=goal with parentId=null → 201 (no parent = top-level goal)', async () => {
    const res = await post({ type: 'goal', title: 'Top-level goal', parentId: null });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.item['type']).toBe('goal');
    expect(body.item['parentId']).toBeNull();
  });

  it('CR-17: type=event → 201, item.type = "event"', async () => {
    const res = await post({ type: 'event', title: 'Team meeting', due: '2026-05-01' });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item['type']).toBe('event');
    expect(body.item['due']).toBe('2026-05-01');
  });

  it('CR-18: with notes and progress (D8.b) → 201, both stored', async () => {
    const res = await post({
      type: 'task',
      title: 'With notes and progress',
      notes: 'Initial note',
      progress: '- 2026-04-25: started',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item['notes']).toContain('Initial note');
    expect(body.item['progress']).toContain('started');
  });

  it('CR-19: with due date → 201, item.due set', async () => {
    const res = await post({ type: 'task', title: 'Due task', due: '2026-12-31' });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item['due']).toBe('2026-12-31');
  });

  it('CR-20: with tags → 201, item.tags set', async () => {
    const res = await post({ type: 'task', title: 'Tagged task', tags: ['work', 'urgent'] });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item['tags']).toEqual(['work', 'urgent']);
  });
});

// ---------------------------------------------------------------------------
// CR-21..CR-23 — parentId existence checks
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — parentId existence checks', () => {
  it('CR-21: parentId pointing to active goal → 201', async () => {
    const res = await post({ type: 'task', title: 'Child task', parentId: activeGoalId });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(body.item['parentId']).toBe(activeGoalId);
  });

  it('CR-22: parentId pointing to task (not a goal) → 400 PARENT_NOT_GOAL', async () => {
    const res = await post({ type: 'task', title: 'Child of task', parentId: taskItemId });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('PARENT_NOT_GOAL');
  });

  it('CR-23: parentId pointing to abandoned goal → 400 PARENT_NOT_ACTIVE', async () => {
    const res = await post({ type: 'task', title: 'Child of abandoned', parentId: abandonedGoalId });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('PARENT_NOT_ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// CR-24 — Audit row emitted on success
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — audit', () => {
  it('CR-24: successful create emits webapp.item_create audit row', async () => {
    const res = await post({ type: 'task', title: 'Audit test' });
    expect(res.status).toBe(201);

    // Allow a tick for the synchronous audit insert (not debounced)
    await new Promise((r) => setTimeout(r, 10));

    const createRows = mem.auditLog.listByCategory('webapp.item_create');
    expect(createRows.length).toBeGreaterThanOrEqual(1);

    // Verify the detail shape (D7: itemId, type, hasParent, ip — no field values)
    const row = createRows[0]!;
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    expect(typeof detail['itemId']).toBe('string');
    expect(detail['type']).toBe('task');
    expect(detail['hasParent']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CR-25 — Cross-user isolation
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — cross-user isolation', () => {
  it('CR-25: user B creating items does not affect user A items', async () => {
    const resA = await post({ type: 'task', title: 'User A task' }, USER_A_ID);
    const resB = await post({ type: 'task', title: 'User B task' }, USER_B_ID);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const bodyA = await resA.json() as { item: { id: string } };
    const bodyB = await resB.json() as { item: { id: string } };

    // Items have different IDs
    expect(bodyA.item.id).not.toBe(bodyB.item.id);
  });
});

// ---------------------------------------------------------------------------
// CR-26..CR-27 — Edge cases
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — edge cases', () => {
  it('CR-26: NUL byte in title → 400 TITLE_INVALID_CHARS (W4)', async () => {
    const res = await post({ type: 'task', title: 'Bad\x00Title' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('TITLE_INVALID_CHARS');
  });

  it('CR-27: unknown field "calendarEventId" → 400 CREATE_UNKNOWN_FIELDS', async () => {
    const res = await post({ type: 'task', title: 'hi', calendarEventId: 'CAL123' });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; code: string };
    expect(body.code).toBe('CREATE_UNKNOWN_FIELDS');
  });
});

// ---------------------------------------------------------------------------
// CR-28 — Response item shape (OrganizeItemDetail)
// ---------------------------------------------------------------------------

describe('POST /api/webapp/items — response item shape', () => {
  it('CR-28: item has all required OrganizeItemDetail fields', async () => {
    const res = await post({
      type: 'task',
      title: 'Shape check',
      due: '2026-06-01',
      tags: ['work'],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; item: Record<string, unknown>; etag: string };

    const item = body.item;
    // Required fields from OrganizeItemDetail
    expect(typeof item['id']).toBe('string');
    expect(item['id']).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/);
    expect(item['type']).toBe('task');
    expect(item['status']).toBe('active'); // always starts active
    expect(item['title']).toBe('Shape check');
    expect(typeof item['created']).toBe('string');
    expect(item['due']).toBe('2026-06-01');
    expect(item['tags']).toEqual(['work']);
    expect(item['parentId']).toBeNull();
    expect(item['calendarEventId']).toBeNull();
    // updated is set by createItem (v1.14.3 D1)
    expect(typeof item['updated']).toBe('string');
    // ETag in response body matches ETag header
    expect(body.etag).toBe(res.headers.get('ETag'));
  });
});
