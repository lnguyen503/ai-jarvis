/**
 * Unit tests — alias matching in src/gateway/mentionRouter.ts (v1.21.3).
 *
 * BotIdentity now carries `aliases: readonly string[]`. In group chats, after
 * the @-mention check fails, the router scans the message text for any alias
 * with whole-word case-insensitive matching. Multi-word aliases handle
 * flexible whitespace; alias dots ("mr.") become optional.
 */

import { describe, it, expect } from 'vitest';
import { isAliasMatched, shouldThisBotProcess } from '../../src/gateway/mentionRouter.js';
import type { BotIdentity } from '../../src/config/botIdentity.js';

const TONY: BotIdentity = {
  name: 'ai-tony',
  scope: 'specialist',
  telegramToken: 't',
  personaPath: '/p/ai-tony.md',
  dataDir: '/d/ai-tony',
  webappPort: 7889,
  healthPort: 7888,
  allowedTools: new Set(),
  aliases: ['tony', 'stark', 'mr stark', 'mr. stark', 'tony stark'],
};

const JARVIS: BotIdentity = {
  name: 'ai-jarvis',
  scope: 'full',
  telegramToken: 't',
  personaPath: '/p/ai-jarvis.md',
  dataDir: '/d/ai-jarvis',
  webappPort: 7879,
  healthPort: 7878,
  allowedTools: new Set(),
  aliases: ['jarvis'],
};

const NATASHA: BotIdentity = {
  name: 'ai-natasha',
  scope: 'specialist',
  telegramToken: 't',
  personaPath: '/p/ai-natasha.md',
  dataDir: '/d/ai-natasha',
  webappPort: 7899,
  healthPort: 7898,
  allowedTools: new Set(),
  aliases: ['natasha', 'romanoff', 'widow', 'black widow'],
};

const BRUCE: BotIdentity = {
  name: 'ai-bruce',
  scope: 'specialist',
  telegramToken: 't',
  personaPath: '/p/ai-bruce.md',
  dataDir: '/d/ai-bruce',
  webappPort: 7909,
  healthPort: 7908,
  allowedTools: new Set(),
  aliases: ['bruce', 'banner', 'hulk', 'dr banner', 'dr. banner'],
};

describe('isAliasMatched — single-word aliases', () => {
  it('matches a whole word case-insensitively', () => {
    expect(isAliasMatched('Tony, ping', ['tony'])).toBe(true);
    expect(isAliasMatched('TONY!', ['tony'])).toBe(true);
    expect(isAliasMatched('hey tony', ['tony'])).toBe(true);
  });

  it('does not match substring of a larger word', () => {
    expect(isAliasMatched('stony beach', ['tony'])).toBe(false);
    expect(isAliasMatched('tonysoprano', ['tony'])).toBe(false);
  });

  it('returns false on empty text or empty alias list', () => {
    expect(isAliasMatched('', ['tony'])).toBe(false);
    expect(isAliasMatched('tony', [])).toBe(false);
  });
});

describe('isAliasMatched — multi-word aliases with optional dots', () => {
  it('matches "Mr. Stark" with the dotted alias', () => {
    expect(isAliasMatched('Mr. Stark, status?', ['mr. stark'])).toBe(true);
  });

  it('matches "Mr Stark" (no dot) against the dotted alias', () => {
    expect(isAliasMatched('Mr Stark, status?', ['mr. stark'])).toBe(true);
  });

  it('matches with extra whitespace between words', () => {
    expect(isAliasMatched('Mr.  Stark!', ['mr. stark'])).toBe(true);
  });

  it('matches "tony stark" multi-word alias', () => {
    expect(isAliasMatched('what does tony stark think?', ['tony stark'])).toBe(true);
  });
});

describe('isAliasMatched — multiple aliases', () => {
  it('matches if any alias hits', () => {
    const aliases = ['tony', 'stark', 'mr stark'];
    expect(isAliasMatched('hey stark', aliases)).toBe(true);
    expect(isAliasMatched('Mr Stark', aliases)).toBe(true);
    expect(isAliasMatched('Tony!', aliases)).toBe(true);
  });

  it('returns false when no alias matches', () => {
    const aliases = ['tony', 'stark'];
    expect(isAliasMatched('hello world', aliases)).toBe(false);
    expect(isAliasMatched('starks of winterfell', aliases)).toBe(false);
  });
});

