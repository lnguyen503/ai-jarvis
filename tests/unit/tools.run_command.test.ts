import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import runCommandTool from '../../src/tools/run_command.js';
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
  // Seed a session so commandLog inserts succeed
  mem.sessions.getOrCreate(12345);
  return { cfg, mem, safety, root };
}

describe('tools.run_command', () => {
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

  // Classification (hardReject + destructive gating) was removed from run_command.execute()
  // in CP2 fix (Finding 3 HIGH). The agent/index.ts is now the single authoritative gate.
  // Safety gating for run_command is covered in tests/unit/agent.safety.test.ts.

  it('does NOT self-classify — tool attempts to run and fails at OS level for invalid commands', async () => {
    // Confirms the tool no longer short-circuits on hard-reject patterns.
    // The agent gate prevents this from ever reaching execute() in production.
    const result = await runCommandTool.execute(
      {
        shell: 'none',
        command: 'nonexistent-binary-xyzzy',
        args: [],
      },
      {
        sessionId: 1,
        chatId: 12345,
        logger: getLogger(),
        config: cfg,
        memory: mem,
        safety,
        abortSignal: new AbortController().signal,
      },
    );
    // Tool tried to execute — failed at OS level, not at classification
    expect(result.error?.code).not.toBe('CMD_HARD_REJECTED');
    expect(result.error?.code).not.toBe('CMD_REQUIRES_CONFIRMATION');
  });

  it('logs executed commands to command_log', async () => {
    const before = mem.commandLog.listRecent(50).length;
    // Run a safe no-op via shell=none to avoid OS-specific shell issues
    // 'node' may or may not be in PATH for the test; fall back to a shape test
    // by checking that commands that fail still get logged.
    await runCommandTool.execute(
      {
        shell: 'none',
        command: 'nonexistent-command-xyzzy-12345',
        args: [],
      },
      {
        sessionId: 1,
        chatId: 12345,
        logger: getLogger(),
        config: cfg,
        memory: mem,
        safety,
        abortSignal: new AbortController().signal,
      },
    );
    const after = mem.commandLog.listRecent(50).length;
    expect(after).toBeGreaterThan(before);
  });

  it('captures stdout from a simple command (regression: execa v9 uses cancelSignal, not signal)', async () => {
    // Pick an invocation that works cross-platform: `node -e "process.stdout.write('hello')"`
    // Uses shell=none so we avoid platform shell differences. If `node` isn't in PATH,
    // this test would need to be skipped — but in practice node is always present.
    const result = await runCommandTool.execute(
      {
        shell: 'none',
        command: process.execPath,
        args: ['-e', "process.stdout.write('hello-stdout-marker')"],
      },
      {
        sessionId: 1,
        chatId: 12345,
        logger: getLogger(),
        config: cfg,
        memory: mem,
        safety,
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello-stdout-marker');
    // Must appear under the 'stdout:' section, proving stdout (not stderr) was captured
    expect(result.output).toMatch(/stdout:[\s\S]*hello-stdout-marker/);
  });
});
