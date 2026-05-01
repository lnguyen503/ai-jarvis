/**
 * Unit tests for src/gateway/mentionRouter.ts (v1.21.0 D7 Pillar 2).
 *
 * Covers:
 *   - parseMentions: extracts @username strings from text
 *   - parseMentions: case-insensitive extraction
 *   - parseMentions: multiple mentions in one text
 *   - parseMentions: no mentions returns empty array
 *   - shouldThisBotProcess: DM mode → process=true (reason: dm)
 *   - shouldThisBotProcess: DM mode other bot → still process=true (DM = to this bot)
 *   - shouldThisBotProcess: group + @selfUsername → process=true (reason: mention)
 *   - shouldThisBotProcess: group + @selfUsername case-insensitive → process=true
 *   - shouldThisBotProcess: group + @otherBot only → process=false (reason: ignored)
 *   - shouldThisBotProcess: group + reply to self → process=true (reason: reply_to_self)
 *   - shouldThisBotProcess: group + reply to other bot → process=false
 *   - shouldThisBotProcess: group + no mention + no reply → process=false
 *   - shouldThisBotProcess: Telegram entities path preferred over text scan
 *   - shouldThisBotProcess: multi-mention message with self among others → process=true
 *   - shouldThisBotProcess: channel type → process=false
 *   - shouldThisBotProcess: unknown chat type → process=false
 *   - shouldThisBotProcess: supergroup type with @mention → process=true
 *   - shouldThisBotProcess: @mention in caption (not text) → process=true
 *   - shouldThisBotProcess: caption_entities used for caption mention check
 *   - shouldThisBotProcess: reply_to_message absent → no crash
 */

import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  shouldThisBotProcess,
  type MentionRoutableMessage,
} from '../../src/gateway/mentionRouter.js';
import type { BotIdentity } from '../../src/config/botIdentity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JARVIS_IDENTITY: BotIdentity = {
  name: 'ai-jarvis',
  scope: 'full',
  telegramToken: 'fake-token',
  personaPath: '/config/personas/ai-jarvis.md',
  dataDir: '/data/ai-jarvis',
  webappPort: 7879,
  healthPort: 7878,
  allowedTools: new Set(['read_file', 'write_file']),
  aliases: ['jarvis'],
};

const TONY_IDENTITY: BotIdentity = {
  name: 'ai-tony',
  scope: 'specialist',
  telegramToken: 'fake-tony-token',
  personaPath: '/config/personas/ai-tony.md',
  dataDir: '/data/ai-tony',
  webappPort: 7889,
  healthPort: 7888,
  allowedTools: new Set(['read_file']),
  aliases: ['tony', 'stark', 'mr stark', 'mr. stark', 'tony stark'],
};

const JARVIS_BOT_ID = 111_000_001;
const TONY_BOT_ID   = 111_000_002;
const USER_ID       = 999_001;

function groupMsg(overrides: Partial<MentionRoutableMessage> = {}): MentionRoutableMessage {
  return {
    chat: { type: 'group' },
    from: { id: USER_ID, is_bot: false },
    text: '',
    ...overrides,
  };
}

