import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  userMemoryPath,
  readUserMemory,
  appendUserMemoryEntry,
  forgetUserMemoryEntries,
  clearUserMemory,
} from '../../src/memory/userMemory.js';

let dataDir: string;
const USER_ID = 1234567890;
const NAME = 'Boss';

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-mem-test-'));
  return async (): Promise<void> => {
    await rm(dataDir, { recursive: true, force: true });
  };
});

describe('userMemoryPath', () => {
  it('uses the absolute integer userId in the filename', () => {
    const p = userMemoryPath(1234567890, '/data');
    expect(p).toMatch(/1234567890\.md$/);
  });

  it('strips signs and decimals', () => {
    expect(userMemoryPath(-100, '/data')).toMatch(/100\.md$/);
  });

  it('throws on invalid id', () => {
    expect(() => userMemoryPath(0, '/data')).toThrow();
    expect(() => userMemoryPath(NaN, '/data')).toThrow();
  });
});

describe('readUserMemory', () => {
  it('returns empty string when file does not exist', async () => {
    const body = await readUserMemory(USER_ID, dataDir);
    expect(body).toBe('');
  });
});

describe('appendUserMemoryEntry', () => {
  it('creates the file with a full scaffold on first write', async () => {
    await appendUserMemoryEntry(USER_ID, 'preferences', 'prefers brief replies', NAME, dataDir);
    const body = await readUserMemory(USER_ID, dataDir);
    expect(body).toContain(`# Memory for ${NAME}`);
    expect(body).toContain('## Profile');
    expect(body).toContain('## Preferences');
    expect(body).toContain('## Projects');
    expect(body).toContain('## People');
    expect(body).toContain('## Avoid');
    expect(body).toContain('- prefers brief replies');
  });

  it('stamps Last updated timestamp', async () => {
    await appendUserMemoryEntry(USER_ID, 'profile', 'Pacific time zone', NAME, dataDir);
    const body = await readUserMemory(USER_ID, dataDir);
    expect(body).toMatch(/_Last updated: \d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple entries to the right section', async () => {
    await appendUserMemoryEntry(USER_ID, 'preferences', 'pref one', NAME, dataDir);
    await appendUserMemoryEntry(USER_ID, 'preferences', 'pref two', NAME, dataDir);
    await appendUserMemoryEntry(USER_ID, 'projects', 'project one', NAME, dataDir);
    const body = await readUserMemory(USER_ID, dataDir);
    expect(body).toContain('- pref one');
    expect(body).toContain('- pref two');
    expect(body).toContain('- project one');
  });

  it('removes the "(empty)" placeholder when first bullet lands', async () => {
    await appendUserMemoryEntry(USER_ID, 'avoid', 'no apologies first', NAME, dataDir);
    const body = await readUserMemory(USER_ID, dataDir);
    // The "Avoid" section should now have the bullet but NO "_(empty)_" line.
    const avoidSection = /## Avoid[\s\S]*?(?=## |$)/.exec(body)?.[0] ?? '';
    expect(avoidSection).toContain('- no apologies first');
    expect(avoidSection).not.toContain('_(empty)_');
  });
});

describe('forgetUserMemoryEntries', () => {
  it('removes entries containing the topic substring', async () => {
    await appendUserMemoryEntry(USER_ID, 'preferences', 'voice replies on', NAME, dataDir);
    await appendUserMemoryEntry(USER_ID, 'preferences', 'use Sonnet for code', NAME, dataDir);
    await appendUserMemoryEntry(USER_ID, 'profile', 'Pacific time zone', NAME, dataDir);

    const r = await forgetUserMemoryEntries(USER_ID, 'voice', dataDir);
    expect(r.removed).toBe(1);

    const body = await readUserMemory(USER_ID, dataDir);
    expect(body).not.toContain('voice replies');
    expect(body).toContain('use Sonnet');
    expect(body).toContain('Pacific time zone');
  });

  it('returns 0 when no match', async () => {
    await appendUserMemoryEntry(USER_ID, 'profile', 'lives in PT', NAME, dataDir);
    const r = await forgetUserMemoryEntries(USER_ID, 'nonexistent topic', dataDir);
    expect(r.removed).toBe(0);
  });

  it('restores "(empty)" placeholder when section becomes empty', async () => {
    await appendUserMemoryEntry(USER_ID, 'avoid', 'no emoji', NAME, dataDir);
    await forgetUserMemoryEntries(USER_ID, 'no emoji', dataDir);
    const body = await readUserMemory(USER_ID, dataDir);
    expect(body).toContain('## Avoid');
    expect(body).toContain('_(empty)_');
  });

  it('handles missing file gracefully', async () => {
    const r = await forgetUserMemoryEntries(USER_ID, 'anything', dataDir);
    expect(r.removed).toBe(0);
  });

  it('case-insensitive match', async () => {
    await appendUserMemoryEntry(USER_ID, 'preferences', 'use Sonnet for hard tasks', NAME, dataDir);
    const r = await forgetUserMemoryEntries(USER_ID, 'sonnet', dataDir);
    expect(r.removed).toBe(1);
  });
});

describe('clearUserMemory', () => {
  it('removes the file entirely', async () => {
    await appendUserMemoryEntry(USER_ID, 'profile', 'something', NAME, dataDir);
    expect(existsSync(userMemoryPath(USER_ID, dataDir))).toBe(true);
    await clearUserMemory(USER_ID, dataDir);
    expect(existsSync(userMemoryPath(USER_ID, dataDir))).toBe(false);
  });

  it('is a no-op when no file exists', async () => {
    const r = await clearUserMemory(USER_ID, dataDir);
    expect(r.ok).toBe(true);
  });
});

describe('atomic write', () => {
  it('does not leave a .tmp file behind on success', async () => {
    await appendUserMemoryEntry(USER_ID, 'profile', 'fact', NAME, dataDir);
    expect(existsSync(userMemoryPath(USER_ID, dataDir) + '.tmp')).toBe(false);
  });
});
