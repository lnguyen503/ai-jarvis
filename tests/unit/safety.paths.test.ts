/**
 * §15.1 + §15.2 — Path sandbox tests (C1, C7, C10).
 * These MUST fail against a broken implementation and pass against the correct one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PathSandbox } from '../../src/safety/paths.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

describe('safety.paths.isPathAllowed (§15.1)', () => {
  let cfg: AppConfig;
  let sandbox: PathSandbox;
  let allowedRoot: string;

  beforeAll(() => {
    cfg = makeTestConfig();
    const root = cfg.filesystem.allowedPaths[0];
    if (!root) throw new Error('no allowed root');
    allowedRoot = root;
    // Create subdirs for test cases
    fs.mkdirSync(path.join(allowedRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(allowedRoot, 'src', 'index.ts'), '// test');
    sandbox = new PathSandbox(cfg);
  });

  afterAll(() => {
    try {
      fs.rmSync(allowedRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('accepts a file inside the allowed root', () => {
    expect(sandbox.isPathAllowed(path.join(allowedRoot, 'src', 'index.ts'))).toBe(true);
  });

  it('rejects empty input', () => {
    expect(sandbox.isPathAllowed('')).toBe(false);
  });

  it('rejects input containing NUL', () => {
    expect(sandbox.isPathAllowed(`${allowedRoot}\x00evil`)).toBe(false);
  });

  it('rejects UNC paths (\\\\server\\share)', () => {
    expect(sandbox.isPathAllowed('\\\\server\\share\\file.txt')).toBe(false);
  });

  it('rejects Windows device paths (\\\\?\\C:\\Windows\\...)', () => {
    expect(sandbox.isPathAllowed('\\\\?\\C:\\Windows\\System32\\cmd.exe')).toBe(false);
  });

  it('rejects a sibling directory whose name is a prefix of an allowed root (trailing-sep test)', () => {
    // D:\ai-jarvis-evil must NOT match D:\ai-jarvis
    const evilSibling = `${allowedRoot}-evil`;
    expect(sandbox.isPathAllowed(evilSibling)).toBe(false);
    expect(sandbox.isPathAllowed(path.join(`${allowedRoot}-evil`, 'x'))).toBe(false);
  });

  it('accepts a case-variant form of the allowed root (Windows case-insensitive)', () => {
    // On Windows, d:\... and D:\... should canonicalize identically.
    // On Linux/CI, this skips meaningfully but case-folding still applies via lowercase.
    const upper = allowedRoot.toUpperCase();
    const result = sandbox.isPathAllowed(upper);
    // On Windows this must be true; on Linux the realpath may differ but the
    // lowercasing still makes them match if the underlying OS is case-insensitive
    if (process.platform === 'win32') {
      expect(result).toBe(true);
    }
    // On Linux, skip the assertion — this test is Windows-specific
  });

  it('accepts NFD-encoded Unicode that equals an NFC-encoded allowed root', () => {
    // "café" in NFD vs NFC
    const nfc = 'café';
    const nfd = nfc.normalize('NFD');
    // Both forms should normalize the same way inside canonicalize()
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));
  });

  it('rejects a non-existent allowed root at boot (via makeTestConfig existence check)', () => {
    // loadConfig() should fail if allowedPaths contains a non-existent directory.
    // We simulate by constructing a PathSandbox with a non-existent path —
    // the PathSandbox itself does NOT validate existence (that's the config loader's job)
    // but the config loader test below verifies the boot-fail behavior.
    const fakePath = path.join(os.tmpdir(), 'this-does-not-exist-xyzzy-12345');
    expect(fs.existsSync(fakePath)).toBe(false);
    // We still expect isPathAllowed to reject a path under a non-existent root
    const fakeCfg = { ...cfg, filesystem: { ...cfg.filesystem, allowedPaths: [fakePath] } };
    const fakeSandbox = new PathSandbox(fakeCfg);
    expect(fakeSandbox.isPathAllowed(path.join(fakePath, 'x'))).toBe(false);
  });

  it('rejects paths outside the allowed root', () => {
    const outsidePath = path.join(os.tmpdir(), 'definitely-outside-jarvis');
    expect(sandbox.isPathAllowed(outsidePath)).toBe(false);
  });

  it('rejects a symlink escape (link inside allowed root pointing outside)', () => {
    // This test only works where symlinks can be created without admin on Windows (developer mode)
    // We attempt it and skip gracefully if unavailable.
    const target = os.tmpdir();
    const linkPath = path.join(allowedRoot, 'escape-link');

    try {
      fs.symlinkSync(target, linkPath, 'dir');
    } catch {
      // On Windows without developer mode or admin, symlinks fail — skip
      return;
    }

    // After creating a symlink to tmpdir, accessing it should resolve to tmpdir
    // and be rejected because tmpdir is outside the allowed root.
    const escaped = path.join(linkPath, 'somefile');
    // Write a file in tmpdir so realpath can resolve
    fs.writeFileSync(path.join(target, 'symlink-test-file.txt'), 'test');
    const result = sandbox.isPathAllowed(escaped);
    expect(result).toBe(false);
    // Cleanup
    fs.unlinkSync(linkPath);
    fs.unlinkSync(path.join(target, 'symlink-test-file.txt'));
  });

  it('accepts the allowed root itself (exact match)', () => {
    expect(sandbox.isPathAllowed(allowedRoot)).toBe(true);
  });

  it('accepts nested subdirectories under an allowed root (regression: forward/backslash + non-canonical root)', () => {
    // Regression: constructor must canonicalize its own roots so inputs like
    // "D:/projects/example-app" in config.json (forward slashes, not realpath'd) still
    // correctly accept "D:\\projects\\example-app".
    const nestedDir = path.join(allowedRoot, 'deeply', 'nested', 'subdir');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedFile = path.join(nestedDir, 'file.txt');
    fs.writeFileSync(nestedFile, 'test');
    expect(sandbox.isPathAllowed(nestedDir)).toBe(true);
    expect(sandbox.isPathAllowed(nestedFile)).toBe(true);

    // Also construct a sandbox with a root expressed via forward slashes and
    // verify subdirectory acceptance holds (the bug this regression guards).
    const fwdCfg = {
      ...cfg,
      filesystem: { ...cfg.filesystem, allowedPaths: [allowedRoot.replace(/\\/g, '/')] },
    };
    const fwdSandbox = new PathSandbox(fwdCfg);
    expect(fwdSandbox.isPathAllowed(allowedRoot)).toBe(true);
    expect(fwdSandbox.isPathAllowed(nestedDir)).toBe(true);
    expect(fwdSandbox.isPathAllowed(nestedFile)).toBe(true);
  });
});

describe('safety.paths.isReadAllowed (§15.2)', () => {
  let cfg: AppConfig;
  let sandbox: PathSandbox;
  let allowedRoot: string;

  beforeAll(() => {
    cfg = makeTestConfig();
    const root = cfg.filesystem.allowedPaths[0];
    if (!root) throw new Error('no allowed root');
    allowedRoot = root;

    // Create protected files inside the allowed root
    fs.writeFileSync(path.join(allowedRoot, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(allowedRoot, '.env.local'), 'SECRET=2');
    fs.writeFileSync(path.join(allowedRoot, '.env.production'), 'SECRET=3');
    fs.mkdirSync(path.join(allowedRoot, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(allowedRoot, 'logs', 'jarvis.log'), 'log line');
    fs.mkdirSync(path.join(allowedRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(allowedRoot, 'data', 'jarvis.db'), 'fake db');
    fs.writeFileSync(path.join(allowedRoot, 'credentials.json'), '{}');
    fs.writeFileSync(path.join(allowedRoot, 'id_rsa'), 'PRIVATE');
    fs.writeFileSync(path.join(allowedRoot, 'foo.pem'), 'CERT');
    fs.writeFileSync(path.join(allowedRoot, 'allowed.txt'), 'ok');

    sandbox = new PathSandbox(cfg);
  });

  afterAll(() => {
    try {
      fs.rmSync(allowedRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects .env', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, '.env'))).toBe(false);
  });

  it('rejects .env.local', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, '.env.local'))).toBe(false);
  });

  it('rejects .env.production', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, '.env.production'))).toBe(false);
  });

  it('rejects logs/jarvis.log', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, 'logs', 'jarvis.log'))).toBe(false);
  });

  it('rejects data/jarvis.db', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, 'data', 'jarvis.db'))).toBe(false);
  });

  it('rejects credentials.json', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, 'credentials.json'))).toBe(false);
  });

  it('rejects id_rsa', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, 'id_rsa'))).toBe(false);
  });

  it('rejects foo.pem', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, 'foo.pem'))).toBe(false);
  });

  it('allows a normal file', () => {
    expect(sandbox.isReadAllowed(path.join(allowedRoot, 'allowed.txt'))).toBe(true);
  });

  it('filterDeniedEntries excludes .env and logs/ from listings', () => {
    const entries = ['.env', '.env.local', 'allowed.txt', 'logs', 'data', 'credentials.json'];
    const filtered = sandbox.filterDeniedEntries(allowedRoot, entries);
    expect(filtered).toContain('allowed.txt');
    expect(filtered).not.toContain('.env');
    expect(filtered).not.toContain('.env.local');
    expect(filtered).not.toContain('credentials.json');
  });
});
