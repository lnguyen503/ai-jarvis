/**
 * Unit tests — src/agent/peerMentionNormalizer.ts (v1.21.9).
 *
 * Verifies that fuzzy @-mention variants for peer bots get rewritten to
 * the canonical Telegram username so Telegram delivers them as actual
 * mention entities to the receiving bot.
 */

import { describe, it, expect } from 'vitest';
import { normalizePeerBotMentions } from '../../src/agent/peerMentionNormalizer.js';

describe('normalizePeerBotMentions — Tony variants → @your_tony_bot', () => {
  const cases: Array<[string, string]> = [
    ['@yourTony_bot — ping', '@your_tony_bot — ping'],
    ['hey @yourtonybot let me know', 'hey @your_tony_bot let me know'],
    ['@your_tony_bot what time is it', '@your_tony_bot what time is it'],
    ['@YourTonyBot please review', '@your_tony_bot please review'],
    ['ask @ai-tony for status', 'ask @your_tony_bot for status'],
    ['@aitony quick check', '@your_tony_bot quick check'],
    ['@tony — build status?', '@your_tony_bot — build status?'],
    ['@stark, what do you think?', '@your_tony_bot, what do you think?'],
  ];

  for (const [input, expected] of cases) {
    it(`rewrites: ${input}`, () => {
      expect(normalizePeerBotMentions(input)).toBe(expected);
    });
  }
});

describe('normalizePeerBotMentions — Jarvis variants → @your_jarvis_bot', () => {
  const cases: Array<[string, string]> = [
    ['@YourJarvisBot heads up', '@your_jarvis_bot heads up'],
    ['@yourjarvisbot — calendar?', '@your_jarvis_bot — calendar?'],
    ['@jarvis can you check', '@your_jarvis_bot can you check'],
    ['@your_jarvis_bot already canonical', '@your_jarvis_bot already canonical'],
    ['ask @ai-jarvis to schedule it', 'ask @your_jarvis_bot to schedule it'],
  ];

  for (const [input, expected] of cases) {
    it(`rewrites: ${input}`, () => {
      expect(normalizePeerBotMentions(input)).toBe(expected);
    });
  }
});

describe('normalizePeerBotMentions — leaves unrelated @-mentions alone', () => {
  it('leaves non-bot @-mentions unchanged', () => {
    expect(normalizePeerBotMentions('cc @Boss for awareness')).toBe('cc @Boss for awareness');
    expect(normalizePeerBotMentions('thanks @rhodey')).toBe('thanks @rhodey');
    expect(normalizePeerBotMentions('@some_random_bot beep')).toBe('@some_random_bot beep');
  });

  it('leaves email-like @ patterns alone if they look like emails', () => {
    // The regex matches @\w+ which doesn't span across "." in emails,
    // so the user part of an email might match. Verify behavior.
    const result = normalizePeerBotMentions('contact me at Boss@example.com');
    // 'example' isn't a known bot identifier → unchanged
    expect(result).toBe('contact me at Boss@example.com');
  });

  it('handles multiple mentions in one message', () => {
    const input = 'cc @aitony and @jarvis on this';
    const expected = 'cc @your_tony_bot and @your_jarvis_bot on this';
    expect(normalizePeerBotMentions(input)).toBe(expected);
  });

  it('skips bots without deployed Telegram usernames', () => {
    // ai-natasha and ai-bruce have BOT_TELEGRAM_USERNAMES = ''. Their
    // aliases match in the lookup ONLY if a canonical exists. Since it
    // doesn't, the @-handle stays as-is. (When BotFather names land,
    // update BOT_TELEGRAM_USERNAMES and these become normalizable.)
    const input = '@natasha please look into this';
    expect(normalizePeerBotMentions(input)).toBe('@natasha please look into this');
  });

  it('returns empty string unchanged', () => {
    expect(normalizePeerBotMentions('')).toBe('');
  });

  it('returns text without any @-mentions unchanged', () => {
    expect(normalizePeerBotMentions('plain text only')).toBe('plain text only');
  });
});
