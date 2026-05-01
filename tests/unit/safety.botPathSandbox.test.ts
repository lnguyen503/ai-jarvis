/**
 * Unit tests — src/safety/botPathSandbox.ts
 *
 * ADR 021 D4 + CP1 R6: per-bot path-sandbox narrowing.
 *
 * Tests wrapPathForBotIdentity and checkBotDataPath.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { BotIdentity } from '../../src/config/botIdentity.js';
import {
  wrapPathForBotIdentity,
  checkBotDataPath,
} from '../../src/safety/botPathSandbox.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeIdentity(name: 'ai-jarvis' | 'ai-tony'): BotIdentity {
  return {
    name,
    scope: name === 'ai-jarvis' ? 'full' : 'specialist',
    telegramToken: 'test-token',
    personaPath: path.join(tmpDir, 'config', 'personas', `${name}.md`),
    dataDir: path.join(tmpDir, 'data', name),
    webappPort: name === 'ai-jarvis' ? 7879 : 7889,
    healthPort: name === 'ai-jarvis' ? 7878 : 7888,
    allowedTools: new Set(),
    aliases: [],
  additionalReadPaths: [],
  };
}

// ---------------------------------------------------------------------------
// wrapPathForBotIdentity
// ---------------------------------------------------------------------------

describe('wrapPathForBotIdentity', () => {
  it('replaces build-dir root with bot data dir', () => {
    const tony = makeIdentity('ai-tony');
    const wrapped = wrapPathForBotIdentity(tony, [tmpDir]);
    expect(wrapped).toContain(tony.dataDir);
    expect(wrapped).not.toContain(tmpDir.toLowerCase());
  });

  it('replaces unscoped data/ dir with bot data dir', () => {
    const tony = makeIdentity('ai-tony');
    const unscopedData = path.join(tmpDir, 'data');
    const wrapped = wrapPathForBotIdentity(tony, [unscopedData]);
    expect(wrapped).toContain(tony.dataDir);
    expect(wrapped).not.toContain(unscopedData);
  });

  it('keeps external project paths unchanged', () => {
    const tony = makeIdentity('ai-tony');
    const externalProject = path.join(os.tmpdir(), 'my-project');
    const wrapped = wrapPathForBotIdentity(tony, [tmpDir, externalProject]);
    expect(wrapped).toContain(externalProject);
    expect(wrapped).toContain(tony.dataDir);
  });

  it('deduplicates when both build-root and data/ are in allowedPaths', () => {
    const tony = makeIdentity('ai-tony');
    const unscopedData = path.join(tmpDir, 'data');
    const wrapped = wrapPathForBotIdentity(tony, [tmpDir, unscopedData]);
    // Should appear only once
    const occurrences = wrapped.filter((p) =>
      p.toLowerCase() === tony.dataDir.toLowerCase()
    ).length;
    expect(occurrences).toBe(1);
  });

  it('is idempotent (calling twice returns same result)', () => {
    const tony = makeIdentity('ai-tony');
    const first = wrapPathForBotIdentity(tony, [tmpDir]);
    const second = wrapPathForBotIdentity(tony, first);
    expect(second).toEqual(first);
  });

  it('ai-tony data dir does not contain ai-jarvis path', () => {
    const tony = makeIdentity('ai-tony');
    const jarvis = makeIdentity('ai-jarvis');
    const wrapped = wrapPathForBotIdentity(tony, [tmpDir]);
    expect(wrapped.some((p) => p.toLowerCase().includes('ai-jarvis'))).toBe(false);
    // jarvis dataDir is NOT in tony's wrapped paths
    expect(wrapped).not.toContain(jarvis.dataDir);
  });

  it('does not mutate the input array', () => {
    const tony = makeIdentity('ai-tony');
    const original = [tmpDir, path.join(tmpDir, 'data')];
    const snapshot = [...original];
    wrapPathForBotIdentity(tony, original);
    expect(original).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// checkBotDataPath
// ---------------------------------------------------------------------------

describe('checkBotDataPath', () => {
  it('accepts valid path inside bot data dir (absolute)', () => {
    const tony = makeIdentity('ai-tony');
    const validPath = path.join(tony.dataDir, 'organize', '12345', 'item.md');
    const result = checkBotDataPath(tony, validPath);
    expect(result.ok).toBe(true);
  });

  it('accepts bot data dir itself', () => {
    const tony = makeIdentity('ai-tony');
    const result = checkBotDataPath(tony, tony.dataDir);
    expect(result.ok).toBe(true);
  });

  it('rejects path outside bot data dir (sibling bot)', () => {
    const tony = makeIdentity('ai-tony');
    const jarvis = makeIdentity('ai-jarvis');
    const jarvisPath = path.join(jarvis.dataDir, 'organize', 'secret.md');
    const result = checkBotDataPath(tony, jarvisPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ABSOLUTE_OUTSIDE_DATADIR');
    }
  });

  it('rejects /etc/ path', () => {
    const tony = makeIdentity('ai-tony');
    const result = checkBotDataPath(tony, '/etc/passwd');
    expect(result.ok).toBe(false);
  });

  it('rejects ../ traversal', () => {
    const tony = makeIdentity('ai-tony');
    const result = checkBotDataPath(tony, '../ai-jarvis/jarvis.db');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TRAVERSAL_REJECTED');
    }
  });

  it('rejects empty path', () => {
    const tony = makeIdentity('ai-tony');
    const result = checkBotDataPath(tony, '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('EMPTY_PATH');
    }
  });

  it('rejects whitespace-only path', () => {
    const tony = makeIdentity('ai-tony');
    const result = checkBotDataPath(tony, '   ');
    expect(result.ok).toBe(false);
  });

  it('returns sanitized absolute path on success', () => {
    const tony = makeIdentity('ai-tony');
    const relativePath = 'organize/12345/item.md';
    const result = checkBotDataPath(tony, relativePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(path.isAbsolute(result.sanitized)).toBe(true);
      expect(result.sanitized.toLowerCase().startsWith(tony.dataDir.toLowerCase())).toBe(true);
    }
  });

  it('ai-jarvis can access its own data dir', () => {
    const jarvis = makeIdentity('ai-jarvis');
    const validPath = path.join(jarvis.dataDir, 'jarvis.db');
    const result = checkBotDataPath(jarvis, validPath);
    expect(result.ok).toBe(true);
  });

  it('ai-jarvis cannot access ai-tony data dir via this helper', () => {
    const jarvis = makeIdentity('ai-jarvis');
    const tony = makeIdentity('ai-tony');
    const tonyPath = path.join(tony.dataDir, 'organize', 'something.md');
    const result = checkBotDataPath(jarvis, tonyPath);
    expect(result.ok).toBe(false);
  });
});
