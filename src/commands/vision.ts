/**
 * /vision command handler.
 *
 * /vision           — show current state for this chat (default: ON)
 * /vision on        — enable photo descriptions in this chat
 * /vision off       — disable; photos sent here will be ignored
 *
 * In-memory per-chat toggle; resets on process restart.
 */

import type { Context } from 'grammy';
import { isVisionEnabled, setVisionEnabled } from '../vision/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.vision' });

export async function handleVision(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const text = ctx.message?.text ?? '';
  const arg = text.trim().split(/\s+/)[1]?.toLowerCase();

  if (!arg) {
    const state = isVisionEnabled(chatId) ? 'ON' : 'OFF';
    await ctx.reply(
      `Vision (photo descriptions): ${state}\n\nSend /vision on or /vision off to change.`,
    );
    return;
  }

  if (arg === 'on' || arg === 'enable' || arg === 'true') {
    setVisionEnabled(chatId, true);
    await ctx.reply('Vision enabled. Send a photo and Jarvis will describe it.');
    log.info({ chatId }, '/vision on');
    return;
  }

  if (arg === 'off' || arg === 'disable' || arg === 'false') {
    setVisionEnabled(chatId, false);
    await ctx.reply('Vision disabled. Photos will be ignored in this chat.');
    log.info({ chatId }, '/vision off');
    return;
  }

  await ctx.reply('Usage: /vision [on|off]');
}
