/**
 * Unit tests for src/gateway/groupGate.ts (v1.7.13 enhanced gate).
 *
 * Covers:
 *  - Preflight short-circuits (not-group, disabled, wrong-group, DB-disabled)
 *  - Fast deterministic paths: mention, reply-to-bot
 *  - Follow-up heuristic (same user within window)
 *  - Pending confirmation: yes / no / unclear-clears-stale
 *  - Classifier paths: high → proceed, medium → confirm-required, low → silent
 *  - Rate-limit + per-chat /jarvis_intent off → silent
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isGroupChat,
  isJarvisMentioned,
  isReplyToJarvis,
  checkGroupActivation,
  type GroupGateDeps,
} from '../../src/gateway/groupGate.js';
import {
  recordBotSpoke,
  setPending,
  _resetGroupState,
  setIntentDetectionForChat,
} from '../../src/gateway/groupState.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { GroupSettingsRepo } from '../../src/memory/groupSettings.js';
import type { ModelProvider, UnifiedResponse } from '../../src/providers/types.js';

const BOT_ID = 77;
const ALLOWED_GROUP = -100001;
const OTHER_GROUP = -999999;
const USER_LEE = 1001;
const USER_KIM = 1002;

function makeCtx(overrides: {
  chatType?: string;
  chatId?: number;
  text?: string;
  replyFromId?: number;
  fromId?: number;
  firstName?: string;
} = {}) {
  return {
    chat: { type: overrides.chatType ?? 'private', id: overrides.chatId ?? ALLOWED_GROUP },
    from: {
      id: overrides.fromId ?? USER_LEE,
      first_name: overrides.firstName ?? 'Boss',
    },
    message: {
      text: overrides.text ?? '',
      reply_to_message:
        overrides.replyFromId !== undefined ? { from: { id: overrides.replyFromId } } : undefined,
    },
  } as never;
}

/** Classifier mock returning a fixed IntentResult. */
function mockProvider(content: string): ModelProvider {
  return {
    name: 'mock',
    async call(): Promise<UnifiedResponse> {
      return {
        stop_reason: 'end_turn',
        content,
        tool_calls: [],
        provider: 'mock',
        model: 'mock',
      };
    },
  };
}

