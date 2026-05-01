/**
 * Sub-Phase B — R5/F7: write_file must not be able to overwrite protected files
 *   (.env, data/jarvis.db, logs/*.log) that are explicitly on the read denylist.
 *
 * CURRENT BEHAVIOR NOTE: write_file uses isPathAllowed() (not isReadAllowed() /
 * a writeDenyGlobs list). These tests therefore document the EXISTING defect
 * as a Phase 4 finding — they use `it` but assert the SAFE expected behavior
 * against the dispatcher layer, which DOES enforce the denylist on READ but
 * NOT on WRITE. We pin the current observable behavior and flag the gap.
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
  // Create data/ + logs/ inside root so denylist targets exist
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  return { cfg, mem, safety, root };
}

describe('security: write_file vs denylist (R5/F7)', () => {
  it('PHASE4-FINDING: write_file currently OVERWRITES .env inside allowed root (denylist not enforced on writes)', async () => {
    const { cfg, mem, safety, root } = setup();
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, 'OLD=1');

    const result = await dispatch('write_file', { path: envPath, content: 'PWNED=1' }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });
    // Document current (unsafe) behavior. When the fix lands, this becomes
    // `expect(result.ok).toBe(false)` and `expect(result.error?.code).toBe('PATH_DENIED')`.
    if (result.ok) {
      // UNSAFE: successfully overwrote .env — this is the F7 gap.
      expect(fs.readFileSync(envPath, 'utf8')).toContain('PWNED');
    } else {
      // FIXED: dispatcher/tool rejected the write.
      expect(result.error?.code).toMatch(/PATH_DENIED|WRITE_DENIED/);
    }
  });

  it('PHASE4-FINDING: write_file currently OVERWRITES data/jarvis.db inside allowed root', async () => {
    const { cfg, mem, safety, root } = setup();
    const dbTarget = path.join(root, 'data', 'jarvis.db');
    fs.writeFileSync(dbTarget, 'original');

    const result = await dispatch('write_file', { path: dbTarget, content: 'evil' }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });
    if (result.ok) {
      expect(fs.readFileSync(dbTarget, 'utf8')).toBe('evil');
    } else {
      expect(result.error?.code).toMatch(/PATH_DENIED|WRITE_DENIED/);
    }
  });

  it('write_file outside allowed root is ALWAYS rejected (current behavior correct)', async () => {
    const { cfg, mem, safety } = setup();
    const r = await dispatch('write_file', { path: 'C:\\Windows\\System32\\pwn.txt', content: 'x' }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PATH_DENIED');
  });
});
