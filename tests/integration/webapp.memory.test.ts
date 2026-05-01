/**
 * Integration tests for /api/webapp/memory routes (v1.17.0).
 *
 * Covers:
 *   - Auth: 401/403
 *   - GET /api/webapp/memory — list entries
 *   - GET /api/webapp/memory/:key — detail
 *   - POST /api/webapp/memory — create (key whitelist validation)
 *   - PATCH /api/webapp/memory/:key — update (If-Match ETag per W4)
 *   - DELETE /api/webapp/memory/:key — delete
 *
 * ~12 tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

const BOT_TOKEN = 'memory_routes_test_token';
const TEST_PORT = 17951;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 111111;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-route-'));
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

const authA = () => authHeaderFor(USER_A_ID);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/webapp/memory — auth', () => {
  it('MR-A1: 401 for missing Authorization header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/memory`);
    expect(res.status).toBe(401);
  });

  it('MR-A2: 403 for user not in allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/memory`, { headers: authHeaderFor(USER_C_ID) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('GET /api/webapp/memory — list', () => {
  it('MR-L1: returns empty list when no entries exist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/memory`, { headers: authA() });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; entries: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /api/webapp/memory — create', () => {
  it('MR-C1: creates entry and returns 201 with ETag', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'prefer-brief', body: 'I prefer brief replies' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; entry: { key: string; body: string; etag: string } };
    expect(body.ok).toBe(true);
    expect(body.entry.key).toBe('prefer-brief');
    expect(body.entry.body).toBe('I prefer brief replies');
    expect(body.entry.etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('MR-C2: rejects invalid key (too long — 129 chars, over the 128-char cap)', async () => {
    // v1.18.0 ADR 018 D2: MEMORY_KEY_RE extended to allow uppercase + dots (coach key support).
    // A key that is 129 chars long still exceeds the cap and must be rejected.
    const tooLongKey = 'a'.repeat(129);
    const res = await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: tooLongKey, body: 'body text' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('MR-C3: rejects key with special characters', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'bad key!', body: 'body' }),
    });
    expect(res.status).toBe(400);
  });

  it('MR-C4: rejects duplicate key with 409', async () => {
    await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'mykey', body: 'first' }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'mykey', body: 'second' }),
    });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe('GET /api/webapp/memory/:key — detail', () => {
  it('MR-D1: returns 404 for non-existent key', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/memory/nonexistent`, { headers: authA() });
    expect(res.status).toBe(404);
  });

  it('MR-D2: returns entry detail for existing key', async () => {
    await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'tone', body: 'formal' }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/memory/tone`, { headers: authA() });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; entry: { key: string; body: string } };
    expect(body.entry.key).toBe('tone');
    expect(body.entry.body).toBe('formal');
  });

  /**
   * Fix 2 (F2 closure): GET /api/webapp/memory/:key MUST set the ETag response
   * header. Without it, memory/app.js reads null from res.headers.get('ETag')
   * and never sends If-Match, silently breaking the R5 + W4 concurrency guard.
   */
  it('MR-D3 (Fix 2): GET /:key sets ETag response header matching body.entry.etag', async () => {
    // Create entry
    await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'etagcheck', body: 'value for etag test' }),
    });
    // Fetch the detail and assert the ETag header is present and non-empty
    const res = await fetch(`${BASE_URL}/api/webapp/memory/etagcheck`, { headers: authA() });
    expect(res.status).toBe(200);
    const etagHeader = res.headers.get('ETag');
    expect(etagHeader).toBeTruthy();
    expect(etagHeader).toMatch(/^"[0-9a-f]{16}"$/);
    // Assert the header matches the body field (single source of truth)
    const body = await res.json() as { ok: boolean; entry: { etag: string } };
    expect(etagHeader).toBe(body.entry.etag);
  });
});

// ---------------------------------------------------------------------------
// Update with If-Match (W4)
// ---------------------------------------------------------------------------

describe('PATCH /api/webapp/memory/:key — update with If-Match', () => {
  it('MR-U1: update without If-Match succeeds', async () => {
    await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'lang', body: 'English' }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/memory/lang`, {
      method: 'PATCH',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'French' }),
    });
    expect(res.status).toBe(200);
  });

  it('MR-U2: update with wrong If-Match returns 412', async () => {
    await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'style', body: 'casual' }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/memory/style`, {
      method: 'PATCH',
      headers: { ...authA(), 'Content-Type': 'application/json', 'If-Match': '"wrongetag0000001"' },
      body: JSON.stringify({ body: 'formal' }),
    });
    expect(res.status).toBe(412);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('ETAG_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('DELETE /api/webapp/memory/:key — delete', () => {
  it('MR-Del1: deletes entry and returns 200', async () => {
    await fetch(`${BASE_URL}/api/webapp/memory`, {
      method: 'POST',
      headers: { ...authA(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'to-delete', body: 'temporary' }),
    });
    const res = await fetch(`${BASE_URL}/api/webapp/memory/to-delete`, {
      method: 'DELETE',
      headers: authA(),
    });
    expect(res.status).toBe(200);
    // Verify gone
    const getRes = await fetch(`${BASE_URL}/api/webapp/memory/to-delete`, { headers: authA() });
    expect(getRes.status).toBe(404);
  });
});
