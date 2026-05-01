/**
 * V-01 regression: dispatch() must enforce ctx.allowedToolNames.
 * A disabled tool name must be rejected even if the model emits it.
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

describe('tools.dispatch — V-01 active-tools enforcement', () => {
  let mem: MemoryApi;
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
    mem = s.mem;
  });

  it('allows a tool that IS in allowedToolNames', async () => {
    // system_info doesn't need filesystem access and is safe in tests
    ctx.allowedToolNames = new Set(['system_info', 'read_file', 'write_file', 'run_command']);
    const result = await dispatch('system_info', {}, ctx);
    // system_info should succeed (ok:true) regardless of OS details
    expect(result.ok).toBe(true);
  });

  it('rejects a tool NOT in allowedToolNames with UNAUTHORIZED_IN_CONTEXT', async () => {
    // In group mode, run_command is disabled. Simulate that by not including it in allowedToolNames.
    ctx.allowedToolNames = new Set(['read_file', 'list_directory', 'search_files']);
    const result = await dispatch('run_command', { command: 'dir', shell: 'powershell' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
  });

  it('rejects write_file if not in allowedToolNames', async () => {
    ctx.allowedToolNames = new Set(['read_file', 'list_directory']);
    const result = await dispatch(
      'write_file',
      { path: '/some/path', content: 'data', createDirs: true, append: false },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED_IN_CONTEXT');
  });

  it('allows all tools when allowedToolNames is undefined (DM path)', async () => {
    // When allowedToolNames is undefined, dispatch falls back to registered set
    ctx.allowedToolNames = undefined;
    const result = await dispatch('system_info', {}, ctx);
    expect(result.ok).toBe(true);
  });

  it('rejects unknown tool name regardless of allowedToolNames', async () => {
    ctx.allowedToolNames = new Set(['run_command', 'read_file']);
    const result = await dispatch('fake_tool_xyz', {}, ctx);
    expect(result.ok).toBe(false);
    // Either UNAUTHORIZED_IN_CONTEXT (not in allowedToolNames) or UNKNOWN_TOOL
    expect(['UNAUTHORIZED_IN_CONTEXT', 'UNKNOWN_TOOL']).toContain(result.error?.code);
  });
});
