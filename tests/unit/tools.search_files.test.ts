import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import searchFilesTool from '../../src/tools/search_files.js';
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

describe('tools.search_files', () => {
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

    fs.writeFileSync(path.join(root, 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'b.ts'), '');
    fs.writeFileSync(path.join(root, 'c.js'), '');
    fs.writeFileSync(path.join(root, '.env'), '');
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('finds files matching a pattern', async () => {
    const result = await searchFilesTool.execute(
      { directory: root, pattern: '*.ts', maxResults: 50, includeContents: false },
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
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
    expect(result.output).not.toContain('c.js');
  });

  it('excludes denied files (.env) from results', async () => {
    const result = await searchFilesTool.execute(
      { directory: root, pattern: '.env', maxResults: 50, includeContents: false },
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
    expect(result.output).not.toContain(path.join(root, '.env'));
  });

  it('rejects directories outside the allowed root', async () => {
    const result = await searchFilesTool.execute(
      {
        directory: 'C:\\Windows\\System32',
        pattern: '*.exe',
        maxResults: 50,
        includeContents: false,
      },
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
