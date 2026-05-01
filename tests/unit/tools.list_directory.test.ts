import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import listDirectoryTool from '../../src/tools/list_directory.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';

function setup() {
  _resetDb();
  const cfg = makeTestConfig();
  const root = cfg.filesystem.allowedPaths[0]!;
  cfg.memory.dbPath = path.join(root, 'test.db');
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  return { cfg, mem, safety, root };
}

describe('tools.list_directory', () => {
  let cfg: AppConfig;
  let safety: ReturnType<typeof initSafety>;
  let mem: MemoryApi;
  let root: string;

  beforeEach(() => {
    const s = setup();
    cfg = s.cfg;
    safety = s.safety;
    mem = s.mem;
    root = s.root;

    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'b.ts'), 'b');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('lists directory contents', async () => {
    const result = await listDirectoryTool.execute(
      { path: root, recursive: false, maxDepth: 3, showHidden: false },
      {
        sessionId: 1,
        chatId: 1,
        logger: getLogger(),
        config: cfg,
        memory: mem,
        safety,
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.txt');
    expect(result.output).toContain('b.ts');
    expect(result.output).toContain('sub/');
  });

  it('filters denied entries (.env)', async () => {
    const result = await listDirectoryTool.execute(
      { path: root, recursive: false, maxDepth: 3, showHidden: true },
      {
        sessionId: 1,
        chatId: 1,
        logger: getLogger(),
        config: cfg,
        memory: mem,
        safety,
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.ok).toBe(true);
    // showHidden=true would include .env, but denylist filters it out
    expect(result.output).not.toContain('.env');
  });

  it('rejects directories outside the allowed root', async () => {
    const result = await listDirectoryTool.execute(
      { path: 'C:\\Windows\\System32', recursive: false, maxDepth: 3, showHidden: false },
      {
        sessionId: 1,
        chatId: 1,
        logger: getLogger(),
        config: cfg,
        memory: mem,
        safety,
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
  });
});
