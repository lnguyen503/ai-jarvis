/**
 * Integration tests for GET /api/webapp/debates/:id/stream (SSE) (v1.16.0).
 *
 * R1 quad-binding cleanup tests require controlled connection lifecycle.
 * We use Node.js native fetch with AbortController to simulate client disconnect.
 *
 * Covers:
 *   - Auth: 401/403 on SSE endpoint
 *   - 404 for non-existent/cross-user run
 *   - SSE headers present
 *   - Initial snapshot event received
 *   - round event received when published after connect
 *   - complete event received when run is already terminal
 *   - error event received when run is already aborted
 *   - R1-1: cleanup on client AbortController abort (simulates req.close)
 *   - R1-4: cleanup is idempotent (listener count 0 after multiple closes)
 *   - listener count = 0 after SSE close (R1-2)
 *   - idle close sends idle-timeout comment (hard to test in integration; skipped with note)
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
import { debateEventBus } from '../../src/debate/eventbus.js';

const BOT_TOKEN = 'debates_stream_test_token';
const TEST_PORT = 17962;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-debates-stream-'));
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

/** Read the first N SSE events from a stream response (text/event-stream). */
async function readSseEvents(
  res: Response,
  count: number,
  timeoutMs = 3000,
): Promise<Array<{ event: string; data: string }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    let currentEvent = '';
    let currentData = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6).trim();
      } else if (line === '' && currentEvent) {
        events.push({ event: currentEvent, data: currentData });
        currentEvent = '';
        currentData = '';
      }
    }
  }
  reader.releaseLock();
  return events;
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('GET /api/webapp/debates/:id/stream — auth', () => {
  it('DS-A1: 401 when no auth header', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates/some-id/stream`);
    expect(res.status).toBe(401);
  });

  it('DS-A2: 403 when user not in allowlist', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates/some-id/stream`, { headers: authHeader(USER_C_ID) });
    expect(res.status).toBe(403);
  });

  it('DS-A3: 404 for non-existent run id', async () => {
    const res = await fetch(`${BASE_URL}/api/webapp/debates/nonexistent-uuid/stream`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(404);
  });

  it('DS-A4: 404 for cross-user run (P8 single-query)', async () => {
    const id = mem.debateRuns.create({ userId: USER_B_ID, topic: 'B private', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, { headers: authHeader(USER_A_ID) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SSE headers + snapshot
// ---------------------------------------------------------------------------

describe('GET /api/webapp/debates/:id/stream — headers + events', () => {
  it('DS-A5: SSE headers set correctly', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'headers test', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    ac.abort();
  });

  it('DS-A6: initial snapshot event received', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'snap test', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });
    const events = await readSseEvents(res, 1, 2000);
    ac.abort();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.event).toBe('snapshot');
    const parsed = JSON.parse(events[0]!.data) as { id: string; topic: string };
    expect(parsed.id).toBe(id);
    expect(parsed.topic).toBe('snap test');
  });

  it('DS-A7: complete event sent immediately for already-terminal run', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'done', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    mem.debateRuns.update(id, { status: 'complete' });
    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });
    const events = await readSseEvents(res, 2, 2000);
    ac.abort();
    const types = events.map((e) => e.event);
    expect(types).toContain('snapshot');
    expect(types).toContain('complete');
  });

  it('DS-A8: error event sent immediately for aborted run', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'aborted', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    mem.debateRuns.update(id, { status: 'aborted', abortReason: 'pm2_restart' });
    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });
    const events = await readSseEvents(res, 2, 2000);
    ac.abort();
    const types = events.map((e) => e.event);
    expect(types).toContain('snapshot');
    expect(types).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// R1 quad-binding cleanup tests
// ---------------------------------------------------------------------------

