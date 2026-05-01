/**
 * F-03: Loading config with ENV: references for missing vars must throw with a
 * human-readable message naming the missing variable (not a raw zod stack trace).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, _resetConfig } from '../../src/config/index.js';

afterEach(() => {
  _resetConfig();
  delete process.env['CONFIG_PATH'];
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['TELEGRAM_BOT_TOKEN'];
  delete process.env['TEST_MISSING_VAR'];
});

function writeCfgWithEnvRef(allowedPath: string, config: Record<string, unknown>): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-envtest-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  process.env['CONFIG_PATH'] = file;
}

function baseCfg(allowedPath: string, botToken: string) {
  return {
    telegram: { allowedUserIds: [123], botToken },
    ai: { provider: 'anthropic', model: 'claude-sonnet-4-6-20250514', maxTokens: 4096, temperature: 0.3 },
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
    filesystem: { allowedPaths: [allowedPath], readDenyGlobs: [] },
    web: { enabled: false, allowedHosts: [] },
    memory: { dbPath: './data/jarvis.db', maxHistoryMessages: 50 },
    projects: [],
  };
}

describe('F-03: env-var fatal error messages', () => {
  it('throws a clear error naming the missing var when TELEGRAM_BOT_TOKEN is unset', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    // Use ENV: ref for bot token so loadConfig resolveEnvRefs triggers the error
    writeCfgWithEnvRef(allowed, baseCfg(allowed, 'ENV:TEST_MISSING_VAR'));
    // Ensure the var is NOT set
    delete process.env['TEST_MISSING_VAR'];

    let error: Error | null = null;
    try {
      loadConfig();
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    // Error message must name the missing variable — not a raw zod issue list
    expect(error!.message).toMatch(/TEST_MISSING_VAR/);
    // Must give operator guidance
    expect(error!.message).toMatch(/not set|\.env/i);
  });

  it('throws a clear error when ANTHROPIC_API_KEY is referenced but missing', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    const cfg = baseCfg(allowed, 'static-token-for-this-test');
    // Embed an ENV: reference in a nested field to simulate missing API key
    (cfg as Record<string, unknown>)['ai'] = {
      provider: 'anthropic',
      model: 'ENV:ANTHROPIC_API_KEY',  // using model to carry the ENV ref for this test
      maxTokens: 4096,
      temperature: 0.3,
    };
    delete process.env['ANTHROPIC_API_KEY'];
    writeCfgWithEnvRef(allowed, cfg);

    let error: Error | null = null;
    try {
      loadConfig();
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('succeeds when all ENV: references resolve correctly', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    process.env['TEST_MISSING_VAR'] = 'my-real-bot-token-for-test';
    writeCfgWithEnvRef(allowed, baseCfg(allowed, 'ENV:TEST_MISSING_VAR'));

    const loaded = loadConfig();
    expect(loaded.telegram.botToken).toBe('my-real-bot-token-for-test');
  });

  it('tolerates a UTF-8 BOM at the start of config.json (regression)', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    process.env['TEST_MISSING_VAR'] = 'long-enough-bot-token-for-test';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bomtest-'));
    const file = path.join(tmp, 'config.json');
    const body = JSON.stringify(baseCfg(allowed, 'ENV:TEST_MISSING_VAR'));
    // Prepend UTF-8 BOM (0xEF 0xBB 0xBF) — what Notepad/VS Code sometimes saves.
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]));
    process.env['CONFIG_PATH'] = file;

    const loaded = loadConfig();
    expect(loaded.telegram.botToken).toBe('long-enough-bot-token-for-test');
  });
});
