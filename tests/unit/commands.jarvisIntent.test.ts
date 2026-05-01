/**
 * Tests for /jarvis_intent command.
 * Mirrors the /calendar test structure — per-chat in-memory toggle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isIntentDetectionEnabledForChat,
  _resetGroupState,
} from '../../src/gateway/groupState.js';
import { handleJarvisIntent } from '../../src/commands/jarvisIntent.js';

interface MockCtx {
  chat?: { id: number };
  message?: { text?: string };
  replies: string[];
  reply: (msg: string) => Promise<void>;
}

function makeCtx(chatId: number, text: string): MockCtx {
  const ctx: MockCtx = {
    chat: { id: chatId },
    message: { text },
    replies: [],
    reply: async (msg: string) => {
      ctx.replies.push(msg);
    },
  };
  return ctx;
}

describe('/jarvis_intent command', () => {
  beforeEach(() => _resetGroupState());

  it('shows ON by default when called without args', async () => {
    const ctx = makeCtx(-100001, '/jarvis_intent');
    await handleJarvisIntent(ctx as never);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Intent detection: ON');
  });

  it('/jarvis_intent off disables the chat', async () => {
    const ctx = makeCtx(-100001, '/jarvis_intent off');
    await handleJarvisIntent(ctx as never);
    expect(isIntentDetectionEnabledForChat(-100001)).toBe(false);
    expect(ctx.replies[0]).toContain('disabled');
  });

  it('/jarvis_intent on re-enables the chat', async () => {
    const off = makeCtx(-100001, '/jarvis_intent off');
    await handleJarvisIntent(off as never);
    const on = makeCtx(-100001, '/jarvis_intent on');
    await handleJarvisIntent(on as never);
    expect(isIntentDetectionEnabledForChat(-100001)).toBe(true);
    expect(on.replies[0]).toContain('enabled');
  });

  it('per-chat isolation: toggling A does not affect B', async () => {
    const offA = makeCtx(-100001, '/jarvis_intent off');
    await handleJarvisIntent(offA as never);
    expect(isIntentDetectionEnabledForChat(-100001)).toBe(false);
    expect(isIntentDetectionEnabledForChat(-100002)).toBe(true);
  });

  it('status command after off reports OFF', async () => {
    const off = makeCtx(-100001, '/jarvis_intent off');
    await handleJarvisIntent(off as never);
    const status = makeCtx(-100001, '/jarvis_intent');
    await handleJarvisIntent(status as never);
    expect(status.replies[0]).toContain('Intent detection: OFF');
  });

  it('invalid arg → usage message', async () => {
    const ctx = makeCtx(-100001, '/jarvis_intent wat');
    await handleJarvisIntent(ctx as never);
    expect(ctx.replies[0]).toContain('Usage:');
  });

  it('accepts enable/disable/true/false aliases', async () => {
    const disable = makeCtx(-1, '/jarvis_intent disable');
    await handleJarvisIntent(disable as never);
    expect(isIntentDetectionEnabledForChat(-1)).toBe(false);

    const enable = makeCtx(-1, '/jarvis_intent enable');
    await handleJarvisIntent(enable as never);
    expect(isIntentDetectionEnabledForChat(-1)).toBe(true);

    const falseArg = makeCtx(-2, '/jarvis_intent false');
    await handleJarvisIntent(falseArg as never);
    expect(isIntentDetectionEnabledForChat(-2)).toBe(false);

    const trueArg = makeCtx(-2, '/jarvis_intent true');
    await handleJarvisIntent(trueArg as never);
    expect(isIntentDetectionEnabledForChat(-2)).toBe(true);
  });

  it('missing chat id is a no-op', async () => {
    const ctx: MockCtx = { replies: [], reply: async (m) => { ctx.replies.push(m); } };
    await handleJarvisIntent(ctx as never);
    expect(ctx.replies).toHaveLength(0);
  });
});