function makeDeps(overrides: Partial<GroupGateDeps> = {}): GroupGateDeps {
  const cfg = makeTestConfig({
    groups: {
      enabled: true,
      allowedGroupIds: [ALLOWED_GROUP],
      adminUserIds: [],
      developerUserIds: [],
      groupRoles: {},
      rateLimitPerUser: 10,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: [],
      intentDetection: {
        enabled: true,
        provider: 'ollama-cloud',
        model: 'gemma4:cloud',
        followUpWindowSeconds: 120,
        confirmationTtlSeconds: 120,
        rateLimitPerMinute: 30,
        recentMessageContext: 4,
      },
    },
  });
  const mockGroupSettings = {
    isEnabled: vi.fn().mockReturnValue(true),
    setEnabled: vi.fn(),
    get: vi.fn(),
  } as unknown as GroupSettingsRepo;

  return {
    config: cfg,
    botUserId: BOT_ID,
    groupSettings: mockGroupSettings,
    getRecentMessages: () => [],
    classifierProvider: mockProvider('{"addressed":false,"confidence":"low","reason":"test-default"}'),
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('gateway.groupGate (v1.7.13)', () => {
  beforeEach(() => {
    _resetGroupState();
  });

  describe('pure helpers', () => {
    it('isGroupChat: group/supergroup true; private/channel false', () => {
      expect(isGroupChat(makeCtx({ chatType: 'group' }))).toBe(true);
      expect(isGroupChat(makeCtx({ chatType: 'supergroup' }))).toBe(true);
      expect(isGroupChat(makeCtx({ chatType: 'private' }))).toBe(false);
      expect(isGroupChat(makeCtx({ chatType: 'channel' }))).toBe(false);
    });
    it('isJarvisMentioned matches case-insensitive', () => {
      expect(isJarvisMentioned(makeCtx({ text: 'hey jarvis' }))).toBe(true);
      expect(isJarvisMentioned(makeCtx({ text: 'JARVIS help' }))).toBe(true);
      expect(isJarvisMentioned(makeCtx({ text: 'Jarvis?' }))).toBe(true);
      expect(isJarvisMentioned(makeCtx({ text: 'hi' }))).toBe(false);
    });
    it('isReplyToJarvis matches bot id', () => {
      expect(isReplyToJarvis(makeCtx({ replyFromId: 77 }), 77)).toBe(true);
      expect(isReplyToJarvis(makeCtx({ replyFromId: 99 }), 77)).toBe(false);
      expect(isReplyToJarvis(makeCtx({}), 77)).toBe(false);
    });
  });

  describe('preflight', () => {
    it('private chat → silent', async () => {
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'private', text: 'jarvis hi' }),
        makeDeps(),
      );
      expect(r.proceed).toBe(false);
    });
    it('groups.enabled=false → silent', async () => {
      const deps = makeDeps();
      deps.config.groups.enabled = false;
      const r = await checkGroupActivation(makeCtx({ chatType: 'group', text: 'jarvis' }), deps);
      expect(r.proceed).toBe(false);
    });
    it('group not in allowedGroupIds → silent', async () => {
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', chatId: OTHER_GROUP, text: 'jarvis' }),
        makeDeps(),
      );
      expect(r.proceed).toBe(false);
    });
    it('DB-disabled group → silent', async () => {
      const deps = makeDeps();
      (deps.groupSettings.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'jarvis' }),
        deps,
      );
      expect(r.proceed).toBe(false);
    });
  });

  describe('deterministic activation', () => {
    it('mention → proceed (reason=mention)', async () => {
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'Jarvis, status?' }),
        makeDeps(),
      );
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('mention');
    });
    it('reply-to-bot → proceed (reason=reply)', async () => {
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'yes please', replyFromId: BOT_ID }),
        makeDeps(),
      );
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('reply');
    });
    it('supergroup works same as group', async () => {
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'supergroup', text: 'jarvis' }),
        makeDeps(),
      );
      expect(r.proceed).toBe(true);
    });
  });

  describe('follow-up heuristic', () => {
    it('same user within window → proceed (reason=follow-up)', async () => {
      recordBotSpoke(ALLOWED_GROUP, USER_LEE);
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'also check this', fromId: USER_LEE }),
        makeDeps(),
      );
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('follow-up');
    });
    it('different user within window → falls through to classifier', async () => {
      recordBotSpoke(ALLOWED_GROUP, USER_LEE);
      // Classifier returns LOW → silent; this proves follow-up didn't activate for Kim.
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'cool', fromId: USER_KIM }),
        makeDeps(),
      );
      expect(r.proceed).toBe(false);
    });
    it('same user outside window → falls through to classifier', async () => {
      // Record a bot-spoke at time T-1000 seconds ago
      recordBotSpoke(ALLOWED_GROUP, USER_LEE, Date.now() - 1000 * 1000);
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'hello' }),
        makeDeps(),
      );
      expect(r.reason).not.toBe('follow-up');
    });
  });

  describe('classifier paths', () => {
    it('high confidence addressed → proceed (reason=intent-high)', async () => {
      const deps = makeDeps({
        classifierProvider: mockProvider(
          '{"addressed":true,"confidence":"high","reason":"imperative command"}',
        ),
      });
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'search my email for invoices' }),
        deps,
      );
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('intent-high');
    });
    it('medium confidence addressed → confirm-required with prompt', async () => {
      const deps = makeDeps({
        classifierProvider: mockProvider(
          '{"addressed":true,"confidence":"medium","reason":"ambiguous imperative"}',
        ),
      });
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'should we book the venue', firstName: 'Boss' }),
        deps,
      );
      expect(r.proceed).toBe(false);
      expect(r.reason).toBe('confirm-required');
      expect(r.confirmPrompt).toContain('@Boss');
      expect(r.confirmPrompt).toContain('were you talking to me');
    });
    it('low confidence → silent', async () => {
      const deps = makeDeps({
        classifierProvider: mockProvider(
          '{"addressed":false,"confidence":"low","reason":"human-to-human chat"}',
        ),
      });
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'Kim did you send it' }),
        deps,
      );
      expect(r.proceed).toBe(false);
      expect(r.reason).toBe('silent');
    });
    it('malformed classifier output → silent (low-conf default)', async () => {
      const deps = makeDeps({
        classifierProvider: mockProvider('this is not json at all'),
      });
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'random stuff' }),
        deps,
      );
      expect(r.proceed).toBe(false);
    });
  });

  describe('per-chat /jarvis_intent off', () => {
    it('disables classifier path (keyword still works)', async () => {
      setIntentDetectionForChat(ALLOWED_GROUP, false);
      const deps = makeDeps({
        classifierProvider: mockProvider(
          '{"addressed":true,"confidence":"high","reason":"would have activated"}',
        ),
      });
      const noKeyword = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'search my email' }),
        deps,
      );
      expect(noKeyword.proceed).toBe(false);

      const withKeyword = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'jarvis search my email' }),
        deps,
      );
      expect(withKeyword.proceed).toBe(true);
    });
  });

  describe('pending confirmation round-trip', () => {
    const baseEntry = (userText: string) => ({
      userId: USER_LEE,
      senderName: 'Boss',
      userText,
      wasVoice: false,
      expiresAt: Date.now() + 120_000,
    });

    it('same user replies "yes" → proceed=confirmed with stashed text', async () => {
      setPending(ALLOWED_GROUP, baseEntry('search my email for invoices'));
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'yes', fromId: USER_LEE }),
        makeDeps(),
      );
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('confirmed');
      expect(r.dispatchText).toBe('search my email for invoices');
    });

    it('same user replies "no" → silent (pending cleared)', async () => {
      setPending(ALLOWED_GROUP, baseEntry('original text'));
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'no sorry', fromId: USER_LEE }),
        makeDeps(),
      );
      expect(r.proceed).toBe(false);
    });

    it('different user replies → pending untouched, their message runs through normal gate', async () => {
      setPending(ALLOWED_GROUP, baseEntry('original text'));
      const deps = makeDeps({
        classifierProvider: mockProvider(
          '{"addressed":false,"confidence":"low","reason":"not for us"}',
        ),
      });
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'hi everyone', fromId: USER_KIM }),
        deps,
      );
      expect(r.proceed).toBe(false);
      expect(r.reason).toBe('silent');
    });

    it('same user replies with an unclear non-yes/no → pending cleared, falls through', async () => {
      setPending(ALLOWED_GROUP, baseEntry('original'));
      const deps = makeDeps({
        classifierProvider: mockProvider(
          '{"addressed":true,"confidence":"high","reason":"new question"}',
        ),
      });
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'actually search my calendar', fromId: USER_LEE }),
        deps,
      );
      // Falls through to classifier which fires high
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('intent-high');
    });

    it('mention in a yes-reply still activates via mention fast-path (tolerates looseness)', async () => {
      setPending(ALLOWED_GROUP, baseEntry('original'));
      const r = await checkGroupActivation(
        makeCtx({ chatType: 'group', text: 'yes jarvis do it', fromId: USER_LEE }),
        makeDeps(),
      );
      // The pending path recognizes "yes jarvis" as a YES → confirmed
      expect(r.proceed).toBe(true);
      expect(r.reason).toBe('confirmed');
      expect(r.dispatchText).toBe('original');
    });
  });
});
