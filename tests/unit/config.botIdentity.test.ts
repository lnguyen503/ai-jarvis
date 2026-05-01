/**
 * Unit tests — src/config/botIdentity.ts
 *
 * ADR 021 D1 + D2 + D6 + CP1 R6.
 *
 * Tests:
 *   - isBotName: all valid + invalid values.
 *   - resolveBotIdentity: happy paths (ai-jarvis default, ai-tony explicit).
 *   - resolveBotIdentity: sad paths (missing token, invalid name).
 *   - SPECIALIST_TOOL_ALLOWLIST: constants verified.
 *   - Identity fields: scope, personaPath, dataDir, webappPort, allowedTools.
 */

import { describe, it, expect } from 'vitest';
import {
  BOT_NAMES,
  SPECIALIST_TOOL_ALLOWLIST,
  isBotName,
  resolveBotIdentity,
  personaPathFor,
  dataDirFor,
  webappPortFor,
  healthPortFor,
} from '../../src/config/botIdentity.js';

// ---------------------------------------------------------------------------
// isBotName
// ---------------------------------------------------------------------------

describe('isBotName', () => {
  it('returns true for all BOT_NAMES members', () => {
    for (const name of BOT_NAMES) {
      expect(isBotName(name)).toBe(true);
    }
  });

  it('returns false for unknown string', () => {
    expect(isBotName('ai-unknown')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isBotName('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isBotName(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isBotName(undefined)).toBe(false);
  });

  it('returns false for number', () => {
    expect(isBotName(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveBotIdentity — happy paths
// ---------------------------------------------------------------------------

describe('resolveBotIdentity — happy paths', () => {
  const baseEnv: Record<string, string | undefined> = {
    BOT_TOKEN_AI_JARVIS: 'jarvis-test-token-123',
    BOT_TOKEN_AI_TONY:   'tony-test-token-456',
  };

  it('defaults to ai-jarvis when BOT_NAME is undefined', () => {
    const result = resolveBotIdentity(undefined, baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.name).toBe('ai-jarvis');
    }
  });

  it('resolves ai-jarvis explicitly', () => {
    const result = resolveBotIdentity('ai-jarvis', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.name).toBe('ai-jarvis');
      expect(result.identity.scope).toBe('full');
      expect(result.identity.telegramToken).toBe('jarvis-test-token-123');
    }
  });

  it('resolves ai-tony explicitly', () => {
    const result = resolveBotIdentity('ai-tony', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.name).toBe('ai-tony');
      expect(result.identity.scope).toBe('specialist');
      expect(result.identity.telegramToken).toBe('tony-test-token-456');
    }
  });

  it('ai-jarvis has scope=full', () => {
    const result = resolveBotIdentity('ai-jarvis', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.scope).toBe('full');
    }
  });

  it('ai-tony has scope=specialist', () => {
    const result = resolveBotIdentity('ai-tony', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.scope).toBe('specialist');
    }
  });

  it('ai-tony allowedTools equals SPECIALIST_TOOL_ALLOWLIST', () => {
    const result = resolveBotIdentity('ai-tony', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const tool of SPECIALIST_TOOL_ALLOWLIST) {
        expect(result.identity.allowedTools.has(tool)).toBe(true);
      }
      expect(result.identity.allowedTools.size).toBe(SPECIALIST_TOOL_ALLOWLIST.size);
    }
  });

  it('ai-jarvis allowedTools is empty set (no filtering = full scope)', () => {
    const result = resolveBotIdentity('ai-jarvis', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Full scope: empty set means "no restriction"
      expect(result.identity.allowedTools.size).toBe(0);
    }
  });

  it('personaPath ends with bot name + .md', () => {
    const result = resolveBotIdentity('ai-tony', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.personaPath.endsWith('ai-tony.md')).toBe(true);
    }
  });

  it('dataDir ends with bot name', () => {
    const result = resolveBotIdentity('ai-tony', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const last = result.identity.dataDir.split(/[\\/]/).pop();
      expect(last).toBe('ai-tony');
    }
  });

  it('webappPort is 7879 for ai-jarvis', () => {
    const result = resolveBotIdentity('ai-jarvis', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.webappPort).toBe(7879);
    }
  });

  it('webappPort is 7889 for ai-tony', () => {
    const result = resolveBotIdentity('ai-tony', baseEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.webappPort).toBe(7889);
    }
  });

  it('trims whitespace from token', () => {
    const result = resolveBotIdentity('ai-jarvis', {
      ...baseEnv,
      BOT_TOKEN_AI_JARVIS: '  padded-token  ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.telegramToken).toBe('padded-token');
    }
  });
});

