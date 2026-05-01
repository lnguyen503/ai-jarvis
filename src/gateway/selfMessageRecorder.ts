/**
 * selfMessageRecorder.ts — Wraps a MessagingAdapter so every successful outbound
 * send records the (chatId, messageId) into the bot_self_messages SQLite table.
 *
 * v1.21.0 ADR 021 R2 BLOCKING + Cross-review I1 + Anti-Slop F-A1:
 *   The BotSelfMessagesRepo primitive (memory/botSelfMessages.ts) was shipped in
 *   commit 9 with zero production callers — recordOutgoing existed but was never
 *   called. This wrapper closes that gap by intercepting every adapter send.
 *
 * Recorded methods (anything that returns a messageId for a NEW outbound message):
 *   - sendMessage
 *   - sendDocument
 *   - sendPhoto
 *   - sendVoice
 *   - sendWebAppButton
 *
 * NOT recorded:
 *   - editMessageText / editMessageReplyMarkup — these mutate an existing message
 *     that was already recorded on send. Telegram's update broadcast has the
 *     ORIGINAL messageId, so re-recording on edit is unnecessary (and would
 *     refresh the sent_at timestamp incorrectly).
 *   - sendChatAction — fire-and-forget cosmetic, no messageId.
 *
 * Failure mode: recordOutgoing throws are caught and logged. A failed self-message
 * record must NEVER prevent the actual send from succeeding for the user — the
 * fallback is "echo gets processed once, agent rejects/no-ops." That's worse than
 * a successful record but acceptable degradation.
 */

import type pino from 'pino';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { BotSelfMessagesRepo } from '../memory/botSelfMessages.js';

interface WrapDeps {
  base: MessagingAdapter;
  repo: BotSelfMessagesRepo;
  logger: pino.Logger;
}

/**
 * Wrap a MessagingAdapter so every successful send records the messageId.
 * The returned adapter is type-compatible with the input and can drop into
 * any caller that takes a MessagingAdapter.
 */
export function wrapAdapterWithSelfMessageRecording(deps: WrapDeps): MessagingAdapter {
  const { base, repo, logger } = deps;

  const record = (chatId: number, messageId: number, kind: string): void => {
    try {
      repo.recordOutgoing(chatId, messageId, new Date().toISOString());
    } catch (err) {
      logger.warn(
        {
          chatId,
          messageId,
          kind,
          err: err instanceof Error ? err.message : String(err),
        },
        'self-message recordOutgoing failed — echo may not be dropped',
      );
    }
  };

  return {
    async sendMessage(chatId, text, opts) {
      const result = await base.sendMessage(chatId, text, opts);
      record(chatId, result.messageId, 'sendMessage');
      return result;
    },

    async sendDocument(chatId, path, opts) {
      const result = await base.sendDocument(chatId, path, opts);
      record(chatId, result.messageId, 'sendDocument');
      return result;
    },

    async sendPhoto(chatId, path, opts) {
      const result = await base.sendPhoto(chatId, path, opts);
      record(chatId, result.messageId, 'sendPhoto');
      return result;
    },

    async sendVoice(chatId, path, opts) {
      const result = await base.sendVoice(chatId, path, opts);
      record(chatId, result.messageId, 'sendVoice');
      return result;
    },

    async sendWebAppButton(chatId, text, buttonLabel, url) {
      const result = await base.sendWebAppButton(chatId, text, buttonLabel, url);
      record(chatId, result.messageId, 'sendWebAppButton');
      return result;
    },

    // Pass-through methods (do not produce a new messageId):
    async editMessageText(chatId, messageId, text, opts) {
      return base.editMessageText(chatId, messageId, text, opts);
    },
    async editMessageReplyMarkup(chatId, messageId, buttons) {
      return base.editMessageReplyMarkup(chatId, messageId, buttons);
    },
    async sendChatAction(chatId, action) {
      return base.sendChatAction(chatId, action);
    },
    resolveDmChatId(userId) {
      return base.resolveDmChatId(userId);
    },
  };
}
