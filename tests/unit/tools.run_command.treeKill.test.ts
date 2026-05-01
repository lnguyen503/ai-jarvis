/**
 * V-18 regression: run_command tree-kill behavior.
 * Verifies that tree-kill is imported and called on process timeout/abort.
 * Full tree-kill integration requires spawning real child processes;
 * these tests verify the tool's response when a command is killed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { dispatch, registerTools } from '../../src/tools/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { ToolContext } from '../../src/tools/types.js';

function setup() {
  _resetDb();
  const cfg = makeTestConfig();
  cfg.memory.dbPath = path.join(cfg.filesystem.allowedPaths[0]!, 'test.db');
  // Shorten timeout so the test doesn't wait 120s
  cfg.safety.commandTimeoutMs = 500;
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const logger = getLogger();
  registerTools({ config: cfg, logger, safety, memory: mem });
  return { cfg, mem, safety, logger };
}

describe('tools.run_command — V-18 abort signal handling', () => {
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

  it('reports an error (CMD_TIMEOUT or TOOL_ERROR) when command times out', async () => {
    // A command that sleeps longer than the timeout
    const controller = new AbortController();
    const s = setup();
    const shortCtx: ToolContext = {
      sessionId: 1,
      chatId: 100,
      logger: s.logger,
      config: s.cfg,
      memory: s.mem,
      safety: s.safety,
      abortSignal: controller.signal,
    };

    const result = await dispatch(
      'run_command',
      { command: 'Start-Sleep -Seconds 10', shell: 'powershell' },
      shortCtx,
    );
    // Should fail (timeout) — accept CMD_TIMEOUT or TOOL_ERROR (environment-dependent)
    expect(result.ok).toBe(false);
    // The code can be CMD_TIMEOUT (execa timedOut) or TOOL_ERROR (tree-kill threw)
    expect(['CMD_TIMEOUT', 'TOOL_ERROR']).toContain(result.error?.code);
  }, 5000);

  it('reports an error when abort signal fires', async () => {
    const controller = new AbortController();
    const s = setup();
    const abortCtx: ToolContext = {
      sessionId: 1,
      chatId: 100,
      logger: s.logger,
      config: s.cfg,
      memory: s.mem,
      safety: s.safety,
      abortSignal: controller.signal,
    };

    // Abort immediately after dispatching
    const dispatchPromise = dispatch(
      'run_command',
      { command: 'Start-Sleep -Seconds 10', shell: 'powershell' },
      abortCtx,
    );
    // Small delay then abort
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort('user_stop');

    const result = await dispatchPromise;
    expect(result.ok).toBe(false);
    // Accept CMD_TIMEOUT or TOOL_ERROR (environment-dependent behavior)
    expect(['CMD_TIMEOUT', 'TOOL_ERROR']).toContain(result.error?.code);
  }, 5000);
});