// ---------------------------------------------------------------------------
// resolveBotIdentity — sad paths
// ---------------------------------------------------------------------------

describe('resolveBotIdentity — sad paths', () => {
  it('returns ok:false for invalid BOT_NAME', () => {
    const result = resolveBotIdentity('ai-unknown', { BOT_TOKEN_AI_UNKNOWN: 'tok' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('BOT_NAMES closed set');
    }
  });

  it('returns ok:false when token env var is missing', () => {
    const result = resolveBotIdentity('ai-tony', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('BOT_TOKEN_AI_TONY');
    }
  });

  it('returns ok:false when token is empty string', () => {
    const result = resolveBotIdentity('ai-tony', { BOT_TOKEN_AI_TONY: '' });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when token is whitespace only', () => {
    const result = resolveBotIdentity('ai-tony', { BOT_TOKEN_AI_TONY: '   ' });
    expect(result.ok).toBe(false);
  });

  it('error message contains the invalid name', () => {
    const result = resolveBotIdentity('jarvis-old', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('jarvis-old');
    }
  });
});

// ---------------------------------------------------------------------------
// Path helper functions
// ---------------------------------------------------------------------------

describe('personaPathFor', () => {
  it('ai-jarvis path ends with ai-jarvis.md', () => {
    expect(personaPathFor('ai-jarvis').endsWith('ai-jarvis.md')).toBe(true);
  });

  it('ai-tony path ends with ai-tony.md', () => {
    expect(personaPathFor('ai-tony').endsWith('ai-tony.md')).toBe(true);
  });
});

describe('dataDirFor', () => {
  it('ai-jarvis dir ends with ai-jarvis', () => {
    const d = dataDirFor('ai-jarvis');
    const last = d.split(/[\\/]/).pop();
    expect(last).toBe('ai-jarvis');
  });
});

describe('webappPortFor', () => {
  it('returns 7879 for ai-jarvis', () => {
    expect(webappPortFor('ai-jarvis')).toBe(7879);
  });

  it('returns 7889 for ai-tony', () => {
    expect(webappPortFor('ai-tony')).toBe(7889);
  });

  it('returns 7899 for ai-natasha', () => {
    expect(webappPortFor('ai-natasha')).toBe(7899);
  });

  it('returns 7909 for ai-bruce', () => {
    expect(webappPortFor('ai-bruce')).toBe(7909);
  });
});

describe('healthPortFor', () => {
  it('returns 7878 for ai-jarvis', () => {
    expect(healthPortFor('ai-jarvis')).toBe(7878);
  });

  it('returns 7888 for ai-tony', () => {
    expect(healthPortFor('ai-tony')).toBe(7888);
  });

  it('returns 7898 for ai-natasha', () => {
    expect(healthPortFor('ai-natasha')).toBe(7898);
  });

  it('returns 7908 for ai-bruce', () => {
    expect(healthPortFor('ai-bruce')).toBe(7908);
  });

  it('all health ports are unique', () => {
    const set = new Set(BOT_NAMES.map((n) => healthPortFor(n)));
    expect(set.size).toBe(BOT_NAMES.length);
  });

  it('all health ports are different from webapp ports', () => {
    for (const name of BOT_NAMES) {
      expect(healthPortFor(name)).not.toBe(webappPortFor(name));
    }
  });
});
