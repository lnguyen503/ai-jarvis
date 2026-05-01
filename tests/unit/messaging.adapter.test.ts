/**
 * Tests for MessagingAdapter.sendWebAppButton — Telegram implementation.
 *
 * v1.13.0: validates HTTPS enforcement and grammY InlineKeyboard call shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Api } from 'grammy';
import { createTelegramAdapter } from '../../src/messaging/telegram.js';

// Build a minimal mock of the grammY Api object.
function makeMockApi() {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
  return {
    sendMessage,
    sendDocument: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendVoice: vi.fn().mockResolvedValue({ message_id: 3 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as unknown as Api;
}

describe('MessagingAdapter.sendWebAppButton (Telegram impl)', () => {
  let mockApi: ReturnType<typeof makeMockApi>;
  let adapter: ReturnType<typeof createTelegramAdapter>;

  beforeEach(() => {
    mockApi = makeMockApi();
    adapter = createTelegramAdapter(mockApi);
  });

  it('throws a typed error with code WEBAPP_HTTP_URL_REJECTED for http:// URLs', async () => {
    const chatId = 12345;
    const err = await adapter
      .sendWebAppButton(chatId, 'hello', 'Open', 'http://example.com')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('WEBAPP_HTTP_URL_REJECTED');
    // bot.api.sendMessage must NOT have been called
    expect(mockApi.sendMessage).not.toHaveBeenCalled();
  });

  it('throws for http:// URL even with extra path segments', async () => {
    const err = await adapter
      .sendWebAppButton(100, 'msg', 'btn', 'http://deep.example.com/webapp?foo=bar')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('WEBAPP_HTTP_URL_REJECTED');
  });

  it('accepts https:// URL and calls bot.api.sendMessage with web_app keyboard shape', async () => {
    const chatId = 55555;
    const url = 'https://abc123.trycloudflare.com';
    const result = await adapter.sendWebAppButton(chatId, 'Open Jarvis Web App', '🚀 Open', url);

    expect(result).toEqual({ messageId: 99 });
    expect(mockApi.sendMessage).toHaveBeenCalledOnce();

    const [calledChatId, calledText, calledOpts] = (mockApi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledChatId).toBe(chatId);
    expect(calledText).toBe('Open Jarvis Web App');
    expect(calledOpts?.parse_mode).toBe('HTML');

    // reply_markup must be a grammY InlineKeyboard with a web_app button
    const markup = calledOpts?.reply_markup;
    expect(markup).toBeDefined();
    // grammY InlineKeyboard exposes inline_keyboard array
    const rows: unknown[][] = markup?.inline_keyboard;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(Array.isArray(row)).toBe(true);
    expect(row?.length).toBe(1);
    const btn = row?.[0] as Record<string, unknown>;
    expect(btn?.['text']).toBe('🚀 Open');
    expect((btn?.['web_app'] as { url?: string })?.url).toBe(url);
  });

  it('accepts https:// URL with subdomain and path', async () => {
    const url = 'https://subdomain.example.com/webapp/path?q=1';
    await expect(
      adapter.sendWebAppButton(99, 'text', 'label', url),
    ).resolves.toEqual({ messageId: 99 });
    expect(mockApi.sendMessage).toHaveBeenCalledOnce();
  });
});
