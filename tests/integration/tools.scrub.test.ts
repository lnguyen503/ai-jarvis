/**
 * §15.5 — Integration: dispatcher applies scrubber before persist AND return.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { registerTools, dispatch } from '../../src/tools/index.js';
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
  mem.sessions.getOrCreate(12345);
  registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  return { cfg, mem, safety, root };
}

describe('tools dispatch — scrubber integration (§15.5)', () => {
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

  it('read_file output returned to caller is scrubbed', async () => {
    const p = path.join(root, 'secrets.txt');
    fs.writeFileSync(p, 'key=sk-ant-abcdefghijklmnopqrstuvwxyz1234567890');

    const result = await dispatch(
      'read_file',
      { path: p, encoding: 'utf8' },
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
    expect(result.output).toContain('[REDACTED:ANTHROPIC_KEY]');
    expect(result.output).not.toContain('sk-ant-abcdefghijklm');
  });

  it('output is truncated to maxOutputLength', async () => {
    const p = path.join(root, 'big.txt');
    fs.writeFileSync(p, 'x'.repeat(10000));

    const result = await dispatch(
      'read_file',
      { path: p, encoding: 'utf8' },
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
    // D19 (v1.18.0): read_file is an external-content tool; dispatcher wraps output in
    // <untrusted> tags which adds ~200 chars overhead beyond maxOutputLength.
    expect(result.output.length).toBeLessThanOrEqual(cfg.safety.maxOutputLength + 400);
  });

  it('unknown tool returns UNKNOWN_TOOL error', async () => {
    const result = await dispatch(
      'web_fetch',
      { url: 'http://evil' },
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

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('invalid input returns INVALID_INPUT error', async () => {
    const result = await dispatch(
      'read_file',
      { wrongField: 'x' },
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

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});
