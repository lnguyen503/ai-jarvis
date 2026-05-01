/**
 * Config schema tests for the v1.7.11 google section.
 * Covers defaults, ENV ref resolution, and field validation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigSchema } from '../../src/config/schema.js';
import { loadConfig, _resetConfig } from '../../src/config/index.js';

function writeCfg(content: unknown, extraEnv: Record<string, string> = {}): string {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-google-cfg-'));
  const file = path.join(allowed, 'config.json');
  // Inject the freshly-created allowed root so the loader's existence check passes
  const merged = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  if (!merged['filesystem']) {
    merged['filesystem'] = { allowedPaths: [allowed], readDenyGlobs: [] };
  } else {
    (merged['filesystem'] as { allowedPaths: string[] }).allowedPaths = [allowed];
  }
  fs.writeFileSync(file, JSON.stringify(merged));
  process.env['CONFIG_PATH'] = file;
  for (const [k, v] of Object.entries(extraEnv)) {
    process.env[k] = v;
  }
  return allowed;
}

function minimalCfg() {
  return {
    telegram: { allowedUserIds: [123], botToken: 'test-token-12345' },
    ai: { defaultProvider: 'claude', defaultModel: 'claude-sonnet-4-6' },
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
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath: './data/jarvis.db', maxHistoryMessages: 50 },
    projects: [],
  };
}

describe('config schema — google section', () => {
  afterEach(() => {
    _resetConfig();
    delete process.env['CONFIG_PATH'];
    delete process.env['GOOGLE_OAUTH_CLIENT_ID'];
    delete process.env['GOOGLE_OAUTH_CLIENT_SECRET'];
  });

  it('defaults to enabled:false with empty oauth + calendar.enabled:false + gmail.enabled:false', () => {
    const parsed = ConfigSchema.safeParse({
      ...minimalCfg(),
      filesystem: { allowedPaths: ['.'], readDenyGlobs: [] },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.google.enabled).toBe(false);
    expect(parsed.data.google.oauth.clientId).toBe('');
    expect(parsed.data.google.oauth.clientSecret).toBe('');
    expect(parsed.data.google.oauth.tokenPath).toBe('./data/google-tokens.json');
    expect(parsed.data.google.calendar.enabled).toBe(false);
    expect(parsed.data.google.calendar.defaultCalendarId).toBe('primary');
    expect(parsed.data.google.gmail.enabled).toBe(false);
    expect(parsed.data.google.gmail.maxResults).toBe(10);
  });

  it('accepts a fully-populated google section', () => {
    const parsed = ConfigSchema.safeParse({
      ...minimalCfg(),
      filesystem: { allowedPaths: ['.'], readDenyGlobs: [] },
      google: {
        enabled: true,
        oauth: {
          clientId: 'fake-client-id.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-' + 'fakefakefake',
          tokenPath: './data/custom-tokens.json',
        },
        calendar: { enabled: true, defaultCalendarId: 'work@example.com' },
        gmail: { enabled: true, maxResults: 25 },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.google.enabled).toBe(true);
    expect(parsed.data.google.calendar.defaultCalendarId).toBe('work@example.com');
    expect(parsed.data.google.oauth.tokenPath).toBe('./data/custom-tokens.json');
    expect(parsed.data.google.gmail.enabled).toBe(true);
    expect(parsed.data.google.gmail.maxResults).toBe(25);
  });

  it('resolves ENV: refs in google.oauth.clientId / clientSecret', () => {
    writeCfg(
      {
        ...minimalCfg(),
        google: {
          enabled: true,
          oauth: {
            clientId: 'ENV:GOOGLE_OAUTH_CLIENT_ID',
            clientSecret: 'ENV:GOOGLE_OAUTH_CLIENT_SECRET',
          },
          calendar: { enabled: true },
        },
      },
      {
        GOOGLE_OAUTH_CLIENT_ID: 'env-resolved-client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'env-resolved-secret',
      },
    );
    const cfg = loadConfig();
    expect(cfg.google.oauth.clientId).toBe('env-resolved-client-id');
    expect(cfg.google.oauth.clientSecret).toBe('env-resolved-secret');
  });
});
