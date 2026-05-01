/**
 * v1.7.5 per-chat workspace isolation tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  workspacePathForChat,
  ensureWorkspace,
  effectiveAllowedPaths,
} from '../../src/safety/workspaces.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

const TMP_ROOT = path.join(os.tmpdir(), `jarvis-ws-test-${process.pid}`);

function cfgWithTmpRoot() {
  const cfg = makeTestConfig();
  cfg.workspaces = { enabled: true, root: TMP_ROOT };
  return cfg;
}

afterEach(() => {
  if (fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe('workspaces.workspacePathForChat', () => {
  it('maps positive chatId (DM) to users/{id}', () => {
    const cfg = cfgWithTmpRoot();
    const p = workspacePathForChat(42, cfg);
    expect(path.basename(path.dirname(p!))).toBe('users');
    expect(path.basename(p!)).toBe('42');
  });

  it('maps negative chatId (group) to groups/{abs(id)}', () => {
    const cfg = cfgWithTmpRoot();
    const p = workspacePathForChat(-100, cfg);
    expect(path.basename(path.dirname(p!))).toBe('groups');
    expect(path.basename(p!)).toBe('100');
  });

  it('returns null when workspaces disabled', () => {
    const cfg = cfgWithTmpRoot();
    cfg.workspaces.enabled = false;
    expect(workspacePathForChat(-100, cfg)).toBeNull();
  });
});

describe('workspaces.ensureWorkspace', () => {
  it('creates the directory + README on first call', () => {
    const cfg = cfgWithTmpRoot();
    const dir = ensureWorkspace(-100, cfg);
    expect(dir).not.toBeNull();
    expect(fs.existsSync(dir!)).toBe(true);
    expect(fs.existsSync(path.join(dir!, 'README.md'))).toBe(true);
  });

  it('is idempotent on second call', () => {
    const cfg = cfgWithTmpRoot();
    const a = ensureWorkspace(-100, cfg);
    const b = ensureWorkspace(-100, cfg);
    expect(a).toBe(b);
  });
});

describe('workspaces.effectiveAllowedPaths', () => {
  it('admin keeps full base allowlist plus their workspace', () => {
    const cfg = cfgWithTmpRoot();
    const base = ['D:\\ai-jarvis', 'D:\\projects'];
    const paths = effectiveAllowedPaths(base, 42, 'admin', cfg);
    expect(paths.length).toBe(3);
    expect(paths).toContain('D:\\ai-jarvis');
    expect(paths).toContain('D:\\projects');
    expect(paths.some((p) => p.includes(path.join('users', '42')))).toBe(true);
  });

  it('developer in group sees ONLY that group workspace', () => {
    const cfg = cfgWithTmpRoot();
    const base = ['D:\\ai-jarvis', 'D:\\projects'];
    const paths = effectiveAllowedPaths(base, -500, 'developer', cfg);
    expect(paths.length).toBe(1);
    expect(paths[0]).toContain(path.join('groups', '500'));
    expect(paths).not.toContain('D:\\ai-jarvis');
    expect(paths).not.toContain('D:\\projects');
  });

  it('member in group sees ONLY that group workspace', () => {
    const cfg = cfgWithTmpRoot();
    const base = ['D:\\ai-jarvis'];
    const paths = effectiveAllowedPaths(base, -500, 'member', cfg);
    expect(paths.length).toBe(1);
    expect(paths[0]).toContain(path.join('groups', '500'));
  });

  it('different groups get different isolated workspaces', () => {
    const cfg = cfgWithTmpRoot();
    const groupA = effectiveAllowedPaths([], -100, 'developer', cfg);
    const groupB = effectiveAllowedPaths([], -200, 'developer', cfg);
    expect(groupA[0]).not.toBe(groupB[0]);
    expect(groupA[0]).toContain(path.join('groups', '100'));
    expect(groupB[0]).toContain(path.join('groups', '200'));
    // Cross-group invisibility: groupA's root is NOT in groupB's allowlist
    expect(groupB).not.toContain(groupA[0]);
  });

  it('workspaces disabled falls back to base allowlist', () => {
    const cfg = cfgWithTmpRoot();
    cfg.workspaces.enabled = false;
    const base = ['D:\\ai-jarvis'];
    const paths = effectiveAllowedPaths(base, -500, 'developer', cfg);
    expect(paths).toEqual(base);
  });
});
