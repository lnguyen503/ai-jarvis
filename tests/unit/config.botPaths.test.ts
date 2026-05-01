/**
 * Unit tests — src/config/botPaths.ts
 *
 * ADR 021 D17: SSOT for per-bot data path construction.
 *
 * Tests:
 *   - resolveBotDataPath: happy paths (basic, nested subpath).
 *   - resolveBotDataPath: ../ traversal rejected.
 *   - resolveBotDataPath: absolute subpath segment rejected.
 *   - Named helpers: each resolves to the expected path.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { BotIdentity } from '../../src/config/botIdentity.js';
import {
  resolveBotDataPath,
  botDataDir,
  botSqliteDbPath,
  botOrganizeDir,
  botCoachDir,
  botCoachDraftsDir,
  botCalendarTokensPath,
  botLogsDir,
} from '../../src/config/botPaths.js';

// ---------------------------------------------------------------------------
// Test fixture — a minimal BotIdentity for testing path resolution.
// We use an absolute path on the current platform.
// ---------------------------------------------------------------------------

function makeIdentity(name: 'ai-jarvis' | 'ai-tony'): BotIdentity {
  const dataDir = path.resolve(process.cwd(), 'data', name);
  return {
    name,
    scope: name === 'ai-jarvis' ? 'full' : 'specialist',
    telegramToken: 'test-token',
    personaPath: path.resolve(process.cwd(), 'config', 'personas', `${name}.md`),
    dataDir,
    webappPort: name === 'ai-jarvis' ? 7879 : 7889,
    healthPort: name === 'ai-jarvis' ? 7878 : 7888,
    allowedTools: new Set(),
    aliases: [],
  additionalReadPaths: [],
  };
}

const jarvis = makeIdentity('ai-jarvis');
const tony = makeIdentity('ai-tony');

// ---------------------------------------------------------------------------
// resolveBotDataPath — happy paths
// ---------------------------------------------------------------------------

describe('resolveBotDataPath — happy paths', () => {
  it('resolves a simple filename', () => {
    const result = resolveBotDataPath(jarvis, 'jarvis.db');
    expect(result).toBe(path.join(jarvis.dataDir, 'jarvis.db'));
  });

  it('resolves a nested subpath', () => {
    const result = resolveBotDataPath(jarvis, 'organize', '12345');
    expect(result).toBe(path.join(jarvis.dataDir, 'organize', '12345'));
  });

  it('resolves deeply nested path', () => {
    const result = resolveBotDataPath(tony, 'coach', '999', 'drafts');
    expect(result).toBe(path.join(tony.dataDir, 'coach', '999', 'drafts'));
  });

  it('returns absolute path', () => {
    const result = resolveBotDataPath(tony, 'logs');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('result stays inside bot dataDir', () => {
    const result = resolveBotDataPath(tony, 'organize', '100');
    expect(result.toLowerCase().startsWith(tony.dataDir.toLowerCase())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveBotDataPath — traversal rejection
// ---------------------------------------------------------------------------

describe('resolveBotDataPath — traversal rejection', () => {
  it('rejects ../ traversal that would escape dataDir', () => {
    expect(() =>
      resolveBotDataPath(tony, '..', 'ai-jarvis', 'jarvis.db'),
    ).toThrow(/escapes dataDir/);
  });

  it('rejects multi-level ../ traversal', () => {
    expect(() =>
      resolveBotDataPath(tony, '..', '..', 'etc', 'passwd'),
    ).toThrow();
  });

  it('rejects absolute paths in subpath segment', () => {
    expect(() =>
      resolveBotDataPath(tony, path.resolve('D:/etc/secret')),
    ).toThrow(/absolute segment/);
  });
});

// ---------------------------------------------------------------------------
// Named helpers
// ---------------------------------------------------------------------------

describe('botDataDir', () => {
  it('returns identity.dataDir unchanged', () => {
    expect(botDataDir(jarvis)).toBe(jarvis.dataDir);
    expect(botDataDir(tony)).toBe(tony.dataDir);
  });
});

describe('botSqliteDbPath', () => {
  it('resolves to jarvis.db inside bot dataDir', () => {
    const p = botSqliteDbPath(jarvis);
    expect(p).toBe(path.join(jarvis.dataDir, 'jarvis.db'));
  });

  it('is absolute', () => {
    expect(path.isAbsolute(botSqliteDbPath(tony))).toBe(true);
  });
});

describe('botOrganizeDir', () => {
  it('resolves organize/<userId>', () => {
    const p = botOrganizeDir(jarvis, 12345);
    expect(p).toBe(path.join(jarvis.dataDir, 'organize', '12345'));
  });

  it('accepts string userId', () => {
    const p = botOrganizeDir(tony, '99');
    expect(p).toBe(path.join(tony.dataDir, 'organize', '99'));
  });
});

describe('botCoachDir', () => {
  it('resolves coach/<userId>', () => {
    const p = botCoachDir(jarvis, 777);
    expect(p).toBe(path.join(jarvis.dataDir, 'coach', '777'));
  });
});

describe('botCoachDraftsDir', () => {
  it('resolves coach/<userId>/drafts', () => {
    const p = botCoachDraftsDir(tony, 888);
    expect(p).toBe(path.join(tony.dataDir, 'coach', '888', 'drafts'));
  });
});

describe('botCalendarTokensPath', () => {
  it('resolves google-tokens.json', () => {
    const p = botCalendarTokensPath(jarvis);
    expect(p).toBe(path.join(jarvis.dataDir, 'google-tokens.json'));
  });
});

describe('botLogsDir', () => {
  it('resolves logs directory', () => {
    const p = botLogsDir(tony);
    expect(p).toBe(path.join(tony.dataDir, 'logs'));
  });
});
