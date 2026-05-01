/**
 * Integration tests for /api/webapp/audit routes (v1.17.0).
 *
 * Covers:
 *   - Auth: 401/403
 *   - GET /api/webapp/audit — list (pagination, filter, cursor, R4 refresh-from-top)
 *   - GET /api/webapp/audit/:id — detail (cross-user 404)
 *   - R6: closed-set category validation (valid, unknown, mixed, SQL injection probe)
 *
 * ~14 tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

const BOT_TOKEN = 'audit_routes_test_token';
const TEST_PORT = 17952;
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

function authHeaderFor(userId: number): Record<string, string> {
  const initData = buildInitData(BOT_TOKEN, {
    auth_date: String(NOW_UNIX),
    user: JSON.stringify({ id: userId, username: `user${userId}`, first_name: 'Test' }),
  });
  return { Authorization: `tma ${initData}` };
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-audit-route-'));
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

function seedAuditRow(userId: number, category = 'tool_call' as const) {
  return mem.auditLog.insertReturningId({
    category,
    actor_user_id: userId,
    detail: { event: 'test' },
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/webapp/audit — auth', () => {
  it('AL-A1: 401 for missing Authorization header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit`);
    expect(res.status).toBe(401);
  });

  it('AL-A2: 403 for user not in allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit`, { headers: authHeaderFor(USER_C_ID) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// List: basic + cross-user
// ---------------------------------------------------------------------------

describe('GET /api/webapp/audit — list', () => {
  it('AL-L1: returns empty list for user with no audit rows', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit`, { headers: authHeaderFor(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rows: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.rows.length).toBe(0);
  });

  it('AL-L2: User A sees only their rows (cross-user isolation)', async () => {
    seedAuditRow(USER_A_ID);
    seedAuditRow(USER_A_ID);
    seedAuditRow(USER_B_ID);

    const res = await fetch(`${BASE_URL}/api/webapp/audit`, { headers: authHeaderFor(USER_A_ID) });
    const body = await res.json() as { rows: { actorUserId: number }[] };
    expect(body.rows.length).toBe(2);
    // The audit rows themselves each include actorUserId = USER_A_ID
    // (Note: the list endpoint also emits a webapp.audit_view row for User A,
    //  but those have actor_user_id = USER_A_ID too, so they'd be included
    //  in the next request. This test verifies the 2 seeded rows are isolated.)
    for (const r of body.rows) {
      expect(r.actorUserId).toBe(USER_A_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// R6: closed-set category validation
// ---------------------------------------------------------------------------

describe('GET /api/webapp/audit — R6 category filter validation', () => {
  it('R6-1: valid categories accepted', async () => {
    seedAuditRow(USER_A_ID, 'webapp.scheduled_view');
    const res = await fetch(`${BASE_URL}/api/webapp/audit?categories=webapp.scheduled_view,webapp.memory_view`, {
      headers: authHeaderFor(USER_A_ID),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('R6-2: unknown category rejected with 400 INVALID_CATEGORY', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit?categories=foo.bar`, {
      headers: authHeaderFor(USER_A_ID),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('INVALID_CATEGORY');
    expect(body.error).toContain('foo.bar');
  });

  it('R6-3: mixed valid/invalid rejected (not silently dropped)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit?categories=webapp.scheduled_view,foo.bar`, {
      headers: authHeaderFor(USER_A_ID),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('INVALID_CATEGORY');
  });

  it('R6-4: empty categories param defaults to all categories', async () => {
    seedAuditRow(USER_A_ID, 'tool_call');
    seedAuditRow(USER_A_ID, 'webapp.scheduled_view');
    const res = await fetch(`${BASE_URL}/api/webapp/audit?categories=`, {
      headers: authHeaderFor(USER_A_ID),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it('R6-5: SQL injection probe rejected at validator (before SQL)', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit?categories=${encodeURIComponent("' OR 1=1 --")}`, {
      headers: authHeaderFor(USER_A_ID),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('INVALID_CATEGORY');
  });
});

// ---------------------------------------------------------------------------
// R4: refresh-from-top semantics
// ---------------------------------------------------------------------------

describe('GET /api/webapp/audit — R4 refresh-from-top', () => {
  it('R4-1: empty cursor returns latest rows (refresh-from-top)', async () => {
    // Seed 3 rows
    for (let i = 0; i < 3; i++) seedAuditRow(USER_A_ID);

    const res = await fetch(`${BASE_URL}/api/webapp/audit?cursor=`, {
      headers: authHeaderFor(USER_A_ID),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rows: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('GET /api/webapp/audit — pagination', () => {
  it('AL-P1: limit param respected', async () => {
    for (let i = 0; i < 5; i++) seedAuditRow(USER_A_ID);
    const res = await fetch(`${BASE_URL}/api/webapp/audit?limit=2`, { headers: authHeaderFor(USER_A_ID) });
    const body = await res.json() as { rows: unknown[]; pagination: { limit: number; nextCursor: string | null } };
    expect(body.rows.length).toBeLessThanOrEqual(2);
    expect(body.pagination.limit).toBe(2);
    // nextCursor should be non-null when there are more rows
    expect(body.pagination.nextCursor).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe('GET /api/webapp/audit/:id — detail', () => {
  it('AL-D1: returns 404 for non-existent id', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/audit/999999`, { headers: authHeaderFor(USER_A_ID) });
    expect(res.status).toBe(404);
  });

  it('AL-D2: returns 404 for cross-user audit row (single-query isolation)', async () => {
    const rowId = seedAuditRow(USER_B_ID);
    const res = await fetch(`${BASE_URL}/api/webapp/audit/${rowId}`, { headers: authHeaderFor(USER_A_ID) });
    expect(res.status).toBe(404);
  });

  it('AL-D3: returns row detail for own audit row', async () => {
    const rowId = seedAuditRow(USER_A_ID, 'tool_call');
    const res = await fetch(`${BASE_URL}/api/webapp/audit/${rowId}`, { headers: authHeaderFor(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; row: { id: number; category: string } };
    expect(body.ok).toBe(true);
    expect(body.row.id).toBe(rowId);
    expect(body.row.category).toBe('tool_call');
  });
});
