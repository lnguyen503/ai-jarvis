import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import writeFileTool from '../../src/tools/write_file.js';
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

describe('tools.write_file', () => {
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
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('writes a file inside the allowed root', async () => {
    const p = path.join(root, 'new-file.txt');
    const result = await writeFileTool.execute(
      { path: p, content: 'hello', createDirs: true, append: false },
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
    expect(fs.readFileSync(p, 'utf8')).toBe('hello');
  });

  it('rejects writes outside the allowed root', async () => {
    const result = await writeFileTool.execute(
      {
        path: 'C:\\Windows\\Temp\\jarvis-evil.txt',
        content: 'pwn',
        createDirs: true,
        append: false,
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

  it('creates parent directories when createDirs=true', async () => {
    const p = path.join(root, 'deep', 'nested', 'file.txt');
    const result = await writeFileTool.execute(
      { path: p, content: 'x', createDirs: true, append: false },
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
    expect(fs.existsSync(p)).toBe(true);
  });

  it('appends when append=true', async () => {
    const p = path.join(root, 'appendable.txt');
    fs.writeFileSync(p, 'first\n');
    await writeFileTool.execute(
      { path: p, content: 'second', createDirs: true, append: true },
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
    expect(fs.readFileSync(p, 'utf8')).toBe('first\nsecond');
  });
});
