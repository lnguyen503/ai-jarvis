/**
 * Static test — ADR 021 D1 + D2 + D6 + CP1 R6: BOT_NAMES closed set.
 *
 * Mirrors v1.20.0 tests/static/coach-profile-closed-set.test.ts pattern.
 *
 * Binding assertions (v1.21.1 — closed set expanded to 4 Avengers):
 *   1. BOT_NAMES has exactly 4 members for v1.21.1.
 *   2. BOT_NAMES contains all 4 Avengers (ai-jarvis, ai-tony, ai-natasha, ai-bruce).
 *   3. BOT_MARKER_BY_NAME has entries for all 4 bots.
 *   4. SPECIALIST_TOOL_ALLOWLIST has exactly 9 tools (CP1 R6: size was 10, now 9).
 *   5. 'run_command' is NOT in SPECIALIST_TOOL_ALLOWLIST (CP1 R6 BINDING).
 *   6. The comment marker 'REMOVED per CP1 R6' is present in botIdentity.ts source.
 *   7. isBotName type guard works correctly.
 *   8. personaPathFor returns a path ending with the bot name + '.md'.
 *   9. dataDirFor returns a path ending with the bot name.
 *
 * ADR 021 D1 + D2 + D6 + CP1 R6 commit 1.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_NAMES,
  BOT_MARKER_BY_NAME,
  SPECIALIST_TOOL_ALLOWLIST,
  isBotName,
  personaPathFor,
  dataDirFor,
} from '../../src/config/botIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_IDENTITY_SRC = path.resolve(__dirname, '../../src/config/botIdentity.ts');

describe('ADR 021 D2: BOT_NAMES closed set (v1.21.1 — 4 Avengers)', () => {
  it('has exactly 4 bots for v1.21.1', () => {
    expect(BOT_NAMES).toHaveLength(4);
  });

  it('contains ai-jarvis', () => {
    expect(BOT_NAMES).toContain('ai-jarvis');
  });

  it('contains ai-tony', () => {
    expect(BOT_NAMES).toContain('ai-tony');
  });

  it('contains ai-natasha', () => {
    expect(BOT_NAMES).toContain('ai-natasha');
  });

  it('contains ai-bruce', () => {
    expect(BOT_NAMES).toContain('ai-bruce');
  });

  it('ai-jarvis appears first (back-compat — full scope)', () => {
    expect(BOT_NAMES[0]).toBe('ai-jarvis');
  });
});

describe('ADR 021 D1: BOT_MARKER_BY_NAME token env var convention', () => {
  it('has an entry for all bots', () => {
    for (const name of BOT_NAMES) {
      expect(BOT_MARKER_BY_NAME[name]).toBeDefined();
    }
  });

  it('ai-jarvis uses BOT_TOKEN_AI_JARVIS', () => {
    expect(BOT_MARKER_BY_NAME['ai-jarvis']).toBe('BOT_TOKEN_AI_JARVIS');
  });

  it('ai-tony uses BOT_TOKEN_AI_TONY', () => {
    expect(BOT_MARKER_BY_NAME['ai-tony']).toBe('BOT_TOKEN_AI_TONY');
  });

  it('ai-natasha uses BOT_TOKEN_AI_NATASHA', () => {
    expect(BOT_MARKER_BY_NAME['ai-natasha']).toBe('BOT_TOKEN_AI_NATASHA');
  });

  it('ai-bruce uses BOT_TOKEN_AI_BRUCE', () => {
    expect(BOT_MARKER_BY_NAME['ai-bruce']).toBe('BOT_TOKEN_AI_BRUCE');
  });

  it('all markers start with BOT_TOKEN_', () => {
    for (const name of BOT_NAMES) {
      expect(BOT_MARKER_BY_NAME[name].startsWith('BOT_TOKEN_')).toBe(true);
    }
  });
});

describe('ADR 021 D6 + CP1 R6: SPECIALIST_TOOL_ALLOWLIST closed set', () => {
  it('has exactly 9 tools (CP1 R6: run_command removed)', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.size).toBe(9);
  });

  it('run_command is NOT in SPECIALIST_TOOL_ALLOWLIST (CP1 R6 BINDING)', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('run_command')).toBe(false);
  });

  it('contains read_file', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('read_file')).toBe(true);
  });

  it('contains write_file', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('write_file')).toBe(true);
  });

  it('contains list_directory', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('list_directory')).toBe(true);
  });

  it('contains search_files', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('search_files')).toBe(true);
  });

  it('contains system_info', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('system_info')).toBe(true);
  });

  it('contains recall_archive', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('recall_archive')).toBe(true);
  });

  it('contains web_search', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('web_search')).toBe(true);
  });

  it('contains browse_url', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('browse_url')).toBe(true);
  });

  it('contains send_file', () => {
    expect(SPECIALIST_TOOL_ALLOWLIST.has('send_file')).toBe(true);
  });

  it('source file contains REMOVED per CP1 R6 comment marker', () => {
    const src = fs.readFileSync(BOT_IDENTITY_SRC, 'utf8');
    expect(src).toContain('REMOVED per CP1 R6');
  });
});

describe('ADR 021 D1: isBotName type guard', () => {
  it('returns true for all 4 Avengers', () => {
    expect(isBotName('ai-jarvis')).toBe(true);
    expect(isBotName('ai-tony')).toBe(true);
    expect(isBotName('ai-natasha')).toBe(true);
    expect(isBotName('ai-bruce')).toBe(true);
  });

  it('returns false for unknown names', () => {
    expect(isBotName('ai-unknown')).toBe(false);
    expect(isBotName('jarvis')).toBe(false);
    expect(isBotName('')).toBe(false);
  });

  it('returns false for non-string types', () => {
    expect(isBotName(null)).toBe(false);
    expect(isBotName(undefined)).toBe(false);
    expect(isBotName(42)).toBe(false);
  });
});

describe('ADR 021 D1: personaPathFor and dataDirFor helpers', () => {
  it('personaPathFor returns path ending with bot name + .md', () => {
    for (const name of BOT_NAMES) {
      const p = personaPathFor(name);
      expect(p.endsWith(`${name}.md`)).toBe(true);
    }
  });

  it('personaPathFor includes config/personas directory', () => {
    for (const name of BOT_NAMES) {
      const p = personaPathFor(name);
      expect(p).toContain('personas');
    }
  });

  it('dataDirFor returns path ending with bot name', () => {
    for (const name of BOT_NAMES) {
      const d = dataDirFor(name);
      const last = d.split(/[\\/]/).pop();
      expect(last).toBe(name);
    }
  });

  it('dataDirFor includes data directory', () => {
    for (const name of BOT_NAMES) {
      const d = dataDirFor(name);
      expect(d).toContain('data');
    }
  });
});
