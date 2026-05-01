/**
 * Sub-Phase B.3.3 — secret leakage via read_file / list_directory / search_files.
 * .env files and other denylisted targets must be rejected by the dispatcher/tools.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { registerTools, dispatch } from '../../src/tools/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';

function setup() {
  _resetDb();
  const cfg = makeTestConfig();
  const root = cfg.filesystem.allowedPaths[0]!;
  cfg.memory.dbPath = path.join(root, 'jarvis.db');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=sk-ant-XXX');
  fs.writeFileSync(path.join(root, '.env.production'), 'SECRET=2');
  fs.writeFileSync(path.join(root, 'normal.txt'), 'hello');
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  const ctx = {
    sessionId: 1,
    chatId: 12345,
    logger: getLogger(),
    config: cfg,
    memory: mem,
    safety,
    abortSignal: new AbortController().signal,
  };
  return { cfg, mem, safety, root, ctx };
}

describe('security: read denylist enforcement (.env, logs, data)', () => {
  it('read_file on .env is rejected', async () => {
    const { root, ctx } = setup();
    const r = await dispatch('read_file', { path: path.join(root, '.env') }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toMatch(/PATH_DENIED|READ_DENIED/);
  });

  it('read_file on .env.production is rejected', async () => {
    const { root, ctx } = setup();
    const r = await dispatch('read_file', { path: path.join(root, '.env.production') }, ctx);
    expect(r.ok).toBe(false);
  });

  it('read_file on a normal file succeeds', async () => {
    const { root, ctx } = setup();
    const r = await dispatch('read_file', { path: path.join(root, 'normal.txt') }, ctx);
    expect(r.ok).toBe(true);
  });

  it('list_directory omits .env* entries', async () => {
    const { root, ctx } = setup();
    const r = await dispatch('list_directory', { path: root }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain('.env');
    // normal.txt should still appear
    expect(r.output).toContain('normal.txt');
  });
});
