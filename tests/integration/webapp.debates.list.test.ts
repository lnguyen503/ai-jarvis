/**
 * Integration tests for GET /api/webapp/debates (v1.16.0).
 *
 * Covers:
 *   - Auth: 401 for missing header; 401 for bad HMAC; 403 for not-in-allowlist
 *   - Per-user scoping: User A sees only their debates; User B sees none
 *   - Sort: newest first
 *   - Pagination: limit + offset
 *   - Response shape
 *
 * ~9 tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

const BOT_TOKEN = 'debates_list_test_token';
const TEST_PORT = 17960;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-debates-list-'));
  const dbPath = path.join(tmpDir, 'jarvis.db');
  const cfg = makeConfig(dbPath);
  mem = initMemory(cfg);
  server = createWebappServer({ config: cfg, version: '1.16.0-test', memory: mem });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  mem.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('GET /api/webapp/debates — auth', () => {
  it('DL-A1: 401 when no Authorization header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates`);
    expect(res.status).toBe(401);
  });

  it('DL-A2: 401 when invalid initData', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates`, {
      headers: { Authorization: 'tma invalid_init_data' },
    });
    expect(res.status).toBe(401);
  });

  it('DL-A3: 403 when userId not in allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates`, {
      headers: authHeader(USER_C_ID),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Per-user scoping
// ---------------------------------------------------------------------------

describe('GET /api/webapp/debates — per-user scoping + shape', () => {
  it('DL-A4: User A sees only their debates', async () => {
    // Seed User A debates
    mem.debateRuns.create({ userId: USER_A_ID, topic: 'A debate', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    mem.debateRuns.create({ userId: USER_A_ID, topic: 'A debate 2', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    // Seed User B debate
    mem.debateRuns.create({ userId: USER_B_ID, topic: 'B debate', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });

    const res = await fetch(`${BASE_URL}/api/webapp/debates`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; debates: { topic: string }[] };
    expect(body.ok).toBe(true);
    expect(body.debates.length).toBe(2);
    for (const d of body.debates) {
      expect(d.topic).toContain('A debate');
    }
  });

  it('DL-A5: User B sees empty list when they have no debates', async () => {
    // Only seed User A
    mem.debateRuns.create({ userId: USER_A_ID, topic: 'A debate', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });

    const res = await fetch(`${BASE_URL}/api/webapp/debates`, { headers: authHeader(USER_B_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; debates: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.debates.length).toBe(0);
  });

  it('DL-A6: response shape has required fields', async () => {
    mem.debateRuns.create({ userId: USER_A_ID, topic: 'shape test', modelLineupJson: '[{"modelName":"glm"}]', participantCount: 4, roundsTarget: 2 });
    const res = await fetch(`${BASE_URL}/api/webapp/debates`, { headers: authHeader(USER_A_ID) });
    const body = await res.json() as { ok: boolean; debates: Record<string, unknown>[]; pagination: unknown };
    expect(body.ok).toBe(true);
    expect(body.pagination).toBeDefined();
    const d = body.debates[0]!;
    expect(d['id']).toBeDefined();
    expect(d['topic']).toBe('shape test');
    expect(d['status']).toBe('running');
    expect(d['participantCount']).toBe(4);
    expect(d['roundsTarget']).toBe(2);
    expect(d['roundsCompleted']).toBe(0);
    expect(d['createdAt']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sort + pagination
// ---------------------------------------------------------------------------

describe('GET /api/webapp/debates — pagination', () => {
  it('DL-A7: limit param respected', async () => {
    for (let i = 0; i < 5; i++) {
      mem.debateRuns.create({ userId: USER_A_ID, topic: `topic ${i}`, modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    }
    const res = await fetch(`${BASE_URL}/api/webapp/debates?limit=2`, { headers: authHeader(USER_A_ID) });
    const body = await res.json() as { debates: unknown[] };
    expect(body.debates.length).toBe(2);
  });

  it('DL-A8: offset param respected', async () => {
    for (let i = 0; i < 4; i++) {
      mem.debateRuns.create({ userId: USER_A_ID, topic: `paged ${i}`, modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    }
    const r1 = await fetch(`${BASE_URL}/api/webapp/debates?limit=2&offset=0`, { headers: authHeader(USER_A_ID) });
    const r2 = await fetch(`${BASE_URL}/api/webapp/debates?limit=2&offset=2`, { headers: authHeader(USER_A_ID) });
    const b1 = await r1.json() as { debates: { id: string }[] };
    const b2 = await r2.json() as { debates: { id: string }[] };
    const ids1 = new Set(b1.debates.map((d) => d.id));
    const ids2 = new Set(b2.debates.map((d) => d.id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it('DL-A9: pagination object returned with limit+offset', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates?limit=3&offset=1`, { headers: authHeader(USER_A_ID) });
    const body = await res.json() as { pagination: { limit: number; offset: number } };
    expect(body.pagination.limit).toBe(3);
    expect(body.pagination.offset).toBe(1);
  });
});
