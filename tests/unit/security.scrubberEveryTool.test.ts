/**
 * Sub-Phase B.3.4 — Dispatcher scrubs secrets on every tool output.
 * Uses read_file + write_file to stage secret payloads and verifies:
 *   - result.output is scrubbed
 *   - false-positive guard: commit-style bare hex is NOT over-matched when
 *     surrounded by prose (R10 regression).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { registerTools, dispatch } from '../../src/tools/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';

function setup() {
  _resetDb();
  const cfg = makeTestConfig();
  const root = cfg.filesystem.allowedPaths[0]!;
  cfg.memory.dbPath = path.join(root, 'jarvis.db');
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  const ctx = {
    sessionId: 1,
    chatId: 12345,
    logger: getLogger(),
    config: cfg,
    memory: mem,
    safety,
    abortSignal: new AbortController().signal,
  };
  return { cfg, mem, safety, root, ctx };
}

async function readFileSecret(ctx: ReturnType<typeof setup>['ctx'], root: string, secret: string): Promise<string> {
  const p = path.join(root, `secret-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(p, secret);
  const r = await dispatch('read_file', { path: p }, ctx);
  expect(r.ok).toBe(true);
  return r.output;
}

describe('security: scrubber runs on every tool output', () => {
  it('scrubs sk-ant- keys', async () => {
    const { root, ctx } = setup();
    const out = await readFileSecret(ctx, root, 'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz1234567890');
    expect(out).toContain('[REDACTED:ANTHROPIC_KEY]');
    expect(out).not.toContain('sk-ant-api03-' + 'abcdefghi');
  });

  it('scrubs AWS access keys (AKIA...)', async () => {
    const { root, ctx } = setup();
    const out = await readFileSecret(ctx, root, 'AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:AWS_ACCESS_KEY]');
  });

  it('scrubs PEM private keys', async () => {
    const { root, ctx } = setup();
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdef',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = await readFileSecret(ctx, root, pem);
    expect(out).toContain('[REDACTED:PEM_PRIVATE_KEY]');
  });

  it('FALSE-POSITIVE GUARD (R10): bare 40-hex in prose is NOT replaced', async () => {
    const { root, ctx } = setup();
    const hash = 'a'.repeat(40);
    const text = `commit ${hash}\nAuthor: test\n`;
    const out = await readFileSecret(ctx, root, text);
    // The HEX_BLOB pattern now requires a secret-context keyword OR quotes.
    // Pure prose mentioning a git sha should NOT be redacted.
    expect(out).toContain(hash);
  });

  it('HEX_BLOB IS redacted when preceded by secret= keyword', async () => {
    const { root, ctx } = setup();
    const hash = 'b'.repeat(40);
    const text = `secret=${hash}`;
    const out = await readFileSecret(ctx, root, text);
    expect(out).toContain('[REDACTED:HEX_BLOB]');
  });

  it('write_file reflects scrubbed content in its own output summary', async () => {
    const { cfg, mem, safety, root } = setup();
    const target = path.join(root, 'out.txt');
    const r = await dispatch(
      'write_file',
      { path: target, content: 'key=sk-ant-abcdefghijklmnopqrstuvwxyz1234567890' },
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
    expect(r.ok).toBe(true);
    // write_file's own output summary does not echo content; simply assert no secret leaked
    expect(r.output).not.toContain('sk-ant-abcdefghi');
  });
});