describe('shouldThisBotProcess — alias activation in groups', () => {
  const groupMsg = (text: string) => ({
    chat: { type: 'group' as const },
    from: { id: 100, is_bot: false },
    text,
  });

  it("ai-jarvis (orchestrator) processes 'jarvis' in a group message", () => {
    const r = shouldThisBotProcess(groupMsg('jarvis, what\'s on my calendar?'), JARVIS, 111, 'your_jarvis_bot');
    expect(r.process).toBe(true);
    expect(r.reason).toBe('alias');
  });

  it("v1.22.17: specialists DO respond to their aliases in groups when orchestrator alias is absent", () => {
    expect(shouldThisBotProcess(groupMsg('tony, run the build'), TONY, 222, 'your_tony_bot').process).toBe(true);
    expect(shouldThisBotProcess(groupMsg('Mr. Stark — status'), TONY, 222, 'your_tony_bot').process).toBe(true);
    expect(shouldThisBotProcess(groupMsg('natasha what\'s up'), NATASHA, 333, 'natasha_bot').process).toBe(true);
    expect(shouldThisBotProcess(groupMsg('banner walk me through'), BRUCE, 444, 'bruce_bot').process).toBe(true);
  });

  it("v1.22.17: specialists DEFER to orchestrator when both aliases are present", () => {
    // 'jarvis ask tony to run X' — Jarvis fires (orchestrator priority); Tony stays silent and
    // waits for the explicit @-mention that Jarvis posts via delegate_to_specialist.
    expect(shouldThisBotProcess(groupMsg('jarvis, ask tony to run the build'), TONY, 222, 'your_tony_bot').process).toBe(false);
    expect(shouldThisBotProcess(groupMsg('jarvis, have natasha look this up'), NATASHA, 333, 'natasha_bot').process).toBe(false);
    expect(shouldThisBotProcess(groupMsg('jarvis tell bruce to calculate it'), BRUCE, 444, 'bruce_bot').process).toBe(false);
  });

  it("ai-jarvis ignores 'tony' in a group (specialist alias, not its own)", () => {
    const r = shouldThisBotProcess(groupMsg('tony, run the build'), JARVIS, 111, 'your_jarvis_bot');
    expect(r.process).toBe(false);
    expect(r.reason).toBe('ignored');
  });

  it('orchestrator alias does NOT match inside a different word', () => {
    const r = shouldThisBotProcess(groupMsg('an envious driver'), JARVIS, 111, 'your_jarvis_bot');
    expect(r.process).toBe(false);
  });

  it("@-mention beats alias for reason; both still process", () => {
    const text = '@your_tony_bot tony, ping';
    const r = shouldThisBotProcess(
      { ...groupMsg(text), entities: [{ type: 'mention', offset: 0, length: 19 }] },
      TONY,
      222,
      'your_tony_bot',
    );
    expect(r.process).toBe(true);
    expect(r.reason).toBe('mention');
  });

  it("DMs always process regardless of alias presence", () => {
    const dmMsg = { chat: { type: 'private' as const }, from: { id: 100 }, text: 'hi' };
    const r = shouldThisBotProcess(dmMsg, TONY, 222, 'your_tony_bot');
    expect(r.process).toBe(true);
    expect(r.reason).toBe('dm');
  });
});

describe('shouldThisBotProcess — alias rules (v1.22.17)', () => {
  const groupMsg = (text: string) => ({
    chat: { type: 'group' as const },
    from: { id: 100, is_bot: false },
    text,
  });

  it('orchestrator (full scope) responds to its alias in groups', () => {
    const r = shouldThisBotProcess(
      groupMsg('jarvis check the build'),
      JARVIS, 111, 'your_jarvis_bot',
    );
    expect(r.process).toBe(true);
    expect(r.reason).toBe('alias');
  });

  it('specialist responds to its alias in groups (v1.22.17)', () => {
    const r = shouldThisBotProcess(
      groupMsg('tony, run the build'),
      TONY, 222, 'your_tony_bot',
    );
    expect(r.process).toBe(true);
    expect(r.reason).toBe('alias');
  });

  it('specialist defers when orchestrator alias is also present (v1.22.17)', () => {
    const r = shouldThisBotProcess(
      groupMsg('jarvis, ask tony to run the build'),
      TONY, 222, 'your_tony_bot',
    );
    expect(r.process).toBe(false);
    expect(r.reason).toBe('ignored');
  });

  it('specialist responds to explicit @-mention in groups', () => {
    const r = shouldThisBotProcess(
      {
        chat: { type: 'group' as const },
        from: { id: 100, is_bot: false },
        text: '@your_tony_bot run the build',
        entities: [{ type: 'mention', offset: 0, length: 19 }],
      },
      TONY, 222, 'your_tony_bot',
    );
    expect(r.process).toBe(true);
    expect(r.reason).toBe('mention');
  });

  it('specialist still processes DMs regardless of alias', () => {
    const dmMsg = { chat: { type: 'private' as const }, from: { id: 100 }, text: 'hi' };
    const r = shouldThisBotProcess(dmMsg, TONY, 222, 'your_tony_bot');
    expect(r.process).toBe(true);
    expect(r.reason).toBe('dm');
  });

  it('orchestrator ignores when only a specialist alias appears', () => {
    const r = shouldThisBotProcess(
      groupMsg('tony, run the build'),
      JARVIS, 111, 'your_jarvis_bot',
    );
    expect(r.process).toBe(false);
    expect(r.reason).toBe('ignored');
  });
});

describe('alias closed-set discipline', () => {
  it('Tony aliases do not collide with other bots', () => {
    for (const a of TONY.aliases) {
      expect(JARVIS.aliases).not.toContain(a);
      expect(NATASHA.aliases).not.toContain(a);
      expect(BRUCE.aliases).not.toContain(a);
    }
  });

  it('Natasha aliases do not collide with other bots', () => {
    for (const a of NATASHA.aliases) {
      expect(JARVIS.aliases).not.toContain(a);
      expect(TONY.aliases).not.toContain(a);
      expect(BRUCE.aliases).not.toContain(a);
    }
  });

  it('Bruce aliases do not collide with other bots', () => {
    for (const a of BRUCE.aliases) {
      expect(JARVIS.aliases).not.toContain(a);
      expect(TONY.aliases).not.toContain(a);
      expect(NATASHA.aliases).not.toContain(a);
    }
  });
});