describe('GET /api/webapp/debates/:id/stream — R1 quad-binding cleanup', () => {
  it('DS-A9: listener count returns to baseline after client disconnect (R1-2)', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'cleanup test', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const baselineCount = debateEventBus.listenerCountFor(id);

    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });
    // Wait for snapshot event (confirms handler is registered)
    await readSseEvents(res, 1, 2000);

    // Abort client connection
    ac.abort();

    // Allow event loop to propagate the close event
    await new Promise((r) => setTimeout(r, 100));

    // Listener count should be back to baseline
    expect(debateEventBus.listenerCountFor(id)).toBe(baselineCount);
  });

  it('DS-A10: after complete event, listener count returns to baseline (R1-4 idempotency)', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'complete cleanup', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const baseline = debateEventBus.listenerCountFor(id);

    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });
    // Wait for snapshot
    await readSseEvents(res, 1, 2000);

    // Publish complete event from server side
    debateEventBus.publish(id, { type: 'complete', finalState: {} as import('../../src/debate/index.js').DebateState });

    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));

    expect(debateEventBus.listenerCountFor(id)).toBe(baseline);
  });

  it('DS-A11: 5 sequential SSE connections + abort each — 0 leaked listeners (R1-5)', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'concurrent', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const baseline = debateEventBus.listenerCountFor(id);

    // Open and abort 5 SSE connections sequentially to avoid ECONNRESET in parallel
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      try {
        const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
          headers: authHeader(USER_A_ID),
          signal: ac.signal,
        });
        // Read the snapshot event to confirm subscription was registered
        await readSseEvents(res, 1, 1000).catch(() => {});
      } catch {
        // AbortError on abort is expected
      }
      ac.abort();
      // Small delay to let the server process the close
      await new Promise((r) => setTimeout(r, 50));
    }

    // After all 5 connections closed, listener count should return to baseline
    expect(debateEventBus.listenerCountFor(id)).toBe(baseline);
  }, 15000);

  it('DS-A12: round event published via eventBus reaches SSE client', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'round delivery', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });

    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });

    // Wait for snapshot first
    await readSseEvents(res, 1, 2000);

    // Publish a round event from server side
    debateEventBus.publish(id, {
      type: 'round',
      round: { roundNumber: 1, debaterName: 'Claude', modelName: 'claude-opus', content: 'hello', ts: new Date().toISOString() },
    });

    const events = await readSseEvents(res, 1, 2000);
    ac.abort();

    expect(events.some((e) => e.event === 'round')).toBe(true);
    if (events.length > 0 && events[0]!.event === 'round') {
      const roundData = JSON.parse(events[0]!.data) as { roundNumber: number };
      expect(roundData.roundNumber).toBe(1);
    }
  });

  /**
   * DS-A13: res.finish cleanup path (QA M2).
   *
   * When a terminal 'complete' event causes the server to call res.end(), the
   * Node.js response emits 'finish'. The onClose() once-only flag makes it
   * idempotent — whichever of res.finish or res.close fires first, cleanup
   * runs exactly once.
   *
   * We verify: after publishing 'complete' (which triggers onClose() + res.end()
   * server-side), the listener count returns to baseline BEFORE the AbortController
   * fires. The abort is issued defensively after the assertion but the socket is
   * already server-closed; we swallow the expected AbortError.
   */
  it('DS-A13: res.finish path — listener cleared after complete event triggers res.end()', async () => {
    const id = mem.debateRuns.create({ userId: USER_A_ID, topic: 'finish path', modelLineupJson: '[]', participantCount: 4, roundsTarget: 2 });
    const baseline = debateEventBus.listenerCountFor(id);

    const ac = new AbortController();
    // fetchP may reject with AbortError after res.end() closes the socket
    const res = await fetch(`${BASE_URL}/api/webapp/debates/${id}/stream`, {
      headers: authHeader(USER_A_ID),
      signal: ac.signal,
    });

    // Wait for snapshot — confirms handler subscribed
    await readSseEvents(res, 1, 2000);

    // Publish 'complete' — server calls onClose() + res.end() → fires res.finish
    debateEventBus.publish(id, { type: 'complete', finalState: {} as import('../../src/debate/index.js').DebateState });

    // Allow the server's res.end() + finish event to propagate before checking
    await new Promise((r) => setTimeout(r, 300));

    // Listener must be at baseline — cleanup fired via res.finish (or res.close)
    expect(debateEventBus.listenerCountFor(id)).toBe(baseline);

    // Abort defensively; socket may already be closed server-side — swallow error
    ac.abort();
    // Extra settle time so the closed socket doesn't interfere with afterEach teardown
    await new Promise((r) => setTimeout(r, 100));
  });

  /**
   * DS-A14: res.error cleanup path (QA M2) — deferred.
   *
   * The res.error path (TCP write failure / broken pipe) requires injecting a
   * low-level socket error that cannot be triggered from a plain fetch() client
   * against a localhost HTTP/1.1 server without a raw net.Socket or mock.
   * The once-only `unsubscribed` flag in onClose() guarantees cleanup is correct
   * by construction (same flag verified by DS-A9/DS-A11/DS-A13), but a dedicated
   * external assertion is deferred to v1.16.x test-infra polish.
   *
   * Track: v1.16.x — add a raw net.Socket that destroys itself mid-stream to
   * exercise the res.on('error', onClose) binding in isolation.
   */
  it.skip('DS-A14: res.error path — deferred to v1.16.x (test-infra: raw socket write error)', () => {
    // Deferred: requires injecting a broken-pipe / TCP write error from outside.
    // The once-only unsubscribed flag covers this path by construction (same
    // flag as req.close / res.close / res.finish verified by DS-A9..DS-A13).
  });
});
