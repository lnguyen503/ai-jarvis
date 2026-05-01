/**
 * Integration tests for bulk / parallel mutation patterns (v1.14.6).
 *
 * Tests parallel PATCH, DELETE, POST /complete, and POST / (create) to verify
 * that all four mutation verbs coexist correctly on the same Express app
 * (W6 mount-create wire integrity + R1 verb-asymmetric If-Match).
 *
 * Port: 17911 (distinct from all other integration test ports).
 *
 * Test numbering: BK-1..BK-N
 *
 * Coverage (~15 cases):
 *   BK-1..BK-3   — parallel PATCH on 3 different items all succeed
 *   BK-4..BK-5   — parallel DELETE on 2 items both succeed independently
 *   BK-6..BK-7   — parallel POST /complete on 2 items
 *   BK-8..BK-9   — parallel POST / (create) — two creates get distinct IDs
 *   BK-10        — simultaneous PATCH + DELETE + CREATE in one promise batch
 *   BK-11        — PATCH with If-Match + PATCH without If-Match in parallel (R1 asymmetry)
 *   BK-12        — DELETE and PATCH same item in parallel — one should win (409/404)
 *   BK-13        — POST /complete does NOT require If-Match (verb-asymmetric R1)
 *   BK-14        — DELETE does NOT require If-Match (verb-asymmetric R1)
 *   BK-15        — POST / (create) does NOT use If-Match (R1 — no ETag on create input)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { createItem } from '../../src/organize/storage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_TOKEN = 'bulk_int_test_token';
const TEST_PORT = 17911;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 111111;
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
// Server lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

// Item IDs pre-created in beforeEach
let item1: string;
let item2: string;
let item3: string;
let item4: string;
let item5: string;

function buildConfig() {
  const dbPath = path.join(dataDir, 'jarvis.db');
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

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bulk-int-'));
  dataDir = fs.realpathSync.native(tmpRoot);

  // Pre-create 5 task items for parallel tests
  const i1 = await createItem(USER_A_ID, dataDir, { type: 'task', title: 'Bulk item 1' });
  const i2 = await createItem(USER_A_ID, dataDir, { type: 'task', title: 'Bulk item 2' });
  const i3 = await createItem(USER_A_ID, dataDir, { type: 'task', title: 'Bulk item 3' });
  const i4 = await createItem(USER_A_ID, dataDir, { type: 'task', title: 'Bulk item 4' });
  const i5 = await createItem(USER_A_ID, dataDir, { type: 'task', title: 'Bulk item 5' });

  item1 = i1.frontMatter.id;
  item2 = i2.frontMatter.id;
  item3 = i3.frontMatter.id;
  item4 = i4.frontMatter.id;
  item5 = i5.frontMatter.id;

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
// Request helpers
// ---------------------------------------------------------------------------

function patchItem(itemId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader(USER_A_ID), ...headers },
    body: JSON.stringify(body),
  });
}

function deleteItem(itemId: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}`, {
    method: 'DELETE',
    headers: { ...authHeader(USER_A_ID), ...headers },
  });
}

function completeItem(itemId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items/${itemId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(USER_A_ID) },
    body: JSON.stringify(body),
  });
}

function createItemRequest(body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}/api/webapp/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(USER_A_ID) },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// BK-1..BK-3 — parallel PATCH on 3 different items
// ---------------------------------------------------------------------------

describe('Parallel PATCH on distinct items (BK-1..BK-3)', () => {
  it('BK-1: three concurrent PATCHes all return 200', async () => {
    const [r1, r2, r3] = await Promise.all([
      patchItem(item1, { title: 'P1 updated' }),
      patchItem(item2, { title: 'P2 updated' }),
      patchItem(item3, { title: 'P3 updated' }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it('BK-2: each PATCH updates only its own item (no cross-item contamination)', async () => {
    const [r1, r2, r3] = await Promise.all([
      patchItem(item1, { title: 'Only-1' }),
      patchItem(item2, { title: 'Only-2' }),
      patchItem(item3, { title: 'Only-3' }),
    ]);
    const b1 = await r1.json() as { item: { title: string } };
    const b2 = await r2.json() as { item: { title: string } };
    const b3 = await r3.json() as { item: { title: string } };
    expect(b1.item.title).toBe('Only-1');
    expect(b2.item.title).toBe('Only-2');
    expect(b3.item.title).toBe('Only-3');
  });

  it('BK-3: PATCH returns item with status=active by default (unchanged)', async () => {
    const res = await patchItem(item1, { title: 'Status check' });
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// BK-4..BK-5 — parallel DELETE on 2 items
// ---------------------------------------------------------------------------

describe('Parallel DELETE on distinct items (BK-4..BK-5)', () => {
  it('BK-4: two concurrent DELETEs on different items both return 200', async () => {
    const [r1, r2] = await Promise.all([
      deleteItem(item1),
      deleteItem(item2),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('BK-5: after DELETE, PATCH on the same item returns 404', async () => {
    await deleteItem(item1);
    const res = await patchItem(item1, { title: 'Ghost update' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// BK-6..BK-7 — parallel POST /complete on 2 items
// ---------------------------------------------------------------------------

describe('Parallel POST /complete on distinct items (BK-6..BK-7)', () => {
  it('BK-6: two concurrent POST /complete return 200', async () => {
    const [r1, r2] = await Promise.all([
      completeItem(item1),
      completeItem(item2),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('BK-7: completing an item sets status to done', async () => {
    const res = await completeItem(item3);
    expect(res.status).toBe(200);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// BK-8..BK-9 — parallel POST / (create) gets distinct IDs
// ---------------------------------------------------------------------------

describe('Parallel POST /api/webapp/items (create) (BK-8..BK-9)', () => {
  it('BK-8: two concurrent creates both return 201', async () => {
    const [r1, r2] = await Promise.all([
      createItemRequest({ type: 'task', title: 'Concurrent A' }),
      createItemRequest({ type: 'task', title: 'Concurrent B' }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it('BK-9: two concurrent creates get distinct item IDs', async () => {
    const [r1, r2] = await Promise.all([
      createItemRequest({ type: 'task', title: 'Distinct ID A' }),
      createItemRequest({ type: 'task', title: 'Distinct ID B' }),
    ]);
    const b1 = await r1.json() as { item: { id: string } };
    const b2 = await r2.json() as { item: { id: string } };
    expect(b1.item.id).not.toBe(b2.item.id);
  });
});

// ---------------------------------------------------------------------------
// BK-10 — simultaneous PATCH + DELETE + CREATE in one batch
// ---------------------------------------------------------------------------

describe('Mixed mutation batch (BK-10)', () => {
  it('BK-10: PATCH item1 + DELETE item2 + CREATE new task all succeed independently', async () => {
    const [rPatch, rDel, rCreate] = await Promise.all([
      patchItem(item1, { title: 'Mixed batch patch' }),
      deleteItem(item2),
      createItemRequest({ type: 'task', title: 'Mixed batch new' }),
    ]);
    expect(rPatch.status).toBe(200);
    expect(rDel.status).toBe(200);
    expect(rCreate.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// BK-11 — PATCH with/without If-Match in parallel (R1 verb-asymmetric)
// ---------------------------------------------------------------------------

describe('Verb-asymmetric If-Match behaviour (BK-11)', () => {
  it('BK-11: PATCH without If-Match still succeeds (If-Match is optional on PATCH)', async () => {
    // First get the ETag
    const getRes = await fetch(`${BASE_URL}/api/webapp/items/${item4}`, {
      headers: authHeader(USER_A_ID),
    });
    const etag = getRes.headers.get('ETag') ?? '';

    const [withIfMatch, withoutIfMatch] = await Promise.all([
      patchItem(item4, { title: 'With ETag' }, { 'If-Match': etag }),
      patchItem(item5, { title: 'No ETag needed' }),  // different item, no If-Match
    ]);
    // Both should succeed
    expect(withIfMatch.status).toBe(200);
    expect(withoutIfMatch.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// BK-12 — DELETE and PATCH same item in parallel
// ---------------------------------------------------------------------------

describe('Race: DELETE + PATCH same item (BK-12)', () => {
  it('BK-12: one of DELETE/PATCH wins; the loser gets 404 (EPERM/ENOENT mapped — not 500)', async () => {
    // v1.14.6 Fix 1 (QA M1): catch blocks in PATCH and DELETE handlers now map
    // EPERM/ENOENT to 404 instead of 500. Under Windows full-suite I/O contention
    // the OS rename race produces EPERM on the loser; the fix ensures a clean 404.
    const [rDel, rPatch] = await Promise.all([
      deleteItem(item1),
      patchItem(item1, { title: 'Race loser or winner' }),
    ]);
    // At least one must succeed
    const statuses = [rDel.status, rPatch.status];
    expect(statuses.some((s) => s === 200)).toBe(true);
    // The loser must be 404 (file gone) or 200 (beat the delete). 500 is no longer acceptable.
    for (const s of statuses) {
      expect([200, 404]).toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------
// BK-13..BK-15 — R1 verb-asymmetric: DELETE/complete/create need no If-Match
// ---------------------------------------------------------------------------

describe('R1 verb-asymmetric If-Match (BK-13..BK-15)', () => {
  it('BK-13: POST /complete without If-Match → 200 (no ETag required)', async () => {
    const res = await completeItem(item1);
    expect(res.status).toBe(200);
  });

  it('BK-14: DELETE without If-Match → 200 (no ETag required)', async () => {
    const res = await deleteItem(item1);
    expect(res.status).toBe(200);
  });

  it('BK-15: POST / (create) without If-Match → 201 (no ETag on create input)', async () => {
    const res = await createItemRequest({ type: 'task', title: 'No if-match on create' });
    expect(res.status).toBe(201);
  });
});