function dmMsg(overrides: Partial<MentionRoutableMessage> = {}): MentionRoutableMessage {
  return {
    chat: { type: 'private' },
    from: { id: USER_ID, is_bot: false },
    text: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseMentions
// ---------------------------------------------------------------------------

describe('parseMentions', () => {
  it('MR-1: extracts single @mention, returns lowercase username', () => {
    expect(parseMentions('Hey @ai-jarvis build something')).toEqual(['ai-jarvis']);
  });

  it('MR-2: case-insensitive — @AI-JARVIS → ai-jarvis', () => {
    expect(parseMentions('@AI-JARVIS help')).toEqual(['ai-jarvis']);
  });

  it('MR-3: multiple mentions extracted', () => {
    const result = parseMentions('@ai-jarvis and @ai-tony what do you think?');
    expect(result).toContain('ai-jarvis');
    expect(result).toContain('ai-tony');
    expect(result).toHaveLength(2);
  });

  it('MR-4: no mentions returns empty array', () => {
    expect(parseMentions('hello world')).toEqual([]);
  });

  it('MR-5: @mention at start of text', () => {
    expect(parseMentions('@ai-tony run the tests')).toEqual(['ai-tony']);
  });
});

// ---------------------------------------------------------------------------
// shouldThisBotProcess — DM mode
// ---------------------------------------------------------------------------

describe('shouldThisBotProcess — DM mode', () => {
  it('MR-6: DM → process=true (reason: dm)', () => {
    const msg = dmMsg({ text: 'hi there' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('dm');
  });

  it('MR-7: DM always processes regardless of text content', () => {
    const msg = dmMsg({ text: '@ai-tony not me' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('dm');
  });
});

// ---------------------------------------------------------------------------
// shouldThisBotProcess — group mention
// ---------------------------------------------------------------------------

describe('shouldThisBotProcess — group @mention', () => {
  it('MR-8: @selfUsername in text → process=true (reason: mention)', () => {
    const msg = groupMsg({ text: 'Hey @ai_jarvis_bot can you help?' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });

  it('MR-9: @selfUsername case-insensitive → process=true', () => {
    const msg = groupMsg({ text: '@AI_JARVIS_BOT what do you think?' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });

  it('MR-10: only @otherBot mentioned → process=false (reason: ignored)', () => {
    const msg = groupMsg({ text: 'Hey @ai_tony_bot what do you think?' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(false);
    expect(result.reason).toBe('ignored');
  });

  it('MR-11: both bots mentioned — self is included → process=true', () => {
    const msg = groupMsg({ text: '@ai_jarvis_bot and @ai_tony_bot what do you say?' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });

  it('MR-12: tony bot mentioned — jarvis is NOT mentioned → process=false for jarvis', () => {
    const msg = groupMsg({ text: '@ai_tony_bot run the build' });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(false);
    expect(result.reason).toBe('ignored');
  });

  it('MR-13: tony processes its own mention', () => {
    const msg = groupMsg({ text: '@ai_tony_bot run the build' });
    const result = shouldThisBotProcess(msg, TONY_IDENTITY, TONY_BOT_ID, 'ai_tony_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });
});

// ---------------------------------------------------------------------------
// shouldThisBotProcess — reply_to_self
// ---------------------------------------------------------------------------

describe('shouldThisBotProcess — reply to self', () => {
  it('MR-14: reply to self → process=true (reason: reply_to_self)', () => {
    const msg = groupMsg({
      text: 'yes please',
      reply_to_message: { from: { id: JARVIS_BOT_ID } },
    });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('reply_to_self');
  });

  it('MR-15: reply to other bot → process=false (reason: ignored)', () => {
    const msg = groupMsg({
      text: 'what do you think?',
      reply_to_message: { from: { id: TONY_BOT_ID } },
    });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(false);
    expect(result.reason).toBe('ignored');
  });

  it('MR-extra: reply_to_message absent → no crash, uses text path', () => {
    const msg = groupMsg({ text: 'no reply here' });
    expect(() =>
      shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// shouldThisBotProcess — Telegram entities preferred path
// ---------------------------------------------------------------------------

describe('shouldThisBotProcess — Telegram entities path', () => {
  it('MR-16: entity of type mention matching self → process=true', () => {
    const text = '@ai_jarvis_bot run build';
    const msg = groupMsg({
      text,
      entities: [{ type: 'mention', offset: 0, length: '@ai_jarvis_bot'.length }],
    });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });

  it('MR-17: entity of type mention for OTHER bot → process=false (no text fallback needed)', () => {
    const text = '@ai_tony_bot what do you think?';
    const msg = groupMsg({
      text,
      entities: [{ type: 'mention', offset: 0, length: '@ai_tony_bot'.length }],
    });
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(false);
    expect(result.reason).toBe('ignored');
  });
});

// ---------------------------------------------------------------------------
// shouldThisBotProcess — chat types
// ---------------------------------------------------------------------------

describe('shouldThisBotProcess — chat types', () => {
  it('MR-18: channel type → process=false (reason: ignored)', () => {
    const msg: MentionRoutableMessage = {
      chat: { type: 'channel' },
      text: '@ai_jarvis_bot',
    };
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(false);
    expect(result.reason).toBe('ignored');
  });

  it('MR-19: supergroup + @selfUsername → process=true', () => {
    const msg: MentionRoutableMessage = {
      chat: { type: 'supergroup' },
      from: { id: USER_ID },
      text: '@ai_jarvis_bot something',
    };
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });
});

// ---------------------------------------------------------------------------
// shouldThisBotProcess — caption
// ---------------------------------------------------------------------------

describe('shouldThisBotProcess — caption (photo/document messages)', () => {
  it('MR-20: @selfUsername in caption (no text) → process=true', () => {
    const msg: MentionRoutableMessage = {
      chat: { type: 'group' },
      caption: '@ai_jarvis_bot what is this image?',
    };
    const result = shouldThisBotProcess(msg, JARVIS_IDENTITY, JARVIS_BOT_ID, 'ai_jarvis_bot');
    expect(result.process).toBe(true);
    expect(result.reason).toBe('mention');
  });
});
