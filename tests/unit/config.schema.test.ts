/**
 * Config schema tests — health.port bounds, readDenyGlobs defaults, allowedPaths boot-fail.
 * §14 invariants (Phase 2 zod schema).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, _resetConfig } from '../../src/config/index.js';
import { ConfigSchema, BUILT_IN_READ_DENY_GLOBS } from '../../src/config/schema.js';

function writeCfg(content: unknown, extraEnv: Record<string, string> = {}): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cfg-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, JSON.stringify(content));
  process.env['CONFIG_PATH'] = file;
  for (const [k, v] of Object.entries(extraEnv)) {
    process.env[k] = v;
  }
  return tmp;
}

function baseConfig(allowedPath: string) {
  return {
    telegram: { allowedUserIds: [123], botToken: 'test-token-12345' },
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

describe('config loader', () => {
  afterEach(() => {
    _resetConfig();
    delete process.env['CONFIG_PATH'];
  });

  it('fails when allowedPaths entry does not exist (§15.1 boot-fail)', () => {
    const fakePath = path.join(os.tmpdir(), `jarvis-nope-${Date.now()}`);
    expect(fs.existsSync(fakePath)).toBe(false);
    writeCfg(baseConfig(fakePath));
    expect(() => loadConfig()).toThrow();
  });

  it('fails when health.port is below 1024', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    const cfg = baseConfig(allowed);
    cfg.health.port = 80;
    writeCfg(cfg);
    expect(() => loadConfig()).toThrow();
  });

  it('fails when web.enabled=true but allowedHosts empty', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    const cfg = baseConfig(allowed);
    cfg.web = { enabled: true, allowedHosts: [] };
    writeCfg(cfg);
    expect(() => loadConfig()).toThrow();
  });

  it('merges built-in readDenyGlobs into user-provided list', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    const cfg = baseConfig(allowed);
    cfg.filesystem.readDenyGlobs = ['*.secret'];
    writeCfg(cfg);
    const loaded = loadConfig();
    for (const g of BUILT_IN_READ_DENY_GLOBS) {
      expect(loaded.filesystem.readDenyGlobs).toContain(g);
    }
    expect(loaded.filesystem.readDenyGlobs).toContain('*.secret');
  });

  it('loads a valid config successfully', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-allowed-'));
    writeCfg(baseConfig(allowed));
    const loaded = loadConfig();
    expect(loaded.telegram.botToken).toBe('test-token-12345');
    expect(loaded.health.port).toBe(7878);
  });
});

describe('ConfigSchema (zod)', () => {
  it('rejects missing required fields', () => {
    const r = ConfigSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects empty allowedUserIds', () => {
    const r = ConfigSchema.safeParse({
      telegram: { allowedUserIds: [], botToken: 'x'.repeat(20) },
      ai: { provider: 'anthropic', model: 'x' },
      whisper: {},
      health: {},
      chat: {},
      safety: {},
      filesystem: { allowedPaths: ['D:\\x'] },
      web: {},
      memory: {},
      projects: [],
    });
    expect(r.success).toBe(false);
  });

  it('applies default for maxToolIterations', () => {
    const r = ConfigSchema.safeParse({
      telegram: { allowedUserIds: [1], botToken: 'x'.repeat(20) },
      ai: { provider: 'anthropic', model: 'claude', maxTokens: 4096, temperature: 0.3 },
      whisper: {},
      health: {},
      chat: {},
      safety: {},
      filesystem: { allowedPaths: ['D:\\x'] },
      web: {},
      memory: {},
    });
    if (r.success) {
      expect(r.data.ai.maxToolIterations).toBe(10);
    } else {
      // should succeed
      expect.fail(`parse failed: ${JSON.stringify(r.error.issues)}`);
    }
  });
});
