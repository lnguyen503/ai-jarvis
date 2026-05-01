/**
 * V-14 regression: expanded write-denylist globs covering config/src/package.json etc.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { PathSandbox } from '../../src/safety/paths.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

function makeSandbox() {
  const cfg = makeTestConfig();
  const root = cfg.filesystem.allowedPaths[0]!;
  return { sandbox: new PathSandbox(cfg), root };
}

describe('safety.paths — V-14 write denylist (self-modification protection)', () => {
  it('denies writing to config/config.json', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'config', 'config.json'))).toBe(false);
  });

  it('denies writing to config/system-prompt.md', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'config', 'system-prompt.md'))).toBe(false);
  });

  it('denies writing to src/safety/scrubber.ts', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'src', 'safety', 'scrubber.ts'))).toBe(false);
  });

  it('denies writing to src/tools/index.ts', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'src', 'tools', 'index.ts'))).toBe(false);
  });

  it('denies writing to tests/unit/foo.test.ts', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'tests', 'unit', 'foo.test.ts'))).toBe(false);
  });

  it('denies writing to dist/index.js', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'dist', 'index.js'))).toBe(false);
  });

  it('denies writing to .claude/factory-rules.md', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, '.claude', 'factory-rules.md'))).toBe(false);
  });

  it('denies writing to ecosystem.config.cjs', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'ecosystem.config.cjs'))).toBe(false);
  });

  it('denies writing to package.json', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'package.json'))).toBe(false);
  });

  it('denies writing to package-lock.json', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'package-lock.json'))).toBe(false);
  });

  it('denies writing to tsconfig.json', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'tsconfig.json'))).toBe(false);
  });

  it('denies writing to tsconfig.build.json', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'tsconfig.build.json'))).toBe(false);
  });

  it('denies writing to vitest.config.ts', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'vitest.config.ts'))).toBe(false);
  });

  it('denies writing to .eslintrc.json', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, '.eslintrc.json'))).toBe(false);
  });

  it('denies writing to .github/workflows/ci.yml', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, '.github', 'workflows', 'ci.yml'))).toBe(false);
  });

  it('denies writing to CHANGELOG.md', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'CHANGELOG.md'))).toBe(false);
  });

  it('denies writing to README.md', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'README.md'))).toBe(false);
  });

  // Verify normal project files are still writable
  it('still allows writing to normal project files', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'output', 'report.html'))).toBe(true);
    expect(sandbox.isWriteAllowed(path.join(root, 'notes', 'todo.txt'))).toBe(true);
  });
});

describe('safety.paths — V-06 .env variant read/write denial', () => {
  it('denies reading *.env files (production.env)', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isReadAllowed(path.join(root, 'production.env'))).toBe(false);
  });

  it('denies writing *.env files (config.env)', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isWriteAllowed(path.join(root, 'config.env'))).toBe(false);
  });

  it('denies reading .env-backup', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isReadAllowed(path.join(root, '.env-backup'))).toBe(false);
  });

  it('denies reading .env.production.local', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isReadAllowed(path.join(root, '.env.production.local'))).toBe(false);
  });

  it('denies reading env.local', () => {
    const { sandbox, root } = makeSandbox();
    expect(sandbox.isReadAllowed(path.join(root, 'env.local'))).toBe(false);
  });
});
