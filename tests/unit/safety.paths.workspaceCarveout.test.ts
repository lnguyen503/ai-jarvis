/**
 * v1.7.5 — workspace carveout for factory-self write-deny globs.
 *
 * Inside the workspaces tree, a developer must be able to create typical
 * project structure (config/, src/, tests/, package.json) for their own
 * build. The factory-self deny globs that protect Jarvis's install should
 * NOT apply inside the workspaces tree. Secrets + databases still always
 * denied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PathSandbox } from '../../src/safety/paths.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

let testRoot: string;
let workspaceRoot: string;

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-carveout-'));
  workspaceRoot = path.join(testRoot, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'groups', '100'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function cfgForCarveout(): AppConfig {
  const cfg = makeTestConfig();
  cfg.filesystem.allowedPaths = [testRoot];
  cfg.workspaces = { enabled: true, root: workspaceRoot };
  return cfg;
}

describe('path-sandbox — workspace carveout', () => {
  it('blocks factory-self files OUTSIDE the workspaces tree', () => {
    const sandbox = new PathSandbox(cfgForCarveout());
    // A config/ dir at the factory root equivalent — denied
    expect(sandbox.isWriteAllowed(path.join(testRoot, 'config', 'x.json'))).toBe(false);
    expect(sandbox.isWriteAllowed(path.join(testRoot, 'src', 'index.ts'))).toBe(false);
    expect(sandbox.isWriteAllowed(path.join(testRoot, 'package.json'))).toBe(false);
  });

  it('ALLOWS factory-self-shaped files INSIDE a workspace', () => {
    const sandbox = new PathSandbox(cfgForCarveout());
    const wsGroup = path.join(workspaceRoot, 'groups', '100');
    // Developer building a real project in their workspace — permitted
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'config', 'x.json'))).toBe(true);
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'src', 'index.ts'))).toBe(true);
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'package.json'))).toBe(true);
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'tests', 'a.test.ts'))).toBe(true);
  });

  it('STILL blocks secrets inside a workspace', () => {
    const sandbox = new PathSandbox(cfgForCarveout());
    const wsGroup = path.join(workspaceRoot, 'groups', '100');
    expect(sandbox.isWriteAllowed(path.join(wsGroup, '.env'))).toBe(false);
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'credentials.json'))).toBe(false);
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'id_rsa'))).toBe(false);
    expect(sandbox.isWriteAllowed(path.join(wsGroup, 'my.db'))).toBe(false);
  });
});
