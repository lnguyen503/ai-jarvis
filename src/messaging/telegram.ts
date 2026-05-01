/**
 * Telegram implementation of MessagingAdapter — wraps grammY's bot.api.
 * Nothing elsewhere in the codebase should import grammY types directly;
 * they all go through MessagingAdapter.
 *
 * Moved here from src/gateway/telegramAdapter.ts in v1.8.1 so the canonical
 * adapter interface + platform implementations sit together under
 * src/messaging/. The old path is kept as a thin re-export shim for one
 * release to avoid breaking external imports.
 */

import { InputFile, InlineKeyboard as GrammyInlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import type { MessagingAdapter, InlineKeyboard } from './adapter.js';

/** Convert our platform-neutral InlineKeyboard to Telegram's inline_keyboard. */
function toTelegramKeyboard(buttons: InlineKeyboard) {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => ({ text: b.label, callback_data: b.data })),
    ),
  };
}

// grammY v1.x: InputFile constructor accepts a local file path string
// directly. There is no static fromLocalFile — pass the path to `new InputFile(path)`.

/**
 * Build a live MessagingAdapter backed by the Telegram Bot API.
 * Called once at boot inside initGateway.
 */
export function createTelegramAdapter(api: Api): MessagingAdapter {
  return {
    async sendDocument(chatId, filePath, opts = {}): Promise<{ messageId: number }> {
      const result = await api.sendDocument(chatId, new InputFile(filePath), {
        caption: opts.caption,
        disable_content_type_detection: opts.disableContentTypeDetection ?? false,
      });
      return { messageId: result.message_id };
    },

    async sendPhoto(chatId, filePath, opts = {}): Promise<{ messageId: number }> {
      const result = await api.sendPhoto(chatId, new InputFile(filePath), {
        caption: opts.caption,
      });
      return { messageId: result.message_id };
    },

    async sendVoice(chatId, filePath, opts = {}): Promise<{ messageId: number }> {
      const result = await api.sendVoice(chatId, new InputFile(filePath), {
        caption: opts.caption,
      });
      return { messageId: result.message_id };
    },

    async sendMessage(chatId, text, opts = {}): Promise<{ messageId: number }> {
      const result = await api.sendMessage(chatId, text, {
        parse_mode: opts.parseMode,
        ...(opts.buttons ? { reply_markup: toTelegramKeyboard(opts.buttons) } : {}),
      });
      return { messageId: result.message_id };
    },

    async editMessageText(chatId, messageId, text, opts = {}): Promise<void> {
      await api.editMessageText(chatId, messageId, text, {
        parse_mode: opts.parseMode,
        ...(opts.buttons ? { reply_markup: toTelegramKeyboard(opts.buttons) } : {}),
      });
    },

    async sendChatAction(chatId, action): Promise<void> {
      try {
        await api.sendChatAction(chatId, action);
      } catch {
        // Cosmetic only — never let a failed chat action kill a turn.
      }
    },

    /**
     * On Telegram, DM chatId === userId (Telegram implementation detail).
     * v1.9.0 / CP1 R10 — future Slack/WhatsApp adapters look up their own DM channel.
     */
    resolveDmChatId(userId: number): number | null {
      return userId;
    },

    /**
     * v1.12.0 — replace only the inline keyboard of a previously-sent message.
     * Pass `undefined` to clear the keyboard entirely.
     */
    async editMessageReplyMarkup(chatId, messageId, buttons): Promise<void> {
      await api.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: buttons
          ? {
              inline_keyboard: buttons.map((row) =>
                row.map((b) => ({ text: b.label, callback_data: b.data })),
              ),
            }
          : undefined,
      });
    },

    /**
     * v1.13.0 — Send a message with a single inline button that opens a
     * Telegram Web App (Mini App). Validates that the URL is HTTPS before
     * sending — Telegram silently rejects http:// in web_app buttons, so we
     * fail fast with a typed error instead of a confusing silent failure.
     */
    async sendWebAppButton(chatId, text, buttonLabel, url): Promise<{ messageId: number }> {
      if (!url.startsWith('https://')) {
        throw Object.assign(
          new Error(`sendWebAppButton requires HTTPS url, got: "${url}"`),
          { code: 'WEBAPP_HTTP_URL_REJECTED' },
        );
      }
      const keyboard = new GrammyInlineKeyboard().webApp(buttonLabel, url);
      const result = await api.sendMessage(chatId, text, {
        reply_markup: keyboard,
        parse_mode: 'HTML',
      });
      return { messageId: result.message_id };
    },
  };
}
