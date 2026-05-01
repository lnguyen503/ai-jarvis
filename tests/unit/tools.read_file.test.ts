import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import readFileTool from '../../src/tools/read_file.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';

function setup(): { cfg: AppConfig; mem: MemoryApi; safety: ReturnType<typeof initSafety>; root: string } {
  _resetDb();
  const cfg = makeTestConfig();
  const root = cfg.filesystem.allowedPaths[0]!;
  // Use a sibling dbPath under the allowed root so it exists
  cfg.memory.dbPath = path.join(root, 'test.db');
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  return { cfg, mem, safety, root };
}

describe('tools.read_file', () => {
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

  it('reads a file inside the allowed root', async () => {
    const filePath = path.join(root, 'hello.txt');
    fs.writeFileSync(filePath, 'hello world');

    const result = await readFileTool.execute(
      { path: filePath, encoding: 'utf8' },
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
    expect(result.output).toContain('hello world');
  });

  it('rejects a path outside the allowed root', async () => {
    const result = await readFileTool.execute(
      { path: 'C:\\Windows\\System32\\cmd.exe', encoding: 'utf8' },
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

  it('rejects .env even when under allowed root', async () => {
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, 'SECRET=abc123');

    const result = await readFileTool.execute(
      { path: envPath, encoding: 'utf8' },
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

  it('scrubs secrets in returned file content', async () => {
    const p = path.join(root, 'secrets.txt');
    fs.writeFileSync(p, 'My key is sk-ant-abcdefghijklmnopqrstuvwxyz1234567890');

    const result = await readFileTool.execute(
      { path: p, encoding: 'utf8' },
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
    expect(result.output).toContain('[REDACTED:ANTHROPIC_KEY]');
    expect(result.output).not.toContain('sk-ant-abcdefghijklmnop');
  });
});
