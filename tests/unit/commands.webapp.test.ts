/**
 * /webapp command handler tests (v1.13.0).
 *
 * Covers:
 *  - DM with empty publicUrl → "isn't configured yet"
 *  - DM with valid HTTPS URL → calls adapter.sendWebAppButton with correct args
 *  - DM with HTTP URL → "must be HTTPS" reply; NO sendWebAppButton call
 *  - Group chat → "DM-only" reply; NO sendWebAppButton call
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import { handleWebApp } from '../../src/commands/webapp.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { MessagingAdapter } from '../../src/messaging/adapter.js';

const USER_ID = 42;
const CHAT_ID = 42; // DM: chatId === userId

function makeCtx(
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup' = 'private',
): Context {
  return {
    from: { id: USER_ID, is_bot: false, first_name: 'TestUser' },
    chat: {
      id: chatId,
      type: chatType,
      title: chatType !== 'private' ? 'TestGroup' : undefined,
    },
    reply: vi.fn().mockResolvedValue(undefined),
    message: { text: '/webapp' },
  } as unknown as Context;
}

function makeMockAdapter(): MessagingAdapter {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 1 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ messageId: 2 }),
    sendPhoto: vi.fn().mockResolvedValue({ messageId: 3 }),
    sendVoice: vi.fn().mockResolvedValue({ messageId: 4 }),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    resolveDmChatId: vi.fn().mockReturnValue(null),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    sendWebAppButton: vi.fn().mockResolvedValue({ messageId: 5 }),
  };
}

describe('commands.webapp', () => {
  let adapter: MessagingAdapter;

  beforeEach(() => {
    adapter = makeMockAdapter();
  });

  it('DM with empty publicUrl → replies with setup guidance', async () => {
    const config = makeTestConfig();
    // webapp.publicUrl defaults to '' in schema
    const ctx = makeCtx(CHAT_ID, 'private');
    await handleWebApp(ctx, { config, adapter });

    expect(ctx.reply).toHaveBeenCalledOnce();
    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toContain("isn't configured yet");
    expect(adapter.sendWebAppButton).not.toHaveBeenCalled();
  });

  it('DM with valid HTTPS publicUrl → calls sendWebAppButton with correct args', async () => {
    const httpsUrl = 'https://abc123.trycloudflare.com';
    const config = makeTestConfig();
    // Override the webapp.publicUrl field
    (config as Record<string, unknown>).webapp = {
      publicUrl: httpsUrl,
      port: 7879,
      staticDir: 'public/webapp',
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
    };

    const ctx = makeCtx(CHAT_ID, 'private');
    await handleWebApp(ctx, { config, adapter });

    expect(adapter.sendWebAppButton).toHaveBeenCalledOnce();
    const [calledChatId, calledText, calledLabel, calledUrl] = (
      adapter.sendWebAppButton as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [number, string, string, string];

    expect(calledChatId).toBe(CHAT_ID);
    expect(calledText).toBe('Open Jarvis Web App');
    expect(calledLabel).toBe('🚀 Open');
    // v1.13.1: command appends /webapp/ so the button opens the static page
    // (express.static is mounted at /webapp/*; root falls through to 404).
    expect(calledUrl).toBe(`${httpsUrl}/webapp/`);
    // ctx.reply should NOT have been called (success path = no extra reply)
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('DM with HTTP publicUrl → replies with "must be HTTPS"; no sendWebAppButton', async () => {
    const httpUrl = 'http://example.com/webapp';
    const config = makeTestConfig();
    (config as Record<string, unknown>).webapp = {
      publicUrl: httpUrl,
      port: 7879,
      staticDir: 'public/webapp',
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
    };

    const ctx = makeCtx(CHAT_ID, 'private');
    await handleWebApp(ctx, { config, adapter });

    expect(ctx.reply).toHaveBeenCalledOnce();
    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toContain('must be HTTPS');
    expect(adapter.sendWebAppButton).not.toHaveBeenCalled();
  });

  it('Group chat → replies "DM-only"; no sendWebAppButton call', async () => {
    const GROUP_CHAT_ID = -100123456;
    const config = makeTestConfig();
    (config as Record<string, unknown>).webapp = {
      publicUrl: 'https://valid.trycloudflare.com',
      port: 7879,
      staticDir: 'public/webapp',
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
    };

    const ctx = makeCtx(GROUP_CHAT_ID, 'group');
    await handleWebApp(ctx, { config, adapter });

    expect(ctx.reply).toHaveBeenCalledOnce();
    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toContain('DM-only');
    expect(adapter.sendWebAppButton).not.toHaveBeenCalled();
  });

  it('Group supergroup → same DM-only rejection', async () => {
    const GROUP_CHAT_ID = -100123456;
    const config = makeTestConfig();
    (config as Record<string, unknown>).webapp = {
      publicUrl: 'https://valid.trycloudflare.com',
      port: 7879,
      staticDir: 'public/webapp',
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
    };

    const ctx = makeCtx(GROUP_CHAT_ID, 'supergroup');
    await handleWebApp(ctx, { config, adapter });

    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(msg).toContain('DM-only');
    expect(adapter.sendWebAppButton).not.toHaveBeenCalled();
  });
});
