import { describe, it, expect } from 'vitest';
import systemInfoTool from '../../src/tools/system_info.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import path from 'path';

describe('tools.system_info', () => {
  it('returns system information', async () => {
    _resetDb();
    const cfg = makeTestConfig();
    const root = cfg.filesystem.allowedPaths[0]!;
    cfg.memory.dbPath = path.join(root, 'test.db');
    const mem = initMemory(cfg);
    const safety = initSafety(cfg, mem);

    const result = await systemInfoTool.execute(
      { verbose: false },
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
    expect(result.output).toContain('System Info');
    expect(result.output).toContain('Memory');
    expect(result.output).toContain('CPU');
    expect(result.data).toBeDefined();
    expect(typeof result.data?.cpuCount).toBe('number');
  });
});
