/**
 * V-09 regression: run_command must validate cwd against isPathAllowed().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { dispatch, registerTools } from '../../src/tools/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { ToolContext } from '../../src/tools/types.js';

function setup() {
  _resetDb();
  const cfg = makeTestConfig();
  cfg.memory.dbPath = path.join(cfg.filesystem.allowedPaths[0]!, 'test.db');
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const logger = getLogger();
  registerTools({ config: cfg, logger, safety, memory: mem });
  return { cfg, mem, safety, logger };
}

describe('tools.run_command — V-09 cwd sandbox', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    const s = setup();
    const controller = new AbortController();
    ctx = {
      sessionId: 1,
      chatId: 100,
      logger: s.logger,
      config: s.cfg,
      memory: s.mem,
      safety: s.safety,
      abortSignal: controller.signal,
    };
  });

  it('rejects run_command with cwd outside allowed paths', async () => {
    // C:\Users\Administrator\.ssh is NOT in allowedPaths
    const result = await dispatch(
      'run_command',
      { command: 'dir', shell: 'cmd', cwd: 'C:\\Users\\Administrator\\.ssh' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
  });

  it('rejects run_command with cwd pointing to C:\\Windows', async () => {
    const result = await dispatch(
      'run_command',
      { command: 'dir', shell: 'cmd', cwd: 'C:\\Windows\\System32' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
  });

  it('allows run_command with cwd inside allowed path', async () => {
    const allowedRoot = ctx.config.filesystem.allowedPaths[0]!;
    // Allow cwd = the allowed root itself
    const result = await dispatch(
      'run_command',
      { command: 'echo hello', shell: 'powershell', cwd: allowedRoot },
      ctx,
    );
    // May succeed or fail based on shell availability, but NOT due to PATH_DENIED
    expect(result.error?.code).not.toBe('PATH_DENIED');
  });

  it('allows run_command with no cwd specified (defaults to process.cwd())', async () => {
    const result = await dispatch(
      'run_command',
      { command: 'echo hello', shell: 'powershell' },
      ctx,
    );
    // Should not be rejected for cwd reasons
    expect(result.error?.code).not.toBe('PATH_DENIED');
  });
});
