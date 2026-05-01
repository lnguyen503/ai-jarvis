/**
 * Integration tests for R6 pm2-restart zombie cleanup (v1.16.0).
 *
 * The cleanupZombies SQL uses `updated_at < datetime('now', '-5 minutes')`.
 * Since we can't easily insert rows with an artificially old updated_at through
 * the public API in < 5 minutes, we focus on:
 *   - ZC-1: cleanup fires at initMemory boot (without crashing)
 *   - ZC-2: cleanup does NOT touch complete/aborted rows (leaves them alone)
 *
 * The full zombie scenario (actually marking old rows) is covered by DL-11/DL-12
 * in storage.debateLog.test.ts which calls cleanupZombies directly on fresh repos.
 *
 * ~2 tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';

let mem: MemoryApi;
let tmpDir: string;

function makeConfig(dbPath: string) {
  return {
    telegram: { allowedUserIds: [], botToken: 'test-token' },
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
    google: { enabled: false, oauth: { clientId: '', clientSecret: '', tokenPath: path.join(tmpDir, 'gtok.json') }, calendar: { enabled: false, defaultCalendarId: 'primary' }, gmail: { enabled: false, maxResults: 10, send: { enabled: false, confirmationTtlSeconds: 300, rateLimitPerHour: 10, maxRecipientsPerSend: 20, requireReplyToThread: false } } },
    groups: { enabled: false, allowedGroupIds: [], adminUserIds: [], developerUserIds: [], groupRoles: {}, rateLimitPerUser: 10, rateLimitWindowMinutes: 60, maxResponseLength: 2000, disabledTools: [], intentDetection: { enabled: false, provider: 'ollama-cloud', model: 'gemma4:cloud', followUpWindowSeconds: 120, confirmationTtlSeconds: 120, rateLimitPerMinute: 30, recentMessageContext: 4 } },
    context: { autoCompact: false, compactThreshold: 0.75, summarizePrompt: 'Summarize', notifyUser: false },
    aliases: {},
    organize: { reminders: { enabled: false, cronExpression: '0 8 * * *', minActiveItemsForOptIn: 3, dailyCap: 3, itemCooldownMinutes: 4320, muteAfterConsecutiveIgnores: 3, quietHoursLocal: [], triage: { enabled: false, maxItemsPerTriage: 50, triageProvider: 'ollama-cloud', triageModel: 'deepseek-v4-flash:cloud', fallbackProvider: 'claude', fallbackModel: 'claude-haiku-4-5', triageTimeoutMs: 120000, haikuFallbackMaxPerDay: 20, globalHaikuFallbackMaxPerDay: 500, tickConcurrency: 5, wallTimeWarnRatio: 0.75 } }, trashTtlDays: 30, trashEvictCron: '0 4 * * *', trashEvictWallTimeWarnMs: 600000, trashEvictAuditZeroBatches: false, reconcileHotEmitterThreshold: 100 },
    projects: [],
    debate: { panelStateCacheMax: 50, panelStateTtlHours: 24 },
    webapp: { publicUrl: 'https://example.com', staticDir: 'public/webapp', port: 17970, initDataMaxAgeSeconds: 86400, initDataMaxFutureSkewSeconds: 300, itemsInitDataMaxAgeSeconds: 3600 },
  };
}

beforeEach(() => {
  _resetDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-zombie-test-'));
  const dbPath = path.join(tmpDir, 'jarvis.db');
  mem = initMemory(makeConfig(dbPath));
});

afterEach(() => {
  mem.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('R6 zombie cleanup at boot', () => {
  it('ZC-1: initMemory boots without error even with no debate_runs rows', () => {
    // If we get here, boot succeeded and cleanupZombies ran without throwing
    expect(mem.debateRuns).toBeDefined();
    expect(mem.debateRounds).toBeDefined();
  });

  it('ZC-2: recently-created running rows are NOT touched by cleanupZombies', () => {
    // Create a fresh running row (updated_at is now — within 5 minutes)
    const id = mem.debateRuns.create({
      userId: 111,
      topic: 'fresh run',
      modelLineupJson: '[]',
      participantCount: 4,
      roundsTarget: 2,
    });
    // Zombie cleanup should not touch fresh rows (updated_at within 5 minutes)
    const cleaned = mem.debateRuns.cleanupZombies();
    expect(cleaned).toBe(0);
    const row = mem.debateRuns.findByIdScoped(id, 111);
    expect(row!.status).toBe('running');
  });
});
