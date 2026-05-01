/**
 * /jarvis_intent command handler (v1.7.13).
 *
 * Per-chat toggle for the LLM intent classifier — the fallback path that
 * activates Jarvis on group messages that don't contain "jarvis" and aren't
 * replies to the bot.
 *
 *   /jarvis_intent         — show current state for this chat
 *   /jarvis_intent on      — enable (default state)
 *   /jarvis_intent off     — disable: only keyword / reply / follow-up activate
 *
 * Also disables the "were you asking me?" confirmation prompt while off,
 * since that prompt is driven by the same classifier path.
 *
 * In-memory per-chat; resets on process restart (same as /voice, /vision,
 * /calendar, /debate — a single prefs migration is tracked on TODO).
 *
 * When config.groups.intentDetection.enabled is GLOBALLY false, the
 * per-chat toggle is effectively moot — the classifier never runs. The
 * command still works as a no-op so the state is saved for whenever the
 * global flag is flipped on.
 */

import type { Context } from 'grammy';
import {
  isIntentDetectionEnabledForChat,
  setIntentDetectionForChat,
} from '../gateway/groupState.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.jarvisIntent' });

export async function handleJarvisIntent(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const text = ctx.message?.text ?? '';
  const arg = text.trim().split(/\s+/)[1]?.toLowerCase();

  if (!arg) {
    const state = isIntentDetectionEnabledForChat(chatId) ? 'ON' : 'OFF';
    await ctx.reply(
      `Intent detection: ${state}\n\n` +
        `When ON, Jarvis tries to understand when he's being addressed even ` +
        `without the word "jarvis" in the message, and asks to confirm if unsure.\n\n` +
        `Send /jarvis_intent on or /jarvis_intent off to change.`,
    );
    return;
  }

  if (arg === 'on' || arg === 'enable' || arg === 'true') {
    setIntentDetectionForChat(chatId, true);
    await ctx.reply('Intent detection enabled for this chat.');
    log.info({ chatId }, '/jarvis_intent on');
    return;
  }

  if (arg === 'off' || arg === 'disable' || arg === 'false') {
    setIntentDetectionForChat(chatId, false);
    await ctx.reply(
      'Intent detection disabled for this chat. ' +
        'Now I\'ll only reply when you mention me by name or reply to my message.',
    );
    log.info({ chatId }, '/jarvis_intent off');
    return;
  }

  await ctx.reply('Usage: /jarvis_intent [on|off]');
}
