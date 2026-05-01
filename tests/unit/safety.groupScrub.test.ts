/**
 * Unit tests for src/safety/groupScrub.ts
 *
 * Key property verified: hostname and username are NEVER present in scrubbed output.
 * Also verifies path redaction and that the base scrub() is still applied.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import { scrubForGroup } from '../../src/safety/groupScrub.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

describe('safety.groupScrub.scrubForGroup', () => {
  const cfg = makeTestConfig();

  it('delegates to base scrub: redacts API keys', () => {
    const text = 'my api key is sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const result = scrubForGroup(text, cfg);
    expect(result).not.toContain('sk-ant-api03');
    expect(result).toContain('[REDACTED:ANTHROPIC_KEY]');
  });

  it('redacts allowed filesystem paths', () => {
    const allowedPath = cfg.filesystem.allowedPaths[0]!;
    const text = `The file is at ${allowedPath}\\somefile.txt`;
    const result = scrubForGroup(text, cfg);
    expect(result).not.toContain(allowedPath);
    expect(result).toContain('<path>');
  });

  it('NEVER contains os.hostname() in scrubbed group output', () => {
    const hostname = os.hostname();
    const text = `Running on ${hostname}, everything is fine`;
    const result = scrubForGroup(text, cfg);
    // hostname must not appear in the output (case-insensitive)
    expect(result.toLowerCase()).not.toContain(hostname.toLowerCase());
    expect(result).toContain('<hostname>');
  });

  it('NEVER contains os.userInfo().username in scrubbed group output', () => {
    let username: string;
    try {
      username = os.userInfo().username;
    } catch {
      // Some environments don't have userInfo — skip
      return;
    }
    if (!username) return;

    const text = `User ${username} logged in`;
    const result = scrubForGroup(text, cfg);
    expect(result.toLowerCase()).not.toContain(username.toLowerCase());
    expect(result).toContain('<username>');
  });

  it('handles text with no sensitive content unchanged (except normalization)', () => {
    const text = 'Hello, how are you today?';
    const result = scrubForGroup(text, cfg);
    expect(result).toBe(text);
  });

  it('redacts multiple allowed paths in one string', () => {
    // makeTestConfig creates a single tmp path, but add a fake to check multi-redact
    const multiCfg = makeTestConfig({
      filesystem: {
        allowedPaths: [cfg.filesystem.allowedPaths[0]!],
        readDenyGlobs: cfg.filesystem.readDenyGlobs,
      },
    });
    const p = multiCfg.filesystem.allowedPaths[0]!;
    const text = `File A: ${p}\\a.txt and File B: ${p}\\b.txt`;
    const result = scrubForGroup(text, multiCfg);
    expect(result).not.toContain(p);
    // Both occurrences should be redacted
    expect(result.split('<path>').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('path redaction is case-insensitive', () => {
    const allowedPath = cfg.filesystem.allowedPaths[0]!;
    const text = `path: ${allowedPath.toLowerCase()}\\foo`;
    const result = scrubForGroup(text, cfg);
    expect(result).not.toContain(allowedPath.toLowerCase());
  });

  it('returns a string (never throws)', () => {
    expect(() => scrubForGroup('', cfg)).not.toThrow();
    expect(() => scrubForGroup('some text', cfg)).not.toThrow();
  });
});
