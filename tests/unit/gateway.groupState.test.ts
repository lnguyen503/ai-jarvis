/**
 * Unit tests for src/gateway/groupState.ts — in-memory ephemeral state that
 * drives the v1.7.13 follow-up heuristic, pending confirmation UX, classifier
 * rate limiter, and per-chat /jarvis_intent toggle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordBotSpoke,
  getBotSpoke,
  isFollowUpFromSameUser,
  setPending,
  getPending,
  clearPending,
  interpretConfirmationResponse,
  tryRateLimit,
  isIntentDetectionEnabledForChat,
  setIntentDetectionForChat,
  _resetGroupState,
} from '../../src/gateway/groupState.js';

const CHAT = -100001;
const OTHER_CHAT = -100002;
const Boss = 1001;
const KIM = 1002;

describe('gateway.groupState', () => {
  beforeEach(() => _resetGroupState());

  describe('recordBotSpoke / getBotSpoke', () => {
    it('stores and retrieves the last bot-spoke record per chat', () => {
      recordBotSpoke(CHAT, Boss, 1000);
      expect(getBotSpoke(CHAT)).toEqual({ at: 1000, addressedUserId: Boss });
      expect(getBotSpoke(OTHER_CHAT)).toBeUndefined();
    });
    it('overwrites on repeat call', () => {
      recordBotSpoke(CHAT, Boss, 1000);
      recordBotSpoke(CHAT, KIM, 2000);
      expect(getBotSpoke(CHAT)).toEqual({ at: 2000, addressedUserId: KIM });
    });
  });

  describe('isFollowUpFromSameUser', () => {
    it('true when same user within window', () => {
      recordBotSpoke(CHAT, Boss, 1000);
      expect(isFollowUpFromSameUser(CHAT, Boss, 60, 50000)).toBe(true);
    });
    it('false when different user', () => {
      recordBotSpoke(CHAT, Boss, 1000);
      expect(isFollowUpFromSameUser(CHAT, KIM, 60, 50000)).toBe(false);
    });
    it('false when outside window', () => {
      recordBotSpoke(CHAT, Boss, 1000);
      expect(isFollowUpFromSameUser(CHAT, Boss, 60, 1000 + 61_000)).toBe(false);
    });
    it('false when no record exists', () => {
      expect(isFollowUpFromSameUser(CHAT, Boss, 60, 50000)).toBe(false);
    });
    it('true at exact window boundary', () => {
      recordBotSpoke(CHAT, Boss, 1000);
      expect(isFollowUpFromSameUser(CHAT, Boss, 60, 1000 + 60_000)).toBe(true);
    });
  });

  describe('pending confirmation', () => {
    const entry = (overrides: Partial<Parameters<typeof setPending>[1]> = {}) => ({
      userId: Boss,
      senderName: 'Boss',
      userText: 'search my email',
      wasVoice: false,
      expiresAt: Date.now() + 60_000,
      ...overrides,
    });

    it('set/get round-trip', () => {
      setPending(CHAT, entry());
      expect(getPending(CHAT)?.userText).toBe('search my email');
    });

    it('expired entry returns undefined and auto-clears', () => {
      setPending(CHAT, entry({ expiresAt: Date.now() - 1 }));
      expect(getPending(CHAT)).toBeUndefined();
      // second read also undefined — proves auto-clear
      expect(getPending(CHAT)).toBeUndefined();
    });

    it('clearPending removes entry', () => {
      setPending(CHAT, entry());
      clearPending(CHAT);
      expect(getPending(CHAT)).toBeUndefined();
    });
  });

  describe('interpretConfirmationResponse', () => {
    beforeEach(() => {
      setPending(CHAT, {
        userId: Boss,
        senderName: 'Boss',
        userText: 'orig',
        wasVoice: false,
        expiresAt: Date.now() + 60_000,
      });
    });

    it('recognizes yes variants', () => {
      expect(interpretConfirmationResponse(CHAT, Boss, 'yes')).toBe('yes');
      expect(interpretConfirmationResponse(CHAT, Boss, 'y')).toBe('yes');
      expect(interpretConfirmationResponse(CHAT, Boss, 'yep do it')).toBe('yes');
      expect(interpretConfirmationResponse(CHAT, Boss, 'sure please')).toBe('yes');
      expect(interpretConfirmationResponse(CHAT, Boss, 'ok')).toBe('yes');
    });

    it('recognizes no variants', () => {
      expect(interpretConfirmationResponse(CHAT, Boss, 'no')).toBe('no');
      expect(interpretConfirmationResponse(CHAT, Boss, 'nope')).toBe('no');
      expect(interpretConfirmationResponse(CHAT, Boss, 'nah, never mind')).toBe('no');
      expect(interpretConfirmationResponse(CHAT, Boss, 'not you')).toBe('no');
      expect(interpretConfirmationResponse(CHAT, Boss, 'nvm')).toBe('no');
    });

    it('"jarvis" anywhere in the reply counts as yes', () => {
      expect(interpretConfirmationResponse(CHAT, Boss, 'yes jarvis, do it')).toBe('yes');
      expect(interpretConfirmationResponse(CHAT, Boss, 'hey jarvis I meant this')).toBe('yes');
    });

    it('unclear prose → unclear', () => {
      expect(interpretConfirmationResponse(CHAT, Boss, 'actually different question')).toBe('unclear');
    });

    it('different user → null (not their confirmation to answer)', () => {
      expect(interpretConfirmationResponse(CHAT, KIM, 'yes')).toBeNull();
    });

    it('no pending → null', () => {
      clearPending(CHAT);
      expect(interpretConfirmationResponse(CHAT, Boss, 'yes')).toBeNull();
    });
  });

  describe('tryRateLimit', () => {
    it('allows up to the cap within a minute then blocks', () => {
      for (let i = 0; i < 3; i++) {
        expect(tryRateLimit(CHAT, 3, 1000 + i)).toBe(true);
      }
      expect(tryRateLimit(CHAT, 3, 1500)).toBe(false);
    });
    it('separate chats have separate buckets', () => {
      for (let i = 0; i < 3; i++) tryRateLimit(CHAT, 3, 1000);
      expect(tryRateLimit(CHAT, 3, 1500)).toBe(false);
      expect(tryRateLimit(OTHER_CHAT, 3, 1500)).toBe(true);
    });
    it('bucket rolls forward as old timestamps age out', () => {
      for (let i = 0; i < 3; i++) tryRateLimit(CHAT, 3, 1000);
      expect(tryRateLimit(CHAT, 3, 1500)).toBe(false);
      // 61s later the original 3 have aged out
      expect(tryRateLimit(CHAT, 3, 1000 + 61_000)).toBe(true);
    });
  });

  describe('per-chat intent toggle', () => {
    it('defaults to enabled', () => {
      expect(isIntentDetectionEnabledForChat(CHAT)).toBe(true);
    });
    it('set off → disabled for that chat only', () => {
      setIntentDetectionForChat(CHAT, false);
      expect(isIntentDetectionEnabledForChat(CHAT)).toBe(false);
      expect(isIntentDetectionEnabledForChat(OTHER_CHAT)).toBe(true);
    });
    it('set on re-enables', () => {
      setIntentDetectionForChat(CHAT, false);
      setIntentDetectionForChat(CHAT, true);
      expect(isIntentDetectionEnabledForChat(CHAT)).toBe(true);
    });
  });
});
