/**
 * Integration tests for GET /api/webapp/debates/:id (v1.16.0).
 *
 * Covers:
 *   - Auth: 401/403
 *   - Cross-user 404 (P8 single-query check)
 *   - Transcript shape (rounds)
 *   - Non-existent id → 404
 *   - Verdict field populated when complete
 *
 * ~8 tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebappServer, type WebappServer } from '../../src/webapp/server.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

const BOT_TOKEN = 'debates_detail_test_token';
const TEST_PORT = 17961;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const USER_A_ID = 111111;
const USER_B_ID = 222222;
const USER_C_ID = 333333;

const NOW_UNIX = Math.floor(Date.now() / 1000);

function buildInitData(botToken: string, fields: Record<string, string>): string {
  const pairs = Object.entries(fields).sort((a, b) => a[0].localeCompare(b[0]));
  const dcs = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dcs).digest('hex');
  const p = new URLSearchParams();
  for (const [k, v] of pairs) p.set(k, v);
  p.set('hash', hash);
  return p.toString();
}

function authHeader(userId: number): Record<string, string> {
  return {
    Authorization: `tma ${buildInitData(BOT_TOKEN, { auth_date: String(NOW_UNIX), user: JSON.stringify({ id: userId, username: `u${userId}`, first_name: 'T' }) })}`,
  };
}

let server: WebappServer;
let mem: MemoryApi;
let tmpDir: string;

function makeConfig(dbPath: string) {
  return {
    telegram: { allowedUserIds: [USER_A_ID, USER_B_ID], botToken: BOT_TOKEN },
    ai: { provider: 'anthropic' as const, model: 'claude-sonnet-4-6', defaultProvider: 'claude', defaultModel: 'claude-sonnet-4-6', premiumProvider: 'claude', premiumModel: 'claude-sonnet-4-6', judgeModel: 'claude-opus-4-6', maxTokens: 4096, temperature: 0.3, maxToolIterations: 10, streamingEnabled: false, streamingEditIntervalMs: 150, streamingCursor: '▍', providers: { claude: {}, 'ollama-cloud': {} }, routing: { enabled: false, fallbackToClaudeOnError: false, logRoutingDecisions: false } },
    whisper: { model: 'whisper-1', apiBaseUrl: 'https://api.openai.com/v1' },
    health: { port: 7878 },
    chat: { userQueueMax: 5, schedulerQueueMax: 20, maxQueueAgeMs: 600000 },
    safety: { confirmationTtlMs: 300000, commandTimeoutMs: 120000, maxOutputLength: 4000, allowEncodedCommands: false, blockedCommands: [] },
    filesystem: { allowedPaths: [tmpDir], readDenyGlobs: [] },
    workspaces: { enabled: false, root: path.join(tmpDir, 'ws') },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath, maxHistoryMessages: 50 },
    mcp: { enabled: false, servers: [] },
    tavily: { enabled: false, apiKey: '', baseUrl: 'https://api.tavily.com' },
    browser: { enabled: false, headless: true, pageTimeoutMs: 15000, maxContentChars: 100000, denyHosts: [], userAgent: '' },
    google: { enabled: false, oauth: { clientId: '', clientSecret: '', tokenPath: path.join(tmpDir, 'gtok.json') }, calendar: { enabled: false, defaultCalendarId: 'primary' }, gmail: { enabled: false, maxResults: 10, send: { enabled: false, confirmationTtlSeconds: 300, rateLimitPerHour: 10, maxRecipientsPerSend: 20, requireReplyToThread: false } } },
    groups: { enabled: false, allowedGroupIds: [], adminUserIds: [], developerUserIds: [], groupRoles: {}, rateLimitPerUser: 10, rateLimitWindowMinutes: 60, maxResponseLength: 2000, disabledTools: [], intentDetection: { enabled: false, provider: 'ollama-cloud', model: 'gemma4:cloud', followUpWindowSeconds: 120, confirmationTtlSeconds: 120, rateLimitPerMinute: 30, recentMessageContext: 4 } },
    context: { autoCompact: false, compactThreshold: 0.75, summarizePrompt: 'S', notifyUser: false },
    aliases: {},
    organize: { reminders: { enabled: false, cronExpression: '0 8 * * *', minActiveItemsForOptIn: 3, dailyCap: 3, itemCooldownMinutes: 4320, muteAfterConsecutiveIgnores: 3, quietHoursLocal: [], triage: { enabled: false, maxItemsPerTriage: 50, triageProvider: 'ollama-cloud', triageModel: 'deepseek-v4-flash:cloud', fallbackProvider: 'claude', fallbackModel: 'claude-haiku-4-5', triageTimeoutMs: 120000, haikuFallbackMaxPerDay: 20, globalHaikuFallbackMaxPerDay: 500, tickConcurrency: 5, wallTimeWarnRatio: 0.75 } }, trashTtlDays: 30, trashEvictCron: '0 4 * * *', trashEvictWallTimeWarnMs: 600000, trashEvictAuditZeroBatches: false, reconcileHotEmitterThreshold: 100 },
    projects: [],
    debate: { panelStateCacheMax: 50, panelStateTtlHours: 24 },
    webapp: { publicUrl: 'https://example.com', staticDir: 'public/webapp', port: TEST_PORT, initDataMaxAgeSeconds: 86400, initDataMaxFutureSkewSeconds: 300, itemsInitDataMaxAgeSeconds: 3600 },
  };
}

beforeEach(async () => {
  _resetDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-debates-detail-'));
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

describe('GET /api/webapp/debates/:id — auth', () => {
  it('DD-A1: 401 when no auth header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates/some-id`);
    expect(res.status).toBe(401);
  });

  it('DD-A2: 403 when user not in allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates/some-id`, { headers: authHeader(USER_C_ID) });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/webapp/debates/:id — cross-user + not-found', () => {
  it('DD-A3: 404 for non-existent id', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates/nonexistent-uuid`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(404);
  });

  it('DD-A4: 404 for cross-user (P8: single-query — same status as not-found)', async () => {
    // Seed User B's debate
    const id = mem.debateRuns.create({ userId: USER_B_ID, topic: 'B private', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    // User A tries to access it
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/webapp/debates/:id — transcript shape', () => {
  it('DD-A5: returns debate with rounds array', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'transcript test', modelLineupJson: '[{"modelName":"glm"}]', participantCount: 2, roundsTarget: 1 });
    mem.debateRounds.append({ debateRunId: id, roundNumber: 1, debaterName: 'Claude', modelName: 'claude-opus', content: 'hello world' });
    mem.debateRounds.append({ debateRunId: id, roundNumber: 1, debaterName: 'GLM', modelName: 'glm', content: 'counter point' });

    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; debate: { id: string; topic: string; rounds: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.debate.id).toBe(id);
    expect(body.debate.topic).toBe('transcript test');
    expect(body.debate.rounds.length).toBe(2);
  });

  it('DD-A6: verdict field populated when debate is complete', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'verdict test', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const verdict = { kind: 'consensus', summary: 'All agreed' };
    mem.debateRuns.update(id, { status: 'complete', verdictJson: JSON.stringify(verdict) });

    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(200);
    const body = await res.json() as { debate: { status: string; verdict: typeof verdict } };
    expect(body.debate.status).toBe('complete');
    expect(body.debate.verdict).toMatchObject(verdict);
  });

  it('DD-A7: own debate is accessible to the correct user', async () => {
    const idA = mem.debateRuns.create({ userId: USER_A_ID, topic: 'my debate', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const idB = mem.debateRuns.create({ userId: USER_B_ID, topic: 'other debate', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });

    const resA = await fetch(`${BASE_URL}/api/webapp/debates/${idA}`, { headers: authHeader(USER_A_ID) });
    expect(resA.status).toBe(200);

    // User A cannot see User B's debate
    const resAB = await fetch(`${BASE_URL}/api/webapp/debates/${idB}`, { headers: authHeader(USER_A_ID) });
    expect(resAB.status).toBe(404);

    // User B can see their own debate
    const resB = await fetch(`${BASE_URL}/api/webapp/debates/${idB}`, { headers: authHeader(USER_B_ID) });
    expect(resB.status).toBe(200);
  });

  it('DD-A8: rounds are in round_number ASC order', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'order test', modelLineupJson: '[]', participantCount: 2, roundsTarget: 2 });
    mem.debateRounds.append({ debateRunId: id, roundNumber: 2, debaterName: 'Claude', modelName: 'claude', content: 'round 2' });
    mem.debateRounds.append({ debateRunId: id, roundNumber: 1, debaterName: 'Claude', modelName: 'claude', content: 'round 1' });

    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}`, { headers: authHeader(USER_A_ID) });
    const body = await res.json() as { debate: { rounds: { roundNumber: number }[] } };
    expect(body.debate.rounds[0]!.roundNumber).toBe(1);
    expect(body.debate.rounds[1]!.roundNumber).toBe(2);
  });
});
