/**
 * F-01 Regression: write_file must refuse to overwrite .env, data/*, logs/* files.
 * These tests will FAIL on a build where the write denylist is not enforced,
 * and PASS once the fix (isWriteAllowed) is in place.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { registerTools, dispatch } from '../../src/tools/index.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  const root = cfg.filesystem.allowedPaths[0]!;
  cfg.memory.dbPath = path.join(root, 'test-meta.db');
  // Create the sub-directories that denylist patterns target
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  return { root, mem, safety };
}

afterAll(() => {
  if (cfg) cleanupTmpRoot(cfg);
});

describe('F-01 regression: write_file denylist enforcement', () => {
  it('refuses to overwrite .env inside allowed root', async () => {
    const { root, mem, safety } = setup();
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, 'REAL_SECRET=hunter2');

    const result = await dispatch('write_file', { path: envPath, content: 'PWNED=1' }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
    // The real .env must not have been modified
    expect(fs.readFileSync(envPath, 'utf8')).toBe('REAL_SECRET=hunter2');
  });

  it('refuses to overwrite data/jarvis.db inside allowed root', async () => {
    const { root, mem, safety } = setup();
    const dbPath = path.join(root, 'data', 'jarvis.db');
    fs.writeFileSync(dbPath, 'original-db-content');

    const result = await dispatch('write_file', { path: dbPath, content: 'evil' }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('original-db-content');
  });

  it('refuses to overwrite logs/jarvis.log inside allowed root', async () => {
    const { root, mem, safety } = setup();
    const logPath = path.join(root, 'logs', 'jarvis.log');
    fs.writeFileSync(logPath, 'real-log-content');

    const result = await dispatch('write_file', { path: logPath, content: 'evil' }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
    expect(fs.readFileSync(logPath, 'utf8')).toBe('real-log-content');
  });

  it('still allows writing regular files inside allowed root', async () => {
    const { root, mem, safety } = setup();
    const filePath = path.join(root, 'output', 'result.txt');

    const result = await dispatch('write_file', { path: filePath, content: 'hello world', createDirs: true }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world');
  });
});
