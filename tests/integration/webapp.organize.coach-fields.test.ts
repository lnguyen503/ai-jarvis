/**
 * Integration tests: organize webapp coach fields (v1.18.0 commit 9).
 *
 * Verifies:
 *   CF-1: GET /api/webapp/items/:id returns coachIntensity and coachNudgeCount
 *   CF-2: legacy items (no coach fields) normalize to 'off' / 0
 *   CF-3: PATCH coachIntensity → stored and returned in response
 *   CF-4: PATCH invalid coachIntensity → 400 COACH_INTENSITY_INVALID
 *   CF-5: coachNudgeCount NOT in ALLOWED_PATCH_FIELDS → 400 (unknown field rejection)
 *   CF-6: GET /api/webapp/items (list) returns items array
 *   CF-7: PATCH coachIntensity='off' clears coaching
 *   CF-8: POST /complete response includes coachIntensity + coachNudgeCount
 *   CF-9: item with coachIntensity='persistent' + coachNudgeCount=3 → both returned on GET
 *  CF-10: PATCH multiple fields including coachIntensity → all applied
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

const BOT_TOKEN = 'coach_fields_int_test_token';
const TEST_PORT = 17920;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const USER_ID = 88100;
const NOW_UNIX = Math.floor(Date.now() / 1000);

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
    user: JSON.stringify({ id: USER_ID, username: 'testuser', first_name: 'Test' }),
  });
}

const AUTH = { Authorization: `tma ${validInitData()}` };

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeItemMd(opts: {
  id: string;
  title: string;
  coachIntensity?: string;
  coachNudgeCount?: number;
}): string {
  const coachLines = [
    ...(opts.coachIntensity ? [`coachIntensity: ${opts.coachIntensity}`] : []),
    ...(opts.coachNudgeCount ? [`coachNudgeCount: ${opts.coachNudgeCount}`] : []),
  ].join('\n');
  return (
    `---\n` +
    `id: ${opts.id}\n` +
    `type: task\n` +
    `status: active\n` +
    `title: ${opts.title}\n` +
    `created: 2026-04-24T10:00:00.000Z\n` +
    `due: \n` +
    `parentId: \n` +
    `calendarEventId: \n` +
    `tags: []\n` +
    (coachLines ? coachLines + '\n' : '') +
    `---\n\n` +
    `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->\n\n` +
    `## Notes\n\n## Progress\n`
  );
}

function writeFixture(dataDir: string, item: Parameters<typeof makeItemMd>[0]): void {
  const userDir = path.join(dataDir, 'organize', String(USER_ID));
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, `${item.id}.md`), makeItemMd(item), 'utf8');
}

// ---------------------------------------------------------------------------
// Full config builder (mirrors webapp.organize.mutate.test.ts)
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
    data: { dir: dataDir },
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: WebappServer;
let mem: MemoryApi;
let dataDir: string;

const ITEM_LEGACY  = '2026-04-24-cf01';
const ITEM_COACHED = '2026-04-24-cf02';
const ITEM_NUDGED  = '2026-04-24-cf03';

beforeEach(async () => {
  _resetDb();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coach-fields-'));
  dataDir = fs.realpathSync.native(tmpRoot);

  writeFixture(dataDir, { id: ITEM_LEGACY, title: 'Legacy item (no coach fields)' });
  writeFixture(dataDir, { id: ITEM_COACHED, title: 'Coached item', coachIntensity: 'gentle' });
  writeFixture(dataDir, { id: ITEM_NUDGED, title: 'Nudged item', coachIntensity: 'persistent', coachNudgeCount: 3 });

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

describe('webapp organize coach fields (commit 9)', () => {
  it('CF-1: GET /api/webapp/items/:id returns coachIntensity and coachNudgeCount', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_COACHED}`, { headers: AUTH });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.item).toHaveProperty('coachIntensity');
    expect(data.item).toHaveProperty('coachNudgeCount');
    expect(data.item['coachIntensity']).toBe('gentle');
    expect(data.item['coachNudgeCount']).toBe(0);
  });

  it('CF-2: legacy item (no coach fields) normalizes to coachIntensity=auto (v1.19.0 D1), coachNudgeCount=0', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_LEGACY}`, { headers: AUTH });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    // v1.19.0 D1: legacy items (no coachIntensity field) now read as 'auto' not 'off'
    expect(data.item['coachIntensity']).toBe('auto');
    expect(data.item['coachNudgeCount']).toBe(0);
  });

  it('CF-3: PATCH coachIntensity → stored and returned', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_LEGACY}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachIntensity: 'moderate' }),
    });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.item['coachIntensity']).toBe('moderate');
  });

  it('CF-4: PATCH invalid coachIntensity → 400 COACH_INTENSITY_INVALID', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_LEGACY}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachIntensity: 'extreme' }),
    });
    const data = await res.json() as { ok: boolean; code: string };
    expect(res.status).toBe(400);
    expect(data.code).toBe('COACH_INTENSITY_INVALID');
  });

  it('CF-5: PATCH coachNudgeCount (agent-only field) → 400 unknown field', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_LEGACY}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachNudgeCount: 5 }),
    });
    const data = await res.json() as { ok: boolean; code: string };
    expect(res.status).toBe(400);
    // coachNudgeCount not in ALLOWED_PATCH_FIELDS — returns unknown fields error
    expect(data.ok).toBe(false);
  });

  it('CF-6: GET /api/webapp/items (list) returns items array', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items?status=active`, { headers: AUTH });
    const data = await res.json() as { ok: boolean; items: unknown[] };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('CF-7: PATCH coachIntensity=off stores and normalizes correctly', async () => {
    // First set to moderate
    await fetch(`${BASE_URL}/api/webapp/items/${ITEM_COACHED}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachIntensity: 'moderate' }),
    });
    // Then set back to off
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_COACHED}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachIntensity: 'off' }),
    });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(data.item['coachIntensity']).toBe('off');
  });

  it('CF-8: POST /complete response includes coachIntensity + coachNudgeCount', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_COACHED}/complete`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.item).toHaveProperty('coachIntensity');
    expect(data.item).toHaveProperty('coachNudgeCount');
  });

  it('CF-9: item with coachIntensity=persistent + coachNudgeCount=3 → both returned on GET', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_NUDGED}`, { headers: AUTH });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(data.item['coachIntensity']).toBe('persistent');
    expect(data.item['coachNudgeCount']).toBe(3);
  });

  it('CF-10: PATCH multiple fields including coachIntensity → all applied', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/items/${ITEM_LEGACY}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated title', coachIntensity: 'persistent' }),
    });
    const data = await res.json() as { ok: boolean; item: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(data.item['title']).toBe('Updated title');
    expect(data.item['coachIntensity']).toBe('persistent');
  });
});
