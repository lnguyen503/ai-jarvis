/**
 * Mock TelegramAdapter for use in tests.
 *
 * Returns vi.fn()-backed implementations so tests can spy on calls,
 * assert arguments, and simulate errors by replacing mockResolvedValue.
 */

import { vi } from 'vitest';
import type { TelegramAdapter } from '../../src/gateway/telegramAdapter.js';

export interface MockTelegramAdapter extends TelegramAdapter {
  sendDocument: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['sendDocument']>, Promise<{ messageId: number }>>>;
  sendPhoto: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['sendPhoto']>, Promise<{ messageId: number }>>>;
  sendVoice: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['sendVoice']>, Promise<{ messageId: number }>>>;
  sendMessage: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['sendMessage']>, Promise<{ messageId: number }>>>;
  editMessageText: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['editMessageText']>, Promise<void>>>;
  editMessageReplyMarkup: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['editMessageReplyMarkup']>, Promise<void>>>;
  sendChatAction: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['sendChatAction']>, Promise<void>>>;
  resolveDmChatId: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['resolveDmChatId']>, number | null>>;
  sendWebAppButton: ReturnType<typeof vi.fn<Parameters<TelegramAdapter['sendWebAppButton']>, Promise<{ messageId: number }>>>;
}

/**
 * Build a fresh MockTelegramAdapter.
 * All methods resolve successfully by default (messageIds: 42/43/44/45).
 * Override with `.mockRejectedValueOnce(...)` or `.mockResolvedValueOnce(...)` in tests.
 */
export function makeMockTelegramAdapter(): MockTelegramAdapter {
  const sendDocument = vi.fn<Parameters<TelegramAdapter['sendDocument']>, Promise<{ messageId: number }>>();
  sendDocument.mockResolvedValue({ messageId: 42 });

  const sendPhoto = vi.fn<Parameters<TelegramAdapter['sendPhoto']>, Promise<{ messageId: number }>>();
  sendPhoto.mockResolvedValue({ messageId: 43 });

  const sendVoice = vi.fn<Parameters<TelegramAdapter['sendVoice']>, Promise<{ messageId: number }>>();
  sendVoice.mockResolvedValue({ messageId: 44 });

  const sendMessage = vi.fn<Parameters<TelegramAdapter['sendMessage']>, Promise<{ messageId: number }>>();
  sendMessage.mockResolvedValue({ messageId: 45 });

  const editMessageText = vi.fn<Parameters<TelegramAdapter['editMessageText']>, Promise<void>>();
  editMessageText.mockResolvedValue();

  const editMessageReplyMarkup = vi.fn<Parameters<TelegramAdapter['editMessageReplyMarkup']>, Promise<void>>();
  editMessageReplyMarkup.mockResolvedValue();

  const sendChatAction = vi.fn<Parameters<TelegramAdapter['sendChatAction']>, Promise<void>>();
  sendChatAction.mockResolvedValue();

  const resolveDmChatId = vi.fn<Parameters<TelegramAdapter['resolveDmChatId']>, number | null>();
  resolveDmChatId.mockReturnValue(null);

  const sendWebAppButton = vi.fn<Parameters<TelegramAdapter['sendWebAppButton']>, Promise<{ messageId: number }>>();
  sendWebAppButton.mockResolvedValue({ messageId: 46 });

  return { sendDocument, sendPhoto, sendVoice, sendMessage, editMessageText, editMessageReplyMarkup, sendChatAction, resolveDmChatId, sendWebAppButton };
}
